// Supervisor-owned comparison driver. Creates a hidden WebGL reference manager next to the native one,
// captures console errors during setup, then runs the backend-neutral comparison harness.
import { init } from '../src/renderer.js';
import * as THREE from 'three';
import { comparePipeline, benchmarkPipeline } from './webgpu-pipeline-browser.js';

function captureConsole() {
  const entries = [];
  const original = { error: console.error, warn: console.warn };
  console.error = (...args) => { entries.push({ level: 'error', text: args.map(String).join(' ') }); original.error(...args); };
  console.warn = (...args) => { entries.push({ level: 'warn', text: args.map(String).join(' ') }); original.warn(...args); };
  return { entries, restore: () => { console.error = original.error; console.warn = original.warn; } };
}

const waitFor = (predicate, timeoutMs, label) => new Promise((resolve, reject) => {
  const start = performance.now();
  const tick = () => {
    if (predicate()) return resolve();
    if (performance.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
    setTimeout(tick, 100);
  };
  tick();
});

export async function createReferenceManager({ width = 900, height = 600, pixelRatio = 1, envmapUrl } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px;opacity:0;pointer-events:none;z-index:-1`;
  document.body.appendChild(canvas);
  const manager = init({
    canvas, inputElement: canvas, pixelRatio, backend: 'webgl',
    modelUrl: `${import.meta.env.BASE_URL}False_Enlightenment.glb`,
    envmapUrl,
    targetDistance: 0.8, minDistance: 0.4, maxDistance: 2.0,
    initDelay: 0, initDelayInteractive: 0, startup: 'manual',
    lowPerformanceSettings: { disableMSAA: false, lowResolution: false },
    smaa: false, grazingSpecularClamp: false,
    perfSampling: { stabilityDuration: 0, measureDuration: 0.1 },
    e_interactivityChange: () => {}, e_loaded: () => {}, e_ready: () => {},
    e_backend: () => {}, e_error: (error) => { managerSetup.errors.push(error); },
  });
  const managerSetup = { manager, errors: [] };
  await manager.ready;
  return managerSetup;
}

export async function compare({ cases, resolution = [900, 600], pixelRatio = 1, tolerance, benchmark = false, samples = 8, rounds = 2, signal } = {}) {
  const capture = captureConsole();
  const native = window.mgr;
  if (!native) throw new Error('No native manager on window.mgr (open the lab with ?backend=webgpu)');
  native.pauseRendering();
  let reference;
  try {
    const envmapUrl = native.envmapUrl;
    reference = await createReferenceManager({ width: resolution[0], height: resolution[1], pixelRatio, envmapUrl });
    if (reference.errors.length) throw new Error(`Reference manager errors: ${JSON.stringify(reference.errors).slice(0, 500)}`);
    // The reference loads assets in its own loop; wait until its model and environment exist.
    await waitFor(() => reference.manager.model && reference.manager.scene.environment && reference.manager.taa, 120000, 'reference assets');
    // The harness pauses both production loops itself; the reference just has to be loaded and sized.
    reference.manager.updateRendererSize(resolution[0], resolution[1], pixelRatio);
    reference.manager.camera.aspect = resolution[0] / resolution[1];
    reference.manager.camera.updateProjectionMatrix();

    const result = await comparePipeline(reference.manager, native, {
      cases, resolution, pixelRatio, tolerance, signal,
      throwOnFailure: false,
    });
    let timings = null;
    if (benchmark) {
      timings = await benchmarkPipeline([reference.manager, native], { resolutions: [resolution], pixelRatio, samples, rounds, signal });
    }
    return { result, timings, console: capture.entries.filter((e) => e.level === 'error') };
  } finally {
    capture.restore();
    reference?.manager.dispose();
    native.resumeRendering();
  }
}
