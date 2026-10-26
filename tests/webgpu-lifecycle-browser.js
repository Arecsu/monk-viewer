// Supervisor-only browser gates. These checks are not GPU performance measurements.
import * as GPU from 'three/webgpu';
import * as T from 'three/tsl';
import { createTarget, FullscreenPass, logicalUV, sampleLogical, loadLogical, logicalPixel } from '../src/webgpu/Common.js';
import { unpadRows } from '../src/lab/geometry-probe-utils.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); };

/** Tests actual storage orientation, sampling and padded half-float readback at an odd size. */
export async function validateCommonStorage() {
  const renderer = new GPU.WebGPURenderer({ canvas: new OffscreenCanvas(7, 5), antialias: false });
  renderer._getFallback = null;
  const errors = [], targets = [], passes = [];
  try {
    await renderer.init();
    assert(renderer.backend.isWebGPUBackend, 'Helper gate must use native WebGPU');
    renderer.onError = info => errors.push(info.message);
    renderer.outputColorSpace = GPU.LinearSRGBColorSpace;
    const source = createTarget(7, 5, { format: 'rgba16float' }); targets.push(source);
    const sampled = createTarget(7, 5, { format: 'rgba16float' }); targets.push(sampled);
    const loaded = createTarget(7, 5, { format: 'rgba16float' }); targets.push(loaded);
    const draw = new FullscreenPass(renderer, T.vec4(logicalUV, 0, 1), { target: source }); passes.push(draw);
    const sample = new FullscreenPass(renderer, sampleLogical(source.texture), { target: sampled }); passes.push(sample);
    const load = new FullscreenPass(renderer, loadLogical(source.texture, logicalPixel(5), 5), { target: loaded }); passes.push(load);
    draw.render(); sample.render(); load.render();
    await renderer.backend.device.queue.onSubmittedWorkDone();
    const read = async target => {
      const packed = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 7, 5);
      return Float32Array.from(unpadRows(packed, 7, 5), GPU.DataUtils.fromHalfFloat);
    };
    const reference = await read(source), a = await read(sampled), b = await read(loaded);
    let maxError = 0;
    for (let y = 0; y < 5; ++y) for (let x = 0; x < 7; ++x) {
      const i = (y * 7 + x) * 4;
      maxError = Math.max(maxError, Math.abs(reference[i] - (x + 0.5) / 7), Math.abs(reference[i + 1] - (1 - (y + 0.5) / 5)));
      for (let c = 0; c < 4; ++c) {
        assert(a[i + c] === reference[i + c], `Filtered storage orientation differs at ${x},${y},${c}`);
        assert(b[i + c] === reference[i + c], `Loaded storage orientation differs at ${x},${y},${c}`);
      }
    }
    assert(maxError < 0.001, `Logical UV pattern error ${maxError}`);
    assert(errors.length === 0, errors.join('; '));
    return { backend: 'webgpu', size: [7, 5], comparedPixels: 35, maxError, errors };
  } finally {
    passes.reverse().forEach(pass => pass.dispose());
    targets.reverse().forEach(target => target.dispose());
    renderer.dispose();
  }
}

