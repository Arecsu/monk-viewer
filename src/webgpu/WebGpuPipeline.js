import * as GPU from 'three/webgpu';
import * as T from 'three/tsl';
import { WebGpuGeometry } from './Geometry.js';
import { WebGpuTransparency } from './Transparency.js';
import { WebGpuTemporalAA } from './TemporalAA.js';
import { WebGpuMotionBlur } from './MotionBlur.js';
import { WebGpuPostColor } from './PostColor.js';
import { FullscreenPass } from './Common.js';

// The reference viewer's grading preset (renderer.js).
const MODERN_TAA = {
  backgroundFastPath: true, blend: 0.15, neighbourhood: 9, clipTowardsCurrent: true,
  depthRejection: true, motionRejection: true, thinFeatureLocks: true, lockFrames: 4,
  lockMaxSpeed: 12, edgeAdaptiveBlend: true, sampleConfidence: true,
};

/**
 * Native render pipeline: encoded opaque MSAA, decode + glass on the exported depth sample, reactive mask, TAA,
 * motion blur, bloom, GT7/Reinhard/dithering, optional SMAA, one sRGB presentation.
 *
 * Resources are created here or owned by their component; downstream components borrow textures and never dispose
 * them. The pipeline is the single place that reads and restores renderer state.
 */
