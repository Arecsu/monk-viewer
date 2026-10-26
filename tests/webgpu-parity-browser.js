// Supervisor-owned parity measurement. Both backends are rendered with the same deterministic pose, then
// captured through the SAME display-linear normalisation, so no statistic mixes sRGB codes with linear light.
import * as GPU from 'three/webgpu';
import { unpadRows } from '../src/lab/geometry-probe-utils.js';
import { createReferenceManager } from './webgpu-compare-browser.js';

const sRGBEncode = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const sRGBDecode = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

function readWebGl(manager) {
  const gl = manager.renderer.getContext();
  const canvas = manager.renderer.domElement;
  const width = canvas.width, height = canvas.height;
  const codes = new Float32Array(width * height * 3);
  const raw = new Uint8Array(width * height * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  for (let y = 0; y < height; ++y) {
    const source = (height - 1 - y) * width * 4;
    for (let x = 0; x < width; ++x) {
      const target = (y * width + x) * 3;
      for (let c = 0; c < 3; ++c) codes[target + c] = raw[source + x * 4 + c] / 255;
    }
  }
  const linear = Float32Array.from(codes, sRGBDecode);
  return { width, height, codes, linear };
}

async function readNative(manager) {
  const renderer = manager.renderer;
  const target = manager.pipeline.postColor.outputTarget;
  const width = target.width, height = target.height;
  const data = unpadRows(await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height), width, height);
  const linear = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; ++i) {
    for (let c = 0; c < 3; ++c) linear[i * 3 + c] = Math.max(0, GPU.DataUtils.fromHalfFloat(data[i * 4 + c]));
  }
  const codes = Float32Array.from(linear, (v) => sRGBEncode(Math.min(1, v)));
  return { width, height, codes, linear };
}

/** Display-linear comparison with an explicit edge/flat split, in sRGB code steps. */
export function compareCaptures(reference, candidate, { edgeGradient = 3 / 255, edgeRadius = 2 } = {}) {
  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    throw new Error(`capture sizes differ: ${reference.width}x${reference.height} vs ${candidate.width}x${candidate.height}`);
  }
  const { width, height } = reference;
  const count = width * height;
  const edge = new Uint8Array(count);
  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) {
      let gradient = 0;
      const center = (y * width + x) * 3;
      for (let dy = -edgeRadius; dy <= edgeRadius; ++dy) {
        for (let dx = -edgeRadius; dx <= edgeRadius; ++dx) {
          const nx = Math.min(width - 1, Math.max(0, x + dx));
          const ny = Math.min(height - 1, Math.max(0, y + dy));
          const k = (ny * width + nx) * 3;
          for (let c = 0; c < 3; ++c) gradient = Math.max(gradient, Math.abs(reference.codes[center + c] - reference.codes[k + c]));
        }
      }
      edge[y * width + x] = gradient > edgeGradient ? 1 : 0;
    }
  }
  let flatChannels = 0, flatOutliers = 0, flatVisible = 0, flatSquares = 0, flatSum = 0;
  let edgeChannels = 0, edgeSum = 0, edgeMax = 0, edgeVisible = 0;
  let visiblePixels = 0, maxStep = 0, sum = 0, channels = 0, nonFinite = 0;
  for (let i = 0; i < count; ++i) {
    let pixelDifference = 0;
    for (let c = 0; c < 3; ++c) {
      const a = reference.codes[i * 3 + c], b = candidate.codes[i * 3 + c];
      const difference = Math.abs(a - b);
      if (!Number.isFinite(difference)) { nonFinite++; continue; }
      channels++; sum += difference; maxStep = Math.max(maxStep, difference); pixelDifference = Math.max(pixelDifference, difference);
      if (edge[i]) { edgeChannels++; edgeSum += difference; edgeMax = Math.max(edgeMax, difference); if (difference > 2 / 255) edgeVisible++; }
      else { flatChannels++; flatSum += difference; flatSquares += difference * difference; if (difference > 4 / 255) flatOutliers++; if (difference > 2 / 255) flatVisible++; }
    }
    if (pixelDifference > 2 / 255) visiblePixels++;
  }
  return {
    width, height,
    meanStep: sum / channels,
    maxStep,
    visiblePixelFraction: visiblePixels / count,
    flat: {
      channels: flatChannels,
      outlierFraction: flatOutliers / flatChannels,
      visibleFraction: flatVisible / flatChannels,
      meanStep: flatSum / flatChannels,
      rmseStep: Math.sqrt(flatSquares / flatChannels),
    },
    edge: { channels: edgeChannels, meanStep: edgeSum / edgeChannels, maxStep: edgeMax, visibleFraction: edgeVisible / edgeChannels },
    nonFinite,
  };
}

