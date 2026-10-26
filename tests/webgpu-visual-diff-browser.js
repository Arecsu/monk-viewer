// Supervisor-owned visual diff: renders the same deterministic pose on the WebGL reference and the native
// manager, then paints reference | native | amplified difference into one canvas in the page.
import * as GPU from 'three/webgpu';
import { unpadRows } from '../src/lab/geometry-probe-utils.js';
import { createReferenceManager } from './webgpu-compare-browser.js';

const srgbEncode = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

async function captureNative(manager) {
  const renderer = manager.renderer;
  const target = manager.pipeline.postColor.outputTarget;
  const width = target.width, height = target.height;
  const padded = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
  const data = unpadRows(padded, width, height);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; ++i) {
    for (let c = 0; c < 3; ++c) {
      const value = srgbEncode(Math.max(0, GPU.DataUtils.fromHalfFloat(data[i * 4 + c])));
      rgba[i * 4 + c] = Math.round(Math.min(1, value) * 255);
    }
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

function captureWebGl(manager) {
  const renderer = manager.renderer;
  const gl = renderer.getContext();
  const canvas = renderer.domElement;
  const width = canvas.width, height = canvas.height;
  const raw = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; ++y) {
    rgba.set(raw.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
  }
  return { width, height, rgba };
}

// Ablations toggle the same effects on both backends so a difference can be attributed to one stage.
function applyAblation(referenceManager, native, ablation) {
  const refEffects = referenceManager.pipeline.passes.find((pass) => pass.effects)?.effects ?? [];
  const refBloom = refEffects[0];
  const refDither = refEffects[refEffects.length - 1];
  const refReinhard = refEffects.find((effect) => effect?.constructor?.name === 'ToneMappingEffect') ?? null;
  const refGt7 = refEffects.find((effect) => effect && effect !== refBloom && effect !== refDither && effect !== refReinhard) ?? null;
  const ref = {
    taa: referenceManager.taa, blur: referenceManager.motionBlurPass, bloom: refBloom, dither: refDither,
    gt7: refGt7, reinhard: refReinhard, geometry: referenceManager.geometryPass,
  };
  const nat = {
    taa: native.taa, blur: native.motionBlurPass, bloom: native.pipeline.postColor.bloom,
    dither: native.pipeline.postColor.dithering, gt7: native.pipeline.postColor.gt7ToneMapping,
    reinhard: native.pipeline.postColor.reinhardToneMapping, geometry: native.geometryPass,
  };
  const set = (key, value) => { if (ref[key]) ref[key].enabled = value; if (nat[key]) nat[key].enabled = value; };
  const restore = () => { for (const key of ['taa', 'blur', 'bloom', 'dither', 'gt7', 'reinhard']) { if (ref[key]) ref[key].enabled = true; if (nat[key]) nat[key].enabled = true; } if (nat.reinhard) nat.reinhard.enabled = false; if (ref.reinhard) ref.reinhard.enabled = false; };
  restore();
  if (ablation === 'geometry+tone') { set('taa', false); set('blur', false); set('bloom', false); set('dither', false); }
  else if (ablation === 'geometry+tone+dither') { set('taa', false); set('blur', false); set('bloom', false); }
  else if (ablation === 'plus-bloom') { set('taa', false); set('blur', false); }
  else if (ablation === 'plus-blur') { set('taa', false); }
  else if (ablation === 'no-gt7') { set('gt7', false); set('dither', false); set('bloom', false); set('taa', false); set('blur', false); }
  if (referenceManager.taa) referenceManager.taa.reset?.();
  if (native.taa) native.taa.reset?.();
  return restore;
}

export async function visualDiff({ resolution = [900, 600], frames = 40, amplify = 6, ablation = 'none', paint = true } = {}) {
  const native = window.mgr;
  native.pauseRendering();
  let reference;
  try {
    reference = await createReferenceManager({ width: resolution[0], height: resolution[1], pixelRatio: 1, envmapUrl: native.envmapUrl });
    const referenceManager = reference.manager;
    const restoreAblation = applyAblation(referenceManager, native, ablation);
    for (const manager of [referenceManager, native]) {
      manager.updateRendererSize(resolution[0], resolution[1], 1);
      manager.camera.aspect = resolution[0] / resolution[1];
      manager.camera.updateProjectionMatrix();
      manager.model.rotation.set(0, 0, 0);
      manager.model.updateMatrixWorld(true);
    }
    for (let frame = 0; frame < frames; ++frame) {
      referenceManager.pipeline.render();
      native.pipeline.render();
    }
    await native.renderer.backend.device.queue.onSubmittedWorkDone();
    const gl = referenceManager.renderer.getContext();
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    while (gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) await new Promise((r) => setTimeout(r, 4));
    gl.deleteSync(sync);

    const a = captureWebGl(referenceManager);
    restoreAblation();
    const b = await captureNative(native);
    const width = Math.min(a.width, b.width), height = Math.min(a.height, b.height);
    const canvas = document.createElement('canvas');
    canvas.width = width * 3; canvas.height = height;
    canvas.id = 'visual-diff';
    canvas.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#000';
    const context = canvas.getContext('2d');
    const paint = (image, offset) => {
      const data = context.createImageData(width, height);
      for (let y = 0; y < height; ++y) {
        data.data.set(image.rgba.subarray((y * image.width) * 4, (y * image.width + width) * 4), y * width * 4);
      }
      context.putImageData(data, offset, 0, 0, 0, width, height);
    };
    paint(a, 0); paint(b, width);
    const diff = context.createImageData(width, height);
    let worst = 0, sum = 0, differing = 0;
    for (let y = 0; y < height; ++y) {
      for (let x = 0; x < width; ++x) {
        const i = (y * a.width + x) * 4, j = (y * b.width + x) * 4, k = (y * width + x) * 4;
        let d = 0;
        for (let c = 0; c < 3; ++c) d = Math.max(d, Math.abs(a.rgba[i + c] - b.rgba[j + c]));
        worst = Math.max(worst, d); sum += d; if (d > 2) differing++;
        const v = Math.min(255, d * amplify);
        diff.data[k] = v; diff.data[k + 1] = v; diff.data[k + 2] = v; diff.data[k + 3] = 255;
      }
    }
    context.putImageData(diff, width * 2, 0, 0, 0, width, height);
    if (paint) document.body.appendChild(canvas);
    return { ablation, width, height, worstStep: worst, meanStep: +(sum / (width * height)).toFixed(3), differingFraction: +(differing / (width * height)).toFixed(4), referenceMean: 0, nativeMean: 0 };
  } finally {
    reference?.manager.dispose();
    native.resumeRendering();
  }
}

export function removeVisualDiff() {
  document.getElementById('visual-diff')?.remove();
}
