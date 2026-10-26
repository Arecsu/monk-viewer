import * as GPU from 'three/webgpu';
import * as T from 'three/tsl';
import { WebGpuGeometry } from './Geometry.js';
import { WebGpuTransparency } from './Transparency.js';
import { WebGpuTemporalAA } from './TemporalAA.js';
import { WebGpuMotionBlur } from './MotionBlur.js';
import { WebGpuPostColor } from './PostColor.js';
import { FullscreenPass } from './Common.js';

const MODERN_TAA = {
  backgroundFastPath: true, blend: 0.15, neighbourhood: 9, clipTowardsCurrent: true,
  depthRejection: true, motionRejection: true, thinFeatureLocks: true, lockFrames: 4,
  lockMaxSpeed: 12, edgeAdaptiveBlend: true, sampleConfidence: true,
};

/** Native resources are owned here or by their component, never by downstream consumers. */
export class WebGpuPipeline {
  constructor(manager) {
    this.manager = manager;
    this.renderer = manager.renderer;
    this.width = this.height = 1;
    this.pixelRatio = this.renderer.getPixelRatio();
    this.disposed = false;
    this.frame = 0;
    this.latest = null;
    this.finalTarget = null;
    this.owned = [];
    const own = pass => { this.owned.push(pass); return pass; };
    try {
    const { scene, camera, msaaSamples: samples, grazingClamp, specularAA } = manager;
    const exposure = this.renderer.toneMappingExposure;
    this.geometry = own(new WebGpuGeometry(this.renderer, { scene, camera, samples, exposure, grazingClamp, specularAA }));
    this.transparency = own(new WebGpuTransparency(this.renderer, { scene, camera, exposure, reactiveMask: true }));
    this.taa = own(new WebGpuTemporalAA(this.renderer, { scene, camera, exposure, ...MODERN_TAA }));
    this.taa.velocityBuffer = manager.useVelocityBuffer ? this.geometry : null;
    this.motionBlur = own(new WebGpuMotionBlur(this.renderer, { shutter: 0.8 }));
    this.motionBlur.enabled = manager.motionBlur;
    this.postColor = own(new WebGpuPostColor(this.renderer, { smaa: manager.smaa }));
    this.presentationSource = T.texture(new GPU.Texture());
    // Renderer output conversion is the single scene-linear/display-linear → sRGB boundary.
    this.presentation = own(new FullscreenPass(this.renderer, this.presentationSource, { name: 'NativePresentation' }));
    this.passes = [this.geometry, this.transparency, this.taa, this.motionBlur,
      { effects: [this.postColor.bloom, this.postColor.gt7ToneMapping, this.postColor.reinhardToneMapping, this.postColor.dithering] }];
    manager.geometryPass = this.geometry;
    manager.resolvePass = this.transparency;
    manager.velocityBuffer = this.geometry;
    manager.taa = this.taa;
    manager.motionBlurPass = this.motionBlur;
    manager.gt7ToneMapping = this.postColor.gt7ToneMapping;
    manager.reinhardToneMapping = this.postColor.reinhardToneMapping;
    manager.smaaPass = this.postColor.smaaPass;
    this.lastSignature = '';
    } catch (error) { this.dispose(); throw error; }
  }
  async compile() {
    if (this.postColor.initialize) await this.postColor.initialize();
  }
  prepare(model) {
    this.geometry.prepare(model);
    this.taa.trackedObject = model;
  }
  setSize(width, height) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.resize();
  }
  setPixelRatio(ratio) {
    if (this.pixelRatio === ratio) return;
    this.pixelRatio = ratio;
    this.resize();
  }
  resize() {
    const width = Math.max(1, Math.floor(this.width * this.pixelRatio));
    const height = Math.max(1, Math.floor(this.height * this.pixelRatio));
    for (const pass of [this.geometry, this.transparency, this.taa, this.motionBlur, this.postColor]) pass.setSize(width, height);
    this.reset();
  }
  reset() {
    this.taa.reset();
    this.geometry.reset?.();
    this.motionBlur.reset?.();
    this.frame = 0;
  }
  render({ present = true } = {}) {
    if (this.disposed) throw new Error('Rendering a disposed WebGPU pipeline');
    const renderer = this.renderer;
    const saved = { target: renderer.getRenderTarget(), mrt: renderer.getMRT(), autoClear: renderer.autoClear };
    const signature = `${this.geometry.samples}/${this.transparency.encoding}/${this.transparency.exposure}/${this.taa.exposure}`;
    if (signature !== this.lastSignature) { this.reset(); this.lastSignature = signature; }
    this.geometry.encoding = this.transparency.encoding;
    this.geometry.exposure = this.transparency.exposure;
    try {
      const frame = this.taa.beginFrame();
      const geometry = this.geometry.render(frame);
      const transparent = this.transparency.render(geometry);
      const taa = this.taa.render({ ...transparent, velocity: geometry.velocity, meshesMoved: geometry.meshesMoved });
      const blur = this.motionBlur.render({ color: taa.color, state: taa.state,
        bounds: this.taa.enabled ? this.taa.backgroundBounds : undefined, hasMotion: this.taa.enabled });
      const final = this.postColor.render({ color: blur.color,
        bounds: this.motionBlur.enabled ? this.motionBlur.backgroundBounds : this.taa.enabled ? this.taa.backgroundBounds : undefined });
      this.latest = { geometry, transparent, taa, blur, final };
      this.finalTarget = final.target;
      if (present) {
        this.presentationSource.value = final.color;
        renderer.autoClear = true;
        this.presentation.render(null);
      }
      this.geometry.finishFrame?.();
      ++this.frame;
      return this.latest;
    } catch (error) {
      this.reset();
      throw error;
    } finally {
      this.taa.endFrame();
      renderer.setMRT(saved.mrt);
      renderer.setRenderTarget(saved.target);
      renderer.autoClear = saved.autoClear;
    }
  }
  get metadata() {
    const renderer = this.renderer;
    const target = this.geometry.target;
    return {
      backend: renderer.backend.isWebGPUBackend ? 'webgpu' : 'INVALID-FALLBACK',
      frame: this.frame, width: Math.floor(this.width * this.pixelRatio), height: Math.floor(this.height * this.pixelRatio),
      samples: this.geometry.samples, depthPolicy: 'sample-0',
      attachments: target?.textures.map(texture => {
        const data = renderer.backend.get(texture);
        return { format: data.texture?.format, samples: data.msaaTexture?.sampleCount ?? data.texture?.sampleCount };
      }),
      depthSamples: target?.depthTexture ? renderer.backend.get(target.depthTexture).texture?.sampleCount : undefined,
      features: [...renderer.backend.device.features],
    };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const pass of this.owned.splice(0).reverse()) pass.dispose();
    this.latest = this.finalTarget = null;
  }
}
