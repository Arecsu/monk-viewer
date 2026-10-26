// Supervisor-owned performance profiler. Two measurements, both exclusive:
//  - fullBenchmark: reference vs native, presented-frame throughput at a physical resolution.
//  - profileNative: per-stage cost by ablation on the native manager (throughput and GPU timestamps).
import { createReferenceManager } from './webgpu-compare-browser.js';

const waitFrames = (count) => new Promise((resolve) => {
  let remaining = count;
  const tick = () => (--remaining <= 0 ? resolve() : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
});

const drainNative = async (manager) => {
  await manager.renderer.backend.device.queue.onSubmittedWorkDone();
  if (typeof manager.renderer.resolveTimestampsAsync === 'function') {
    try { await manager.renderer.resolveTimestampsAsync(); } catch { /* timestamps are best effort */ }
  }
};

function drainWebGl(manager) {
  const gl = manager.renderer.getContext();
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.flush();
  while (gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) { /* spin, like the probe */ }
  gl.deleteSync(sync);
}

async function timeBatch(manager, backend, frames, render) {
  for (let i = 0; i < Math.max(4, Math.round(frames / 6)); ++i) render(i); // warm-up, excluded
  if (backend === 'webgpu') await drainNative(manager); else drainWebGl(manager);
  const start = performance.now();
  for (let i = 0; i < frames; ++i) render(i);
  const submitted = performance.now();
  if (backend === 'webgpu') await drainNative(manager); else drainWebGl(manager);
  const end = performance.now();
  return { submitMsPerFrame: (submitted - start) / frames, wallMsPerFrame: (end - start) / frames };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** Presented-frame throughput at a physical resolution, both backends, alternating rounds. */
export async function fullBenchmark({ resolution = [3360, 1866], frames = 40, rounds = 3 } = {}) {
  const native = window.mgr;
  native.pauseRendering();
  let reference;
  try {
    reference = await createReferenceManager({ width: resolution[0], height: resolution[1], pixelRatio: 1, envmapUrl: native.envmapUrl });
    const managers = { webgl: reference.manager, webgpu: native };
    for (const manager of Object.values(managers)) {
      manager.updateRendererSize(resolution[0], resolution[1], 1);
      manager.camera.aspect = resolution[0] / resolution[1];
      manager.camera.updateProjectionMatrix();
      manager.taa.reset?.();
    }
    const samples = { webgl: [], webgpu: [] };
    const draws = {};
    for (let round = 0; round < rounds; ++round) {
      const order = round % 2 ? ['webgpu', 'webgl'] : ['webgl', 'webgpu'];
      for (const backend of order) {
        const manager = managers[backend];
        manager.taa.reset?.();
        manager.pipeline.render();
        const stats = await timeBatch(manager, backend, frames, () => manager.pipeline.render());
        samples[backend].push(stats);
        const info = manager.renderer.info.render;
        draws[backend] = { calls: info.calls ?? info.drawCalls, triangles: info.triangles };
      }
    }
    return {
      resolution,
      frames,
      rounds,
      webgl: { wallMsPerFrame: +median(samples.webgl.map((s) => s.wallMsPerFrame)).toFixed(3),
        submitMsPerFrame: +median(samples.webgl.map((s) => s.submitMsPerFrame)).toFixed(3),
        rounds: samples.webgl.map((s) => +s.wallMsPerFrame.toFixed(2)) },
      webgpu: { wallMsPerFrame: +median(samples.webgpu.map((s) => s.wallMsPerFrame)).toFixed(3),
        submitMsPerFrame: +median(samples.webgpu.map((s) => s.submitMsPerFrame)).toFixed(3),
        rounds: samples.webgpu.map((s) => +s.wallMsPerFrame.toFixed(2)) },
      draws,
      speedup: +(median(samples.webgl.map((s) => s.wallMsPerFrame)) / median(samples.webgpu.map((s) => s.wallMsPerFrame))).toFixed(2),
    };
  } finally {
    reference?.manager.dispose();
    native.resumeRendering();
  }
}

/** Per-stage cost on the native manager by switching stages off one at a time. */
export async function profileNative({ resolution = [3360, 1866], frames = 30, rounds = 3 } = {}) {
  const native = window.mgr;
  // Reading the presented image needs it as a texture; the viewer itself renders the tone pass straight to the canvas.
  if (native?.pipeline) native.pipeline.captureFinal = true;
  native.pauseRendering();
  const post = native.pipeline.postColor;
  const snapshot = {
    taa: native.taa.enabled, blur: native.motionBlurPass.enabled, bloom: post.bloom.enabled,
    dither: post.dithering.enabled, gt7: post.gt7ToneMapping.enabled,
    mask: native.pipeline.transparency.reactiveMaskEnabled,
  };
  const apply = (config) => {
    native.taa.enabled = config.taa ?? true;
    native.motionBlurPass.enabled = config.blur ?? true;
    post.bloom.enabled = config.bloom ?? true;
    post.dithering.enabled = config.dither ?? true;
    post.gt7ToneMapping.enabled = config.gt7 ?? true;
    native.pipeline.transparency.reactiveMaskEnabled = config.mask ?? true;
    native.taa.reset?.();
  };
  const results = {};
  try {
    native.updateRendererSize(resolution[0], resolution[1], 1);
    native.camera.aspect = resolution[0] / resolution[1];
    native.camera.updateProjectionMatrix();
    const configs = {
      full: {},
      'no-taa': { taa: false },
      'no-blur': { blur: false },
      'no-bloom': { bloom: false },
      'no-dither': { dither: false },
      'no-reactive-mask': { mask: false },
      'no-taa-no-blur': { taa: false, blur: false },
      'geometry+glass+gt7': { taa: false, blur: false, bloom: false, dither: false, mask: false },
    };
    for (const [name, config] of Object.entries(configs)) {
      const samples = [];
      for (let round = 0; round < rounds; ++round) {
        apply(config);
        native.pipeline.render();
        const stats = await timeBatch(native, 'webgpu', frames, () => native.pipeline.render());
        samples.push(stats.wallMsPerFrame);
      }
      results[name] = { wallMsPerFrame: +median(samples).toFixed(3), rounds: samples.map((v) => +v.toFixed(2)) };
    }
    const full = results.full.wallMsPerFrame;
    for (const [name, value] of Object.entries(results)) {
      value.costMs = +(full - value.wallMsPerFrame).toFixed(3);
      value.shareOfFull = +((full - value.wallMsPerFrame) / full * 100).toFixed(1);
    }
    return { resolution, frames, rounds, results };
  } finally {
    native.taa.enabled = snapshot.taa;
    native.motionBlurPass.enabled = snapshot.blur;
    post.bloom.enabled = snapshot.bloom;
    post.dithering.enabled = snapshot.dither;
    post.gt7ToneMapping.enabled = snapshot.gt7;
    native.pipeline.transparency.reactiveMaskEnabled = snapshot.mask;
    native.taa.reset?.();
    native.resumeRendering();
  }
}

/**
 * One backend at a time, at one physical size. Safer than holding two high-resolution pipelines: a dual 1080p+ run
 * can exhaust the GPU process on this machine. Dispose the reference before measuring the native side.
 */
export async function soloBenchmark({ backend = 'webgpu', resolution = [1920, 1080], frames = 24, rounds = 3 } = {}) {
  const native = window.mgr;
  if (backend === 'webgl') {
    const wasRendering = native?.isRendering;
    native?.pauseRendering();
    let reference;
    try {
      reference = await createReferenceManager({ width: resolution[0], height: resolution[1], pixelRatio: 1, envmapUrl: native.envmapUrl });
      const manager = reference.manager;
      manager.updateRendererSize(resolution[0], resolution[1], 1);
      manager.camera.aspect = resolution[0] / resolution[1];
      manager.camera.updateProjectionMatrix();
      const samples = [];
      for (let round = 0; round < rounds; ++round) {
        manager.taa.reset?.();
        manager.pipeline.render();
        const stats = await timeBatch(manager, 'webgl', frames, () => manager.pipeline.render());
        samples.push(stats.wallMsPerFrame);
      }
      const info = manager.renderer.info.render;
      return { backend, resolution, frames, rounds, wallMsPerFrame: +median(samples).toFixed(3), rounds_ms: samples.map((v) => +v.toFixed(2)),
        fps: +(1000 / median(samples)).toFixed(1), draws: { calls: info.calls, triangles: info.triangles } };
    } finally {
      reference?.manager.dispose();
      if (wasRendering) native.resumeRendering();
    }
  }
  native.pipeline.captureFinal = false; // measure what a viewer actually runs: tone pass straight to the canvas
  const was = native.pauseRendering();
  try {
    native.updateRendererSize(resolution[0], resolution[1], 1);
    const multiplier = native.cameraMultiplier(resolution[1] / resolution[0]) || 1;
    native.baseCameraSettings.multiplier = multiplier;
    native.camera.position.z = native.baseCameraSettings.targetDistance * multiplier;
    native.camera.aspect = resolution[0] / resolution[1];
    native.camera.updateProjectionMatrix();
    const samples = [];
    for (let round = 0; round < rounds; ++round) {
      native.taa.reset?.();
      native.pipeline.render();
      const stats = await timeBatch(native, 'webgpu', frames, () => native.pipeline.render());
      samples.push(stats.wallMsPerFrame);
    }
    const info = native.renderer.info.render;
    return { backend, resolution, frames, rounds, wallMsPerFrame: +median(samples).toFixed(3), rounds_ms: samples.map((v) => +v.toFixed(2)),
      fps: +(1000 / median(samples)).toFixed(1), draws: { calls: info.drawCalls, triangles: info.triangles } };
  } finally {
    if (was) native.resumeRendering();
  }
}

/**
 * Benchmarks the manager this page already owns, so exactly one renderer exists per tab. Open the lab with
 * ?backend=webgl and ?backend=webgpu in separate tabs/runs and compare the two results.
 */
export async function benchmarkCurrent({ resolution = [1920, 1080], frames = 24, rounds = 3 } = {}) {
  const manager = window.mgr;
  if (!manager) throw new Error('no manager on window.mgr');
  const backend = manager.backendStatus?.selected === 'webgl' ? 'webgl' : 'webgpu';
  if (backend === 'webgpu') manager.pipeline.captureFinal = false; // what a viewer runs: tone pass straight to canvas
  const was = manager.pauseRendering();
  const saved = { width: manager.renderer.domElement.clientWidth, height: manager.renderer.domElement.clientHeight,
    ratio: manager.renderer.getPixelRatio(), aspect: manager.camera.aspect, z: manager.camera.position.z };
  try {
    manager.updateRendererSize(resolution[0], resolution[1], 1);
    const multiplier = manager.cameraMultiplier(resolution[1] / resolution[0]) || 1;
    manager.baseCameraSettings.multiplier = multiplier;
    manager.camera.position.z = manager.baseCameraSettings.targetDistance * multiplier;
    manager.camera.aspect = resolution[0] / resolution[1];
    manager.camera.updateProjectionMatrix();
    const samples = [];
    for (let round = 0; round < rounds; ++round) {
      manager.taa.reset?.();
      manager.pipeline.render();
      const stats = await timeBatch(manager, backend, frames, () => manager.pipeline.render());
      samples.push(stats.wallMsPerFrame);
    }
    const info = manager.renderer.info.render;
    const median_ = median(samples);
    return { backend, resolution, frames, rounds, wallMsPerFrame: +median_.toFixed(3), rounds_ms: samples.map((v) => +v.toFixed(2)),
      fps: +(1000 / median_).toFixed(1), draws: { calls: info.calls ?? info.drawCalls, triangles: info.triangles },
      msaaSamples: manager.geometryPass?.samples ?? null };
  } finally {
    manager.updateRendererSize(saved.width, saved.height, saved.ratio);
    manager.camera.aspect = saved.aspect;
    manager.camera.position.z = saved.z;
    manager.camera.updateProjectionMatrix();
    manager.taa.reset?.();
    if (was) manager.resumeRendering();
  }
}