/** Executes all four blur passes on a nonconstant synthetic HDR input, with a real native device. */
export async function validateMotionBlurSmoke() {
  const { WebGpuMotionBlur } = await import('../src/webgpu/MotionBlur.js');
  const width = 33, height = 17;
  const renderer = new GPU.WebGPURenderer({ canvas: new OffscreenCanvas(width, height), antialias: false });
  renderer._getFallback = null;
  const errors = [], targets = [], passes = [];
  let blur;
  try {
    await renderer.init(); renderer.onError = info => errors.push(info.message);
    renderer.outputColorSpace = GPU.LinearSRGBColorSpace;
    const input = createTarget(width, height, { format: 'rgba16float' }); targets.push(input);
    const state = createTarget(width, height, { format: 'rgba16float', nearest: true }); targets.push(state);
    const debug = createTarget(width, height, { format: 'rgba16float' }); targets.push(debug);
    const pixel = logicalPixel(height);
    const pattern = T.select(pixel.x.equal(16), T.vec3(8, 2, 1), T.vec3(0));
    const colorPass = new FullscreenPass(renderer, T.vec4(pattern, 1), { target: input }); passes.push(colorPass);
    const statePass = new FullscreenPass(renderer, T.vec4(1, 0, 12, 0), { target: state }); passes.push(statePass);
    colorPass.render(); statePass.render();
    blur = new WebGpuMotionBlur(renderer, { shutter: 0.8, maxBlur: 0.4 }); blur.setSize(width, height);
    const output = blur.render({ color: input.texture, state: state.texture, hasMotion: true });
    const copy = new FullscreenPass(renderer, T.texture(output.color), { target: debug }); passes.push(copy); copy.render();
    await renderer.backend.device.queue.onSubmittedWorkDone();
    const pixels = Float32Array.from(unpadRows(await renderer.readRenderTargetPixelsAsync(debug, 0, 0, width, height), width, height), GPU.DataUtils.fromHalfFloat);
    assert(pixels.every(Number.isFinite), 'Motion blur produced nonfinite output');
    const center = pixels[(8 * width + 16) * 4], spread = pixels[(8 * width + 14) * 4];
    assert(center > 0 && center < 8 && spread > 0, `Blur did not reconstruct the HDR stripe: center=${center} spread=${spread}`);
    assert(errors.length === 0, errors.join('; '));
    return { backend: 'webgpu', size: [width, height], center, spread, errors };
  } finally {
    blur?.dispose(); passes.reverse().forEach(pass => pass.dispose()); targets.reverse().forEach(target => target.dispose()); renderer.dispose();
  }
}

/** A deterministic DOM lifecycle check; call only when the shared viewer is paused. */
export async function validateElementLifecycle({ modelUrl, envmapUrl, backend = 'webgpu', worker = false, timeoutMs = 45000 } = {}) {
  assert(modelUrl && envmapUrl, 'Explicit asset URLs required');
  await import('../src/main.ts');
  const statuses = [], events = [], errors = [];
  // Existing component reads ordinary source attributes in its constructor. Parsing markup performs an upgrade with attrs present.
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;width:193px;height:257px;left:0;top:0;pointer-events:none';
  const style = document.createElement('style');
  style.textContent = 'monk-view canvas { width:100% !important; height:100% !important; display:block }';
  holder.appendChild(style);
  const template = document.createElement('template');
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  template.innerHTML = `<monk-view model="${escape(modelUrl)}" envmap="${escape(envmapUrl)}" backend="${backend}" startup="manual" offscreencanvas="${worker}" style="display:block;width:193px;height:257px"></monk-view>`;
  const viewer = template.content.firstElementChild;
  const waitFor = (type, predicate = () => true) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { viewer.removeEventListener(type, listener); reject(new Error(`${type} timeout: ${JSON.stringify(errors)}`)); }, timeoutMs);
    function listener(event) { if (!predicate(event)) return; clearTimeout(timer); viewer.removeEventListener(type, listener); resolve(event); }
    viewer.addEventListener(type, listener);
  });
  viewer.addEventListener('backendchange', event => statuses.push(event.detail));
  viewer.addEventListener('ready', () => events.push('ready'));
  viewer.addEventListener('loaded', () => events.push('loaded'));
  viewer.addEventListener('renderererror', event => errors.push(event.detail));
  try {
    const ready = waitFor('ready');
    holder.appendChild(viewer); document.body.appendChild(holder);
    await ready;
    assert(!viewer.hasAttribute('loaded'), 'Manual start rendered before attemptInit');
    assert(viewer.backendStatus.selected === backend, `Backend mismatch: ${JSON.stringify(viewer.backendStatus)}`);
    const loaded = waitFor('loaded'); viewer.attemptInit(); await loaded;
    assert(events.indexOf('ready') < events.indexOf('loaded'), 'Loading events are out of order');
    const oldCanvas = viewer.querySelector('canvas');
    const readyAgain = waitFor('ready');
    viewer.remove(); holder.appendChild(viewer); await readyAgain;
    assert(viewer.querySelector('canvas') !== oldCanvas, 'Reconnect reused a bound/transferred canvas');
    assert(errors.length === 0, `Lifecycle errors: ${JSON.stringify(errors)}`);
    return { backend, worker, statuses, events, errors };
  } finally {
    viewer.disposeRenderer(); holder.remove();
  }
}