export class WebGpuPipeline {
  constructor(manager) {
    const renderer = manager.renderer;
    const { scene, camera } = manager;
    this.manager = manager;
    this.renderer = renderer;
    this.width = 1;
    this.height = 1;
    this.pixelRatio = renderer.getPixelRatio();
    // Temporal upscaling: the geometry and glass render at this fraction of the output, TAA reconstructs the output
    // from them. 1 renders at the output resolution.
    this._renderScale = 1;
    this.disposed = false;
    this.frame = 0;
    this.latest = null;
    this.finalTarget = null;
    this.owned = [];
    this.lastSignature = '';
    this.prepared = false;
    // Validation needs the presented pixels as a texture. The viewer keeps this false so the tone pass writes
    // straight to the canvas and no extra full-resolution pass or target is allocated.
    this.captureFinal = false;

    const own = (component) => { this.owned.push(component); return component; };
    try {
      const exposure = renderer.toneMappingExposure;
      // Specular AA / grazing clamp live on the geometry stage natively. The manager and the AA lab drive the
      // reference objects, so expose the native settings objects under the same names.
      this.geometry = own(new WebGpuGeometry(renderer, {
        scene, camera,
        samples: manager.msaaSamples,
        exposure,
        encoding: 'rgb',
        specularAA: { enabled: manager.specularAA?.enabled ?? true,
          variance: manager.specularAA?.variance ?? 0.15, threshold: manager.specularAA?.threshold ?? 0.2 },
        grazingClamp: { enabled: manager.grazingClamp?.enabled ?? false,
          angle: manager.grazingClamp?.angle ?? 0.5, limit: manager.grazingClamp?.limit ?? 0.03 },
      }));
      this.transparency = own(new WebGpuTransparency(renderer, { scene, camera, exposure, encoding: 'rgb', reactiveMask: true }));
      this.taa = own(new WebGpuTemporalAA(renderer, { scene, camera, exposure, ...MODERN_TAA }));
      this.motionBlur = own(new WebGpuMotionBlur(renderer, { shutter: 0.8 }));
      this.motionBlur.enabled = manager.motionBlur !== false;
      this.postColor = own(new WebGpuPostColor(renderer, { smaa: manager.smaa === true }));
      this.taa.velocityBuffer = manager.useVelocityBuffer === false ? null : this.geometry;
      this.taa.reactiveMask = this.transparency.reactiveMaskEnabled ? this.transparency.reactiveMask : null;

      // The display target is stored top-left, so screenUV samples it 1:1. The explicit uv keeps TextureNode from
      // adding an automatic texture matrix.
      this.presentationSource = T.texture(new GPU.Texture(), T.screenUV);
      this.presentation = own(new FullscreenPass(renderer, T.vec4(this.presentationSource.rgb, 1), { name: 'NativePresentation' }));

      // Compatibility surface used by renderer.js, the auto-tuner and aa-lab.
      manager.geometryPass = this.geometry;
      manager.resolvePass = this.transparency;
      manager.taa = this.taa;
      manager.motionBlurPass = this.motionBlur;
      manager.gt7ToneMapping = this.postColor.gt7ToneMapping;
      manager.reinhardToneMapping = this.postColor.reinhardToneMapping;
      manager.smaaPass = this.postColor.smaaPass;
      manager.velocityBuffer = manager.useVelocityBuffer === false ? manager.velocityBuffer : this.geometry;
      manager.specularAA = this.geometry.specularAA;
      manager.grazingClamp = this.geometry.grazingClamp;
      // The lab toggles `pipeline.passes.find(p => p.effects).effects[0].backgroundFastPath`.
      this.passes = [
        this.geometry, this.transparency, this.taa, this.motionBlur,
        { effects: [this.postColor.bloom, this.postColor.gt7ToneMapping, this.postColor.reinhardToneMapping, this.postColor.dithering] },
        this.postColor, this.presentation,
      ];
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  /**
   * Awaits optional asynchronously loaded components (SMAA lookups) so the first presented frame is final, then
   * proves the optional SMAA modules actually compile on this device. A broken SMAA shader must degrade to
   * "SMAA off, reported" instead of failing the whole native backend.
   */
  async compile() {
    const ready = await Promise.race([this.postColor.ready, new Promise((resolve) => setTimeout(() => resolve('timeout'), 15000))]);
    if (ready === 'timeout') console.warn('Native pipeline: SMAA lookup did not load within 15s; rendering without SMAA until it does');
    await this.validateOptionalStages();
    return this;
  }

  async validateOptionalStages() {
    const smaa = this.postColor.smaaPass;
    if (!smaa || !smaa.enabled) return;
    const device = this.renderer.backend?.device;
    const disable = (reason) => {
      smaa.enabled = false;
      smaa.error = `native SMAA disabled: ${reason}`;
      console.warn(`Native pipeline: ${smaa.error}`);
    };
    if (!device?.pushErrorScope) return;
    device.pushErrorScope('validation');
    let thrown = null;
    try {
      // One real draw of both SMAA stages into their own targets compiles edge detection, weights and blend.
      // A tiny throw-away depth texture satisfies depth predication; this probe only has to compile, not look right.
      const probeDepth = new GPU.DepthTexture(4, 4, GPU.FloatType);
      try {
        smaa.render(this.postColor.displayTarget.texture, this.postColor.outputTarget, { depth: probeDepth, camera: this.manager.camera });
      } finally {
        probeDepth.dispose();
      }
    } catch (error) {
      thrown = error;
    }
    const scopeError = await device.popErrorScope();
    await device.queue.onSubmittedWorkDone();
    if (thrown) disable(thrown.message);
    else if (scopeError) disable(scopeError.message.split('\n')[0]);
  }

  /** Converts the model's materials in place; call after the GLB loads. */
  prepare(model) {
    this.geometry.prepare(model);
    this.taa.trackedObject = model;
    this.prepared = true;
  }

  setSize(width, height) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.resize();
  }

  setPixelRatio(ratio) {
    if (this.pixelRatio === ratio) return;
    this.pixelRatio = ratio;
    this.resize();
  }

  get pixelWidth() { return Math.max(1, Math.floor(this.width * this.pixelRatio)); }
  get pixelHeight() { return Math.max(1, Math.floor(this.height * this.pixelRatio)); }

  /** Fraction of the output resolution the scene is rendered at, (0, 1]; below 1 TAA upscales. */
  get renderScale() { return this._renderScale; }
  set renderScale(value) {
    const scale = Math.min(Math.max(Number(value) || 1, 0.25), 1);
    if (scale === this._renderScale) return;
    this._renderScale = scale;
    this.resize();
  }

  /** Size the geometry and glass render at: the output size, scaled by {@link renderScale}. */
  get renderWidth() { return Math.max(1, Math.round(this.pixelWidth * this._renderScale)); }
  get renderHeight() { return Math.max(1, Math.round(this.pixelHeight * this._renderScale)); }

  resize() {
    const width = this.pixelWidth, height = this.pixelHeight;
    const renderWidth = this.renderWidth, renderHeight = this.renderHeight;
    this.geometry.setSize(renderWidth, renderHeight);
    this.transparency.setSize(renderWidth, renderHeight);
    this.taa.setSize(width, height, renderWidth, renderHeight);
    this.motionBlur.setSize(width, height);
    this.postColor.setSize(width, height);
    this.resetHistory();
  }

  /** Invalidates every temporal history and previous-frame motion. */
  resetHistory() {
    this.geometry.reset();
    this.taa.reset();
    this.motionBlur.reset();
    this.frame = 0;
  }

  render({ present = true } = {}) {
    if (this.disposed) throw new Error('Rendering a disposed WebGPU pipeline');
    if (!this.prepared) throw new Error('Native pipeline rendered before prepare(model)');
    const renderer = this.renderer;
    const saved = { target: renderer.getRenderTarget(), mrt: renderer.getMRT(), autoClear: renderer.autoClear };
    // Encoding/exposure/sample changes invalidate the temporal history.
    const signature = `${this.geometry.samples}/${this.transparency.encoding}/${this.transparency.exposure}/${this.taa.exposure}`;
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      this.resetHistory();
    }
    this.geometry.encoding = this.transparency.encoding;
    this.geometry.exposure = this.transparency.exposure;
    try {
      const { projection } = this.taa.beginFrame();
      const geometry = this.geometry.render({ projection });
      const glass = this.transparency.render({ color: geometry.color, depth: geometry.depth, target: geometry.target });
      const taa = this.taa.render({
        color: glass.color,
        depth: glass.depth,
        velocity: geometry.velocity,
        reactiveMask: glass.reactiveMask,
        meshesMoved: this.geometry.meshesMoved,
      });
      const blur = this.motionBlur.render({
        color: taa.color,
        state: taa.state,
        bounds: this.taa.enabled ? this.taa.backgroundBounds : null,
        hasMotion: this.taa.enabled,
      });
      const bounds = this.motionBlur.enabled ? this.motionBlur.backgroundBounds
        : this.taa.enabled ? this.taa.backgroundBounds : null;
      const final = this.postColor.render({
        color: blur.color, bounds, depth: glass.depth, camera: this.camera,
        present: present && !this.captureFinal,
      });
      this.latest = { geometry, glass, taa, blur, final };
      this.finalTarget = final.target;
      if (present && !final.presented) {
        this.presentationSource.value = final.color;
        renderer.autoClear = true;
        this.presentation.render(null);
      }
      this.geometry.finishFrame();
      ++this.frame;
      return this.latest;
    } catch (error) {
      // Never leave the temporal state pointing at a half-written frame.
      this.resetHistory();
      throw error;
    } finally {
      this.taa.endFrame();
      renderer.setMRT(saved.mrt);
      renderer.setRenderTarget(saved.target);
      renderer.autoClear = saved.autoClear;
    }
  }

  get camera() { return this.manager.camera; }

  get metadata() {
    const renderer = this.renderer;
    const target = this.geometry.target;
    const info = (texture) => {
      if (!texture) return null;
      const data = renderer.backend.get(texture);
      return { format: data.texture?.format, samples: data.msaaTexture?.sampleCount ?? data.texture?.sampleCount };
    };
    return {
      backend: renderer.backend.isWebGPUBackend ? 'webgpu' : 'INVALID-FALLBACK',
      frame: this.frame,
      size: [this.pixelWidth, this.pixelHeight],
      renderSize: [this.renderWidth, this.renderHeight],
      samples: this.geometry.samples,
      depthPolicy: 'sample-0',
      attachments: target.textures.map(info),
      depth: info(target.depthTexture),
      exportedDepth: info(this.transparency.depth),
      taaOutput: info(this.postColor.outputTarget.texture),
      features: [...renderer.backend.device.features],
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const component of this.owned.splice(0).reverse()) component.dispose();
    this.latest = null;
    this.finalTarget = null;
  }
}