function coverageOf(capture, threshold = 0.002) {
  const count = capture.width * capture.height;
  let lit = 0;
  for (let i = 0; i < count; ++i) {
    const l = 0.2126 * capture.linear[i * 3] + 0.7152 * capture.linear[i * 3 + 1] + 0.0722 * capture.linear[i * 3 + 2];
    if (l > threshold) lit++;
  }
  return lit / count;
}

const ABLATIONS = ['geometry+tone', 'geometry+tone+dither', 'plus-bloom', 'plus-blur', 'none'];

function referenceEffects(referenceManager) {
  const effects = referenceManager.pipeline.passes.find((pass) => pass.effects)?.effects ?? [];
  const byName = (name) => effects.find((effect) => effect?.constructor?.name === name) ?? null;
  return {
    bloom: byName('BoundedBloomEffect') ?? effects[0] ?? null,
    gt7: byName('GT7ToneMappingEffect') ?? effects[1] ?? null,
    reinhard: byName('ToneMappingEffect') ?? null,
    dither: byName('DitheringEffect') ?? effects[effects.length - 1] ?? null,
  };
}

function toggle(referenceManager, native, ablation) {
  const reference = referenceEffects(referenceManager);
  const ref = { taa: referenceManager.taa, blur: referenceManager.motionBlurPass, ...reference };
  const nat = {
    taa: native.taa, blur: native.motionBlurPass, bloom: native.pipeline.postColor.bloom,
    dither: native.pipeline.postColor.dithering, gt7: native.pipeline.postColor.gt7ToneMapping,
    reinhard: native.pipeline.postColor.reinhardToneMapping,
  };
  const set = (key, value) => { if (ref[key]) ref[key].enabled = value; if (nat[key]) nat[key].enabled = value; };
  const restore = () => {
    for (const key of ['taa', 'blur', 'bloom', 'dither', 'gt7']) { if (ref[key]) ref[key].enabled = true; if (nat[key]) nat[key].enabled = true; }
    if (ref.reinhard) ref.reinhard.enabled = false;
    if (nat.reinhard) nat.reinhard.enabled = false;
  };
  restore();
  if (ablation === 'geometry+tone') { set('taa', false); set('blur', false); set('bloom', false); set('dither', false); }
  else if (ablation === 'geometry+tone+dither') { set('taa', false); set('blur', false); set('bloom', false); }
  else if (ablation === 'taa-only') { set('blur', false); set('bloom', false); set('dither', false); }
  else if (ablation === 'taa+dither') { set('blur', false); set('bloom', false); }
  else if (ablation === 'taa+bloom') { set('blur', false); set('dither', false); }
  else if (ablation === 'plus-bloom') { set('taa', false); set('blur', false); }
  else if (ablation === 'plus-blur') { set('taa', false); }
  referenceManager.taa.reset?.();
  native.taa.reset?.();
  return restore;
}

const waitFrames = (count) => new Promise((resolve) => {
  let remaining = count;
  const tick = () => (--remaining <= 0 ? resolve() : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
});

export async function measureParity({ resolution = [900, 600], frames = 48, ablations = ABLATIONS, poses = ['still'] } = {}) {
  const native = window.mgr;
  native.pauseRendering();
  let reference;
  const results = [];
  try {
    reference = await createReferenceManager({ width: resolution[0], height: resolution[1], pixelRatio: 1, envmapUrl: native.envmapUrl });
    const referenceManager = reference.manager;
    for (const manager of [referenceManager, native]) {
      manager.updateRendererSize(resolution[0], resolution[1], 1);
      manager.camera.aspect = resolution[0] / resolution[1];
      manager.camera.updateProjectionMatrix();
      manager.model.rotation.set(0, 0, 0);
      manager.model.updateMatrixWorld(true);
      manager.taa.reset?.();
    }
    await waitFrames(2);
    for (const pose of poses) {
      for (const ablation of ablations) {
        const restore = toggle(referenceManager, native, ablation);
        for (let frame = 0; frame < frames; ++frame) {
          if (pose === 'rotation') {
            const angle = (frame / frames) * Math.PI * 0.5;
            for (const manager of [referenceManager, native]) {
              manager.model.rotation.set(0, angle, 0);
              manager.model.updateMatrixWorld(true);
            }
          }
          referenceManager.pipeline.render();
          native.pipeline.render();
        }
        await native.renderer.backend.device.queue.onSubmittedWorkDone();
        const gl = referenceManager.renderer.getContext();
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        while (gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) await new Promise((r) => setTimeout(r, 4));
        gl.deleteSync(sync);
        const a = readWebGl(referenceManager);
        const b = await readNative(native);
        const comparison = compareCaptures(a, b);
        const refCoverage = coverageOf(a), nativeCoverage = coverageOf(b);
        results.push({
          pose, ablation, comparison,
          referenceCoverage: +refCoverage.toFixed(4), nativeCoverage: +nativeCoverage.toFixed(4),
          coverageDelta: +(nativeCoverage - refCoverage).toFixed(4),
          referenceLit: coverageOf(a, 0.02), nativeLit: coverageOf(b, 0.02),
        });
        restore();
        referenceManager.taa.reset?.();
        native.taa.reset?.();
      }
    }
    return { resolution, frames, results };
  } finally {
    reference?.manager.dispose();
    native.resumeRendering();
  }
}

export async function saveParityImages(name = 'parity') {
  const native = window.mgr;
  native.pauseRendering();
  let reference;
  try {
    reference = await createReferenceManager({ width: 900, height: 600, pixelRatio: 1, envmapUrl: native.envmapUrl });
    const referenceManager = reference.manager;
    for (const manager of [referenceManager, native]) {
      manager.updateRendererSize(900, 600, 1);
      manager.camera.aspect = 900 / 600;
      manager.camera.updateProjectionMatrix();
      manager.taa.reset?.();
    }
    for (let frame = 0; frame < 48; ++frame) { referenceManager.pipeline.render(); native.pipeline.render(); }
    await native.renderer.backend.device.queue.onSubmittedWorkDone();
    const a = readWebGl(referenceManager);
    const b = await readNative(native);
    const canvas = document.createElement('canvas');
    canvas.width = a.width * 3; canvas.height = a.height;
    canvas.id = 'parity-images';
    canvas.style.cssText = 'position:fixed;left:0;top:0;z-index:99999';
    const context = canvas.getContext('2d');
    const paint = (capture, offset) => {
      const image = context.createImageData(a.width, a.height);
      for (let i = 0; i < a.width * a.height; ++i) {
        for (let c = 0; c < 3; ++c) image.data[i * 4 + c] = Math.round(Math.min(1, Math.max(0, capture.codes[i * 3 + c])) * 255);
        image.data[i * 4 + 3] = 255;
      }
      context.putImageData(image, offset, 0, 0, 0, a.width, a.height);
    };
    paint(a, 0); paint(b, a.width);
    const diff = context.createImageData(a.width, a.height);
    for (let i = 0; i < a.width * a.height; ++i) {
      let d = 0;
      for (let c = 0; c < 3; ++c) d = Math.max(d, Math.abs(a.codes[i * 3 + c] - b.codes[i * 3 + c]) * 255);
      const v = Math.min(255, d * 8);
      diff.data[i * 4] = v; diff.data[i * 4 + 1] = v; diff.data[i * 4 + 2] = v; diff.data[i * 4 + 3] = 255;
    }
    context.putImageData(diff, a.width * 2, 0, 0, 0, a.width, a.height);
    document.getElementById('parity-images')?.remove();
    document.body.appendChild(canvas);
    return { painted: true, name };
  } finally {
    reference?.manager.dispose();
    native.resumeRendering();
  }
}

/** TAA accumulation sweep: compares after N still frames to separate first-frame parity from history drift. */
export async function sweepTaa({ resolution = [900, 600], checkpoints = [1, 2, 4, 8, 16, 32, 64] } = {}) {
  const native = window.mgr;
  native.pauseRendering();
  let reference;
  const rows = [];
  try {
    reference = await createReferenceManager({ width: resolution[0], height: resolution[1], pixelRatio: 1, envmapUrl: native.envmapUrl });
    const referenceManager = reference.manager;
    for (const manager of [referenceManager, native]) {
      manager.updateRendererSize(resolution[0], resolution[1], 1);
      manager.camera.aspect = resolution[0] / resolution[1];
      manager.camera.updateProjectionMatrix();
      manager.model.rotation.set(0, 0, 0);
      manager.model.updateMatrixWorld(true);
    }
    // Isolate temporal accumulation: both backends keep GT7 and disable bloom/dither/blur identically.
    const restoreAblation = toggle(referenceManager, native, 'taa-only');
    const restore = () => { restoreAblation(); };
    referenceManager.taa.reset();
    native.taa.reset();
    let frame = 0;
    for (const checkpoint of checkpoints) {
      while (frame < checkpoint) { referenceManager.pipeline.render(); native.pipeline.render(); frame++; }
      await native.renderer.backend.device.queue.onSubmittedWorkDone();
      const gl = referenceManager.renderer.getContext();
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      while (gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) await new Promise((r) => setTimeout(r, 4));
      gl.deleteSync(sync);
      const comparison = compareCaptures(readWebGl(referenceManager), await readNative(native));
      rows.push({ frames: checkpoint, meanStep: +comparison.meanStep.toFixed(4), maxStep: +(comparison.maxStep * 255).toFixed(1),
        flatOutliers: +comparison.flat.outlierFraction.toFixed(4), flatRmseSteps: +(comparison.flat.rmseStep * 255).toFixed(2),
        visible: +comparison.visiblePixelFraction.toFixed(4) });
    }
    restore();
    return rows;
  } finally {
    reference?.manager.dispose();
    native.resumeRendering();
  }
}

/** Reads the native TAA state texture (depth, lock, motion.xy) to check still-frame motion is ~0. */
export async function inspectTaaState({ samples = 4000 } = {}) {
  const native = window.mgr;
  const was = native.pauseRendering();
  try {
    for (let i = 0; i < 4; ++i) native.pipeline.render();
    await native.renderer.backend.device.queue.onSubmittedWorkDone();
    const taa = native.taa;
    const state = taa.stateTexture;
    const width = state.image.width, height = state.image.height;
    const data = await native.renderer.readRenderTargetPixelsAsync({ textures: [state], width, height }, 0, 0, width, height);
    const flat = unpadRows(data, width, height);
    let maxMotion = 0, maxDepth = 0, sumMotion = 0, n = 0;
    for (let i = 0; i < width * height; i += Math.max(1, Math.floor((width * height) / samples))) {
      const depth = GPU.DataUtils.fromHalfFloat(flat[i * 4]);
      const mx = GPU.DataUtils.fromHalfFloat(flat[i * 4 + 2]);
      const my = GPU.DataUtils.fromHalfFloat(flat[i * 4 + 3]);
      const motion = Math.hypot(mx, my);
      if (!Number.isFinite(motion) || !Number.isFinite(depth)) continue;
      maxMotion = Math.max(maxMotion, motion);
      maxDepth = Math.max(maxDepth, depth);
      sumMotion += motion; n++;
    }
    return { width, height, sampled: n, maxMotionPixels: +maxMotion.toFixed(4), meanMotionPixels: +(sumMotion / n).toFixed(4), maxDepth: +maxDepth.toFixed(3), stillFrames: taa.stillFrames };
  } finally { if (was) native.resumeRendering(); }
}

/** Exclusive GPU benchmark of the integrated pipeline: reference vs native, alternating rounds. */
export async function benchmark({ resolution = [900, 600], pixelRatio = 1, samples = 12, rounds = 3, warmupFrames = 8, sustainedFrames = 30 } = {}) {
  const { benchmarkPipeline } = await import('./webgpu-pipeline-browser.js');
  const native = window.mgr;
  native.pauseRendering();
  let reference;
  try {
    reference = await createReferenceManager({ width: resolution[0], height: resolution[1], pixelRatio, envmapUrl: native.envmapUrl });
    for (const manager of [reference.manager, native]) {
      manager.updateRendererSize(resolution[0], resolution[1], pixelRatio);
      manager.camera.aspect = resolution[0] / resolution[1];
      manager.camera.updateProjectionMatrix();
    }
    const runs = await benchmarkPipeline([reference.manager, native], {
      resolutions: [resolution], pixelRatio, samples, rounds, warmupFrames, sustainedFrames,
    });
    return runs.runs.map((run) => ({
      backend: run.backend, config: run.config,
      gpuMedianMs: +run.gpu.medianMs.toFixed(3), gpuP10Ms: +run.gpu.p10Ms.toFixed(3), gpuP90Ms: +run.gpu.p90Ms.toFixed(3),
      gpuSamples: run.gpu.samples,
      sustainedMsPerFrame: +run.sustained.medianMs.toFixed(3), sustainedFps: +run.sustained.framesPerSecond.toFixed(1),
      roundMedians: run.roundMedians?.map((value) => +value.toFixed(3)),
      drawCalls: run.draws?.backends?.map((entry) => `${entry.backend}:${entry.calls}/${entry.triangles}`),
    }));
  } finally {
    reference?.manager.dispose();
    native.resumeRendering();
  }
}
