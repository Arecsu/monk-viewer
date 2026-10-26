// Dev-only browser harness for the *integrated* native WebGPU pipeline (not the geometry probe).
// Run from the existing aa-lab.html tab; the supervisor owns the browser and the GPU:
//
//   const checks = await import('/monk-viewer/tests/webgpu-pipeline-browser.js');
//   window.validationAbort = new AbortController();
//   const results = await checks.comparePipeline(window.mgr, window.nativeMgr, { signal: window.validationAbort.signal });
//   console.table(results.validation.cases.map(c => ({ case: c.name, status: c.status, flatVisible: c.captures.at(-1)?.comparison.visibleFlatPixels, rmse: c.captures.at(-1)?.comparison.flatRmse })));
//   const timings = await checks.benchmarkPipeline([window.mgr, window.nativeMgr], { signal: window.validationAbort.signal });
//
// This module is backend-neutral above `createPipelineAdapter`: the same deterministic drive, capture,
// comparison and timing code runs for a WebGL manager and a native WebGPU manager. Backend identity is
// reported by the manager and cross-checked against the renderer; nothing here assumes a silent WebGL
// fallback. Missing hooks, a missing presented output target, missing timestamp queries or a render loop
// that keeps running all fail loudly with `CapabilityError`/`ValidationError` instead of producing numbers.
//
// Determinism and exclusivity:
// - The production rAF loop is stopped and verified quiescent (render counter frozen) before any driven
//   frame; the final `finally` restores transforms, resolution/pixel ratio, temporal history, toggle
//   settings and the render loop on success, failure and abort.
// - One exclusive GPU lock per page; a second harness refuses to start.
// - GPU timestamps are per-frame isolated pipeline timings with a fenced queue drain (WebGL fenceSync
//   polling, never gl.finish(); WebGPU queue.onSubmittedWorkDone + timestamp query resolve). Whole-frame
//   sustained timings are a separate back-to-back submission batch with one drain, reported apart from the
//   per-frame GPU numbers. Compilation/warm-up frames, uploads and readbacks are outside timed samples.

import {
  CapabilityError,
  DISPLAY_TOLERANCE,
  STILL_TOLERANCE,
  ValidationError,
  acquireExclusiveGpuLock,
  assertCaptureContent,
  captureStats,
  compareCaptures,
  compareCoverage,
  convergenceStats,
  createErrorMap,
  normalizeCapture,
  reinterpretEncoding,
  roundStability,
  sustainedStats,
  tileSummary,
  timingStats,
} from './webgpu-validation-utils.js';

export const DEFAULT_RESOLUTION = Object.freeze([900, 600]);
const OPERATION_TIMEOUT_MS = 15000;

/**
 * Manager/pipeline hooks this harness requires. `pipeline.finalTarget` is native-only; the WebGL manager
 * presents to its canvas. `manager.resetHistory` is optional: when provided it replaces the
 * `manager.taa.reset()` fallback so the native integration can also drop geometry/transparency history.
 */
export const REQUIRED_MANAGER_HOOKS = Object.freeze([
  'renderer',
  'pipeline.render()',
  'pipeline.finalTarget (native WebGPU, RenderTarget-like with textures[]; pipeline.latest accepted)',
  'model',
  'camera',
  'taa.reset() or resetHistory()',
  'isRendering',
  'startRenderLoop()',
  'updateRendererSize(width, height, pixelRatio)',
]);

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function checkAbort(signal, stage) {
  if (signal?.aborted) throw new DOMException(`WebGPU validation cancelled during ${stage}`, 'AbortError');
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
    throw new ValidationError('tab-hidden', `The validation tab is not visible during ${stage}; GPU timings and rAF pacing are not comparable and Chrome throttles background tabs`);
  }
}

async function waitFrames(count, signal, stage) {
  for (let i = 0; i < count; ++i) {
    checkAbort(signal, stage);
    await nextFrame();
  }
}

function isWebGl2(gl) {
  // The constructor is not guaranteed to exist in every execution context; the timer/readback extensions
  // still have to be present, so treat an unknown realm as "let the extension check decide".
  return typeof WebGL2RenderingContext === 'undefined' || gl instanceof WebGL2RenderingContext;
}

// ---------------------------------------------------------------------------------------------
// Backend identity. The manager's reported status is authoritative; the renderer must agree, so a
// mislabeled fallback cannot be measured as native WebGPU.

const BACKEND_ALIASES = new Map([
  ['webgpu', 'webgpu'], ['web-gpu', 'webgpu'], ['native', 'webgpu'],
  ['webgl', 'webgl'], ['webgl2', 'webgl'], ['gl', 'webgl'],
]);

function normalizeBackendName(value) {
  const normalized = BACKEND_ALIASES.get(String(value).toLowerCase());
  if (!normalized) throw new CapabilityError('backend-name', `Unknown backend name "${value}"; expected one of webgpu or webgl`);
  return normalized;
}

function readBackendStatus(manager) {
  const raw = manager.backendStatus ?? manager.backend ?? manager.renderer?.backendStatus;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') return { backend: normalizeBackendName(raw), reason: null, raw };
  const name = raw.backend ?? raw.selected ?? raw.actual ?? raw.active;
  if (typeof name !== 'string') return null;
  return { backend: normalizeBackendName(name), reason: raw.reason ?? null, raw };
}

export function resolveBackend(manager, label = 'manager') {
  const renderer = manager?.renderer;
  if (!renderer) throw new CapabilityError('manager-hooks', `${label}: manager.renderer is required`);
  let detected;
  // A WebGPURenderer that fell back to Three's WebGL backend (unavailable WebGPU or forceWebGL) must not be
  // validated or timed as native; the renderer class alone would mislabel it.
  if (renderer.backend?.isWebGLBackend === true && renderer.isWebGPURenderer === true) {
    throw new CapabilityError('backend-fallback', `${label}: this manager is a WebGPURenderer running Three's WebGL fallback backend (isWebGLBackend); it cannot be validated as native WebGPU`);
  }
  if (renderer.backend?.isWebGPUBackend === true || renderer.isWebGPURenderer === true) detected = 'webgpu';
  else if (renderer.isWebGLRenderer === true) detected = 'webgl';
  else throw new CapabilityError('backend', `${label}: renderer is neither a WebGPURenderer nor a WebGLRenderer; cannot identify the backend`);
  if (detected === 'webgpu' && (!renderer.backend?.device || typeof renderer.readRenderTargetPixelsAsync !== 'function')) {
    throw new CapabilityError('backend-device', `${label}: WebGPURenderer is missing its initialized backend device or readRenderTargetPixelsAsync; initialize and await the renderer before validating`);
  }
  if (detected === 'webgpu' && renderer.initialized === false) {
    // Three's Renderer.render() throws before init; fail with the actionable reason instead.
    throw new CapabilityError('backend-device', `${label}: renderer.init() has not completed; await the manager's asynchronous initialization before validating`);
  }
  if (detected === 'webgl' && typeof renderer.getContext !== 'function') {
    throw new CapabilityError('backend-context', `${label}: WebGLRenderer has no getContext()`);
  }
  const reported = readBackendStatus(manager);
  if (reported && reported.backend !== detected) {
    throw new ValidationError('backend-mismatch', `${label}: manager reports backend "${reported.backend}" but the renderer is ${detected}; refusing to validate an unreported fallback`);
  }
  return { backend: detected, status: reported };
}

// ---------------------------------------------------------------------------------------------
// Display output resolution.

function describeValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object') return `${typeof value} ${String(value)}`;
  return value.constructor?.name ?? 'object';
}

/** Resolve the texture the native pipeline presents: `pipeline.finalTarget`, else `pipeline.latest`. */
function resolveDisplayTarget(pipeline, label) {
  if (!pipeline) throw new CapabilityError('final-target', `${label}: manager.pipeline is required`);
  const candidate = pipeline.finalTarget ?? pipeline.latest;
  if (!candidate) {
    throw new CapabilityError('final-target', `${label}: pipeline.finalTarget/latest is missing; the native integration must expose the presented display target (RenderTarget with textures[]) to validate the final image`);
  }
  if (Array.isArray(candidate.textures) && candidate.textures.length > 0) {
    const texture = candidate.textures[0];
    const width = candidate.width ?? texture.image?.width;
    const height = candidate.height ?? texture.image?.height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new CapabilityError('final-target', `${label}: pipeline.finalTarget has no integer width/height (${String(width)}x${String(height)})`);
    }
    return { target: candidate, texture, width, height };
  }
  // Renderer.readRenderTargetPixelsAsync only reads `renderTarget.textures[textureIndex]`, so a bare
  // output texture is enough; its dimensions come from the texture image.
  if (candidate.isTexture && Number.isInteger(candidate.image?.width) && Number.isInteger(candidate.image?.height)) {
    return { target: { textures: [candidate], width: candidate.image.width, height: candidate.image.height }, texture: candidate, width: candidate.image.width, height: candidate.image.height };
  }
  throw new CapabilityError('final-target', `${label}: pipeline.finalTarget must be a RenderTarget (textures[]) or a texture with image dimensions, received ${describeValue(candidate)}`);
}

function nativeTextureInfo(renderer, texture) {
  const data = renderer.backend?.get?.(texture);
  const native = data?.texture;
  if (!native) return null;
  return {
    format: native.format,
    sampleCount: native.sampleCount,
    mipLevelCount: native.mipLevelCount,
    width: native.width,
    height: native.height,
    usage: native.usage,
  };
}

function textureFormatOf(renderer, texture) {
  const native = nativeTextureInfo(renderer, texture);
  return native?.format ?? texture.internalFormat ?? texture.format ?? null;
}

// ---------------------------------------------------------------------------------------------
// Fenced GPU drain (no gl.finish()).

async function waitForGlFence(gl, signal, stage) {
  checkAbort(signal, stage);
  const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!fence) throw new ValidationError('gpu-fence', 'WebGL could not create a fence sync; the context is likely lost');
  gl.flush();
  const start = performance.now();
  try {
    for (;;) {
      checkAbort(signal, stage);
      const status = gl.clientWaitSync(fence, 0, 0);
      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) return;
      if (status === gl.WAIT_FAILED || gl.isContextLost()) throw new ValidationError('gpu-fence', 'WebGL fence or context failed while draining the GPU queue');
      if (performance.now() - start > OPERATION_TIMEOUT_MS) throw new ValidationError('gpu-fence-timeout', `WebGL GPU fence did not signal within ${OPERATION_TIMEOUT_MS} ms`);
      await delay(1);
    }
  } finally {
    gl.deleteSync(fence);
  }
}

async function waitForGlQuery(gl, query, signal, stage) {
  const start = performance.now();
  for (;;) {
    checkAbort(signal, stage);
    if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
    if (gl.isContextLost()) throw new ValidationError('gpu-query', 'WebGL context lost while waiting for a timer query');
    if (performance.now() - start > OPERATION_TIMEOUT_MS) throw new ValidationError('gpu-query-timeout', `WebGL timer query did not resolve within ${OPERATION_TIMEOUT_MS} ms`);
    await delay(1);
  }
}

// ---------------------------------------------------------------------------------------------
// Adapter.

/**
 * Wrap one manager in a backend-neutral adapter. All validation and benchmark code goes through this
 * object, so adding a backend means adding a branch here instead of changing the test cases.
 */
export function createPipelineAdapter(manager, { label = 'manager' } = {}) {
  if (!manager || typeof manager !== 'object') throw new CapabilityError('manager', `${label}: manager is required`);
  const missing = [];
  for (const key of ['renderer', 'pipeline', 'model', 'camera']) if (!manager[key]) missing.push(key);
  if (!manager.pipeline?.render || typeof manager.pipeline.render !== 'function') missing.push('pipeline.render');
  if (typeof manager.updateRendererSize !== 'function') missing.push('updateRendererSize');
  if (typeof manager.startRenderLoop !== 'function') missing.push('startRenderLoop');
  if (!('isRendering' in manager)) missing.push('isRendering');
  if (typeof manager.taa?.reset !== 'function' && typeof manager.resetHistory !== 'function') missing.push('taa.reset() or resetHistory()');
  if (missing.length > 0) {
    throw new CapabilityError('manager-hooks', `${label}: missing required manager hooks: ${missing.join(', ')}; see REQUIRED_MANAGER_HOOKS`);
  }
  const { backend, status } = resolveBackend(manager, label);
  const renderer = manager.renderer;
  let glTiming = null;

  const adapter = {
    label,
    manager,
    backend,
    status,
    saved: null,
    parts: null,

    outputSize() {
      if (backend === 'webgl') {
        const canvas = renderer.domElement;
        return { width: canvas.width, height: canvas.height };
      }
      const display = resolveDisplayTarget(manager.pipeline, label);
      return { width: display.width, height: display.height };
    },

    renderCount() {
      // Both backends expose a monotonic per-render counter; used to prove the production loop stopped.
      if (backend === 'webgl') return renderer.info.render.frame;
      return renderer.info.render.calls;
    },

    describe() {
      return {
        label,
        backend,
        reportedStatus: status ? { backend: status.backend, reason: status.reason } : null,
        outputSize: this.outputSize(),
        introspection: this.introspect(),
      };
    },

    introspect() {
      if (backend === 'webgl') {
        const gl = renderer.getContext();
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        return {
          backend,
          drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
          contextAttributes: gl.getContextAttributes(),
          outputColorSpace: renderer.outputColorSpace,
          renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
          samples: manager.geometryPass?.samples ?? null,
          memory: { renderTargets: renderer.info.memory.renderTargets, textures: renderer.info.memory.textures },
        };
      }
      const display = resolveDisplayTarget(manager.pipeline, label);
      const native = nativeTextureInfo(renderer, display.texture);
      return {
        backend,
        displayTarget: {
          size: [display.width, display.height],
          format: textureFormatOf(renderer, display.texture),
          encodingExpectation: 'display-linear unless the format carries -srgb',
          sampleCount: native?.sampleCount ?? null,
          mipLevelCount: native?.mipLevelCount ?? null,
          colorSpace: display.texture.colorSpace,
        },
        memory: { renderTargets: renderer.info.memory.renderTargets, textures: renderer.info.memory.textures },
      };
    },

    async renderFrame(signal) {
      checkAbort(signal, `${label} render`);
      manager.pipeline.render();
    },

    async drain(signal) {
      checkAbort(signal, `${label} drain`);
      if (backend === 'webgl') {
        await waitForGlFence(renderer.getContext(), signal, `${label} drain`);
        return;
      }
      const queue = renderer.backend?.device?.queue;
      if (!queue || typeof queue.onSubmittedWorkDone !== 'function') {
        throw new CapabilityError('device-queue', `${label}: WebGPU device queue.onSubmittedWorkDone is unavailable; cannot drain the GPU queue`);
      }
      await queue.onSubmittedWorkDone();
      checkAbort(signal, `${label} drain`);
    },

    async capture(signal) {
      checkAbort(signal, `${label} capture`);
      if (backend === 'webgl') return captureWebGl(manager, label);
      return captureWebGpu(manager, label, signal);
    },

    measureDrawStats(signal) {
      checkAbort(signal, `${label} draw stats`);
      const info = renderer.info;
      const autoReset = info.autoReset;
      info.autoReset = false;
      try {
        info.reset();
        manager.pipeline.render();
      } finally {
        info.autoReset = autoReset;
      }
      const render = info.render;
      return {
        calls: backend === 'webgl' ? render.calls : render.drawCalls,
        triangles: render.triangles,
        points: render.points,
        lines: render.lines,
      };
    },

    resetHistory() {
      if (typeof manager.resetHistory === 'function') {
        manager.resetHistory();
      } else if (typeof manager.taa?.reset === 'function') {
        manager.taa.reset();
      } else {
        throw new CapabilityError('history-reset', `${label}: no manager.resetHistory() or manager.taa.reset() to invalidate temporal history`);
      }
      // WebGL velocity buffers keep an explicit initialized flag; the native geometry owns this state.
      if (manager.velocityBuffer && 'initialized' in manager.velocityBuffer) manager.velocityBuffer.initialized = false;
    },

    resize(width, height, pixelRatio) {
      manager.updateRendererSize(width, height, pixelRatio);
      manager.camera.aspect = width / height;
      manager.camera.updateProjectionMatrix();
      this.resetHistory();
    },

    timingCapability() {
      if (backend === 'webgl') {
        const gl = renderer.getContext();
        if (!isWebGl2(gl)) throw new CapabilityError('timestamps', `${label}: WebGL2 is required for EXT_disjoint_timer_query_webgl2`);
        const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
        if (!timer) throw new CapabilityError('timestamps', `${label}: EXT_disjoint_timer_query_webgl2 is unavailable; GPU timings cannot be reported`);
        glTiming = { gl, timer };
        return { backend, method: 'EXT_disjoint_timer_query_webgl2 with fenceSync polling' };
      }
      const device = renderer.backend?.device;
      if (!device) throw new CapabilityError('device', `${label}: renderer.backend.device is unavailable`);
      if (renderer.backend.trackTimestamp !== true) {
        throw new CapabilityError('timestamps', `${label}: WebGPU timestamp tracking is disabled; construct the native renderer with trackTimestamp: true and the timestamp-query feature`);
      }
      if (!device.features?.has?.('timestamp-query')) {
        throw new CapabilityError('timestamps', `${label}: the WebGPU device does not have the timestamp-query feature`);
      }
      if (typeof renderer.resolveTimestampsAsync !== 'function') {
        throw new CapabilityError('timestamps', `${label}: renderer.resolveTimestampsAsync is unavailable`);
      }
      return { backend, method: 'WebGPU timestamp-query resolve plus queue.onSubmittedWorkDone' };
    },

    /** One isolated frame of the whole integrated pipeline, in GPU milliseconds. */
    async measureFrameGpuMs(renderFrame, signal) {
      checkAbort(signal, `${label} timing`);
      if (backend === 'webgl') {
        const { gl, timer } = glTiming ?? {};
        if (!timer) throw new CapabilityError('timestamps', `${label}: timingCapability() must succeed before measuring`);
        const query = gl.createQuery();
        let duration;
        try {
          gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
          try {
            renderFrame();
          } finally {
            gl.endQuery(timer.TIME_ELAPSED_EXT);
          }
          await waitForGlFence(gl, signal, `${label} timing fence`);
          duration = await waitForGlQuery(gl, query, signal, `${label} timer query`);
        } finally {
          gl.deleteQuery(query);
        }
        if (gl.getParameter(timer.GPU_DISJOINT_EXT)) {
          throw new ValidationError('gpu-disjoint', `${label}: GPU_DISJOINT_EXT reported a disjoint timestamp; discard this round and rerun`);
        }
        return duration;
      }
      renderFrame();
      await this.drain(signal);
      const duration = await renderer.resolveTimestampsAsync();
      if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
        throw new CapabilityError('timestamps', `${label}: resolveTimestampsAsync returned ${String(duration)}; timestamp queries are not producing per-frame durations (enable trackTimestamp and check the timestamp-query feature)`);
      }
      return duration;
    },

    /**
     * Whole-frame sustained throughput: frames are submitted back to back and drained once, so no per-frame
     * CPU stall is imposed. Reported separately from the isolated per-frame GPU timings above.
     */
    async measureSustainedBatch(frameCount, renderFrame, signal) {
      if (!Number.isInteger(frameCount) || frameCount < 1) throw new ValidationError('invalid-integer', `${label}: sustained frame count must be a positive integer`);
      checkAbort(signal, `${label} sustained`);
      if (backend === 'webgl') {
        const { gl, timer } = glTiming ?? {};
        if (!timer) throw new CapabilityError('timestamps', `${label}: timingCapability() must succeed before measuring`);
        const query = gl.createQuery();
        const start = performance.now();
        let wallMsPerFrame, gpuMs;
        try {
          gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
          try {
            for (let i = 0; i < frameCount; ++i) { checkAbort(signal, `${label} sustained`); renderFrame(i); }
          } finally {
            gl.endQuery(timer.TIME_ELAPSED_EXT);
          }
          await waitForGlFence(gl, signal, `${label} sustained fence`);
          wallMsPerFrame = (performance.now() - start) / frameCount;
          gpuMs = await waitForGlQuery(gl, query, signal, `${label} sustained query`);
        } finally {
          gl.deleteQuery(query);
        }
        if (gl.getParameter(timer.GPU_DISJOINT_EXT)) {
          throw new ValidationError('gpu-disjoint', `${label}: GPU_DISJOINT_EXT reported a disjoint timestamp during the sustained batch; discard and rerun`);
        }
        return {
          frames: frameCount,
          wallMsPerFrame,
          gpuMsPerFrame: gpuMs / frameCount,
          method: 'back-to-back submissions inside one timer query, one fenceSync drain; wall clock includes CPU submission',
        };
      }
      const start = performance.now();
      for (let i = 0; i < frameCount; ++i) { checkAbort(signal, `${label} sustained`); renderFrame(i); }
      await this.drain(signal);
      return {
        frames: frameCount,
        wallMsPerFrame: (performance.now() - start) / frameCount,
        gpuMsPerFrame: null,
        method: 'back-to-back submissions with one queue.onSubmittedWorkDone; wall clock includes CPU submission and queue pipelining, GPU duration across the batch is not exposed by the timestamp pool',
      };
    },
  };
  return adapter;
}

function captureWebGl(manager, label) {
  const renderer = manager.renderer;
  const gl = renderer.getContext();
  if (!isWebGl2(gl)) throw new CapabilityError('readback', `${label}: WebGL2 is required to read the presented frame`);
  if (typeof renderer.getRenderTarget === 'function' && renderer.getRenderTarget() !== null) {
    throw new ValidationError('render-target-bound', `${label}: pipeline.render() left a render target bound, so the presented canvas is not the final image`);
  }
  const canvas = renderer.domElement;
  const width = canvas.width, height = canvas.height;
  if (!(width > 0 && height > 0)) throw new ValidationError('output-size', `${label}: drawing buffer is ${width}x${height}`);
  const data = new Uint8Array(width * height * 4);
  const previousReadFramebuffer = gl.READ_FRAMEBUFFER_BINDING === undefined ? null : gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
  try {
    if (previousReadFramebuffer) gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
  } finally {
    if (previousReadFramebuffer) gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previousReadFramebuffer);
  }
  const error = gl.getError();
  if (error !== gl.NO_ERROR) throw new ValidationError('readback-failed', `${label}: gl.readPixels failed with error ${error}`);
  const colorSpace = renderer.outputColorSpace;
  if (colorSpace !== 'srgb' && colorSpace !== 'srgb-linear') {
    throw new CapabilityError('output-color-space', `${label}: unsupported renderer.outputColorSpace "${String(colorSpace)}"; expected srgb or srgb-linear so the presented frame has a known encoding`);
  }
  // readPixels rows start at the bottom-left, unlike WebGPU storage.
  return normalizeCapture({
    data, width, height, channels: 4, rowOrder: 'bottom-left',
    format: colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
    label: `${label} presented frame`,
  });
}

async function captureWebGpu(manager, label, signal) {
  const renderer = manager.renderer;
  const display = resolveDisplayTarget(manager.pipeline, label);
  checkAbort(signal, `${label} readback`);
  const format = textureFormatOf(renderer, display.texture);
  const data = await renderer.readRenderTargetPixelsAsync(display.target, 0, 0, display.width, display.height);
  checkAbort(signal, `${label} readback`);
  // normalizeCapture validates the typed array against the declared format, so a stale target or a
  // format Three cannot map fails instead of being averaged as unknown values.
  return normalizeCapture({
    data, width: display.width, height: display.height, channels: 4, rowOrder: 'top-left',
    format, label: `${label} final target`,
  });
}

// ---------------------------------------------------------------------------------------------
// Manager state snapshot / restore.

function logicalSize(manager) {
  const canvas = manager.renderer.domElement;
  const pixelRatio = manager.renderer.getPixelRatio();
  const width = canvas.clientWidth > 0 ? canvas.clientWidth : Math.round(canvas.width / pixelRatio);
  const height = canvas.clientHeight > 0 ? canvas.clientHeight : Math.round(canvas.height / pixelRatio);
  return { width, height, pixelRatio };
}

function saveManagerState(adapter) {
  const manager = adapter.manager;
  const size = logicalSize(manager);
  return {
    ...size,
    isRendering: manager.isRendering,
    infoAutoReset: manager.renderer.info.autoReset,
    camera: {
      position: manager.camera.position.clone(),
      quaternion: manager.camera.quaternion.clone(),
      aspect: manager.camera.aspect,
    },
    model: {
      position: manager.model.position.clone(),
      quaternion: manager.model.quaternion.clone(),
    },
    cameraDistance: manager.camera.position.length(),
  };
}

function collectParts(model) {
  const parts = [];
  model.traverse((object) => {
    if (object !== model && object.isMesh && typeof object.name === 'string' && object.name.startsWith('CLIP')) parts.push(object);
  });
  return parts.map((object) => ({ object, position: object.position.clone() }));
}

function sceneTriangles(model) {
  let triangles = 0;
  model.traverse((object) => {
    if (!object.isMesh || object.visible === false) return;
    const geometry = object.geometry;
    const count = geometry?.index ? geometry.index.count : geometry?.attributes?.position?.count ?? 0;
    triangles += Math.floor(count / 3);
  });
  return triangles;
}

async function pauseProductionLoop(adapter, signal) {
  const manager = adapter.manager;
  manager.isRendering = false;
  await waitFrames(1, signal, `${adapter.label} pause`);
  const before = adapter.renderCount();
  await waitFrames(2, signal, `${adapter.label} pause`);
  const after = adapter.renderCount();
  if (after !== before) {
    throw new ValidationError('loop-active', `${adapter.label}: the production render loop still rendered after isRendering was cleared; refusing to share the GPU with a scheduled loop`);
  }
}

function restoreManagerState(adapter) {
  const manager = adapter.manager;
  const saved = adapter.saved;
  if (!saved) return [];
  const errors = [];
  const attempt = (description, operation) => {
    try {
      operation();
    } catch (error) {
      errors.push(`${adapter.label}: restoring ${description} failed: ${error?.message ?? error}`);
    }
  };
  for (const { object, position } of adapter.parts ?? []) attempt('a scene part position', () => object.position.copy(position));
  attempt('the model transform', () => {
    manager.model.position.copy(saved.model.position);
    manager.model.quaternion.copy(saved.model.quaternion);
  });
  attempt('the camera', () => {
    manager.camera.position.copy(saved.camera.position);
    manager.camera.quaternion.copy(saved.camera.quaternion);
    manager.camera.aspect = saved.camera.aspect;
    manager.camera.updateProjectionMatrix();
  });
  attempt('the renderer size', () => manager.updateRendererSize(saved.width, saved.height, saved.pixelRatio));
  attempt('renderer.info.autoReset', () => { manager.renderer.info.autoReset = saved.infoAutoReset; });
  attempt('temporal history', () => adapter.resetHistory());
  attempt('the render loop', () => {
    manager.isRendering = saved.isRendering;
    if (saved.isRendering) manager.startRenderLoop();
  });
  return errors;
}

// ---------------------------------------------------------------------------------------------
// Conditions (preset/toggle cases). Each target lists candidate member paths so the same condition works
// on the WebGL manager and on the native manager, without assuming one component layout.

const TONE_MAPPING_PATHS = Object.freeze(['gt7ToneMapping', 'pipeline.postColor.gt7ToneMapping', 'pipeline.gt7ToneMapping']);
const REINHARD_PATHS = Object.freeze(['reinhardToneMapping', 'pipeline.postColor.reinhardToneMapping', 'pipeline.reinhardToneMapping']);
const TAA_PATHS = Object.freeze(['taa', 'pipeline.taa']);
const MOTION_BLUR_PATHS = Object.freeze(['motionBlurPass', 'motionBlur', 'pipeline.motionBlur', 'pipeline.motionBlurPass']);
const SMAA_PATHS = Object.freeze(['smaaPass', 'pipeline.smaaPass', 'pipeline.postColor.smaaPass']);
const GEOMETRY_PATHS = Object.freeze(['geometryPass', 'geometry', 'pipeline.geometry']);

export const CONDITIONS = Object.freeze({
  'taa-off': { required: true, targets: [{ paths: TAA_PATHS, key: 'enabled', value: false }] },
  'motion-blur-off': { required: true, targets: [{ paths: MOTION_BLUR_PATHS, key: 'enabled', value: false }] },
  'reinhard': {
    required: true,
    targets: [
      { paths: TONE_MAPPING_PATHS, key: 'enabled', value: false },
      { paths: REINHARD_PATHS, key: 'enabled', value: true },
    ],
  },
  'smaa-on': { required: false, targets: [{ paths: SMAA_PATHS, key: 'enabled', value: true }] },
  'msaa-off': { required: false, targets: [{ paths: GEOMETRY_PATHS, key: 'samples', value: 0 }] },
});

function resolveMember(manager, paths) {
  for (const path of paths) {
    let owner = manager;
    const segments = path.split('.');
    for (const segment of segments) owner = owner?.[segment];
    if (owner && typeof owner === 'object') return { owner, path };
  }
  return null;
}

function applyCondition(adapters, name) {
  const definition = CONDITIONS[name];
  if (!definition) throw new CapabilityError('condition', `Unknown condition "${name}"; known conditions: ${Object.keys(CONDITIONS).join(', ')}`);
  const plan = [];
  for (const adapter of adapters) {
    for (const target of definition.targets) {
      const resolved = resolveMember(adapter.manager, target.paths);
      if (!resolved) {
        const expected = `${adapter.label} member in [${target.paths.join(', ')}]`;
        if (definition.required) {
          throw new CapabilityError('condition-hook', `Condition "${name}" needs ${expected}; the manager must expose the reference-compatible component so the preset can be validated instead of skipped`);
        }
        return { condition: name, available: false, reason: `missing ${expected}`, restore() {} };
      }
      plan.push({ adapter, owner: resolved.owner, key: target.key, value: target.value, path: resolved.path, previous: resolved.owner[target.key] });
    }
  }
  for (const entry of plan) entry.owner[entry.key] = entry.value;
  for (const adapter of adapters) adapter.resetHistory();
  return {
    condition: name,
    available: true,
    applied: plan.map((entry) => ({ backend: entry.adapter.label, member: entry.path, property: entry.key, value: entry.value, previous: entry.previous })),
    restore() {
      for (const entry of plan) entry.owner[entry.key] = entry.previous;
      for (const adapter of adapters) adapter.resetHistory();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Deterministic poses.

export const POSES = Object.freeze({
  still: () => {},
  rotation: (index, { manager, adapter, frameCount }) => {
    const axis = manager.model.up;
    manager.model.quaternion.copy(adapter.saved.model.quaternion);
    manager.model.rotateOnAxis(axis, (index / frameCount) * Math.PI * 2);
  },
  orbit: (index, { manager, adapter, frameCount }) => {
    const radius = adapter.saved.cameraDistance;
    const angle = (index / frameCount) * Math.PI * 2;
    manager.camera.position.set(Math.sin(angle) * radius * 0.6, radius * 0.12, Math.cos(angle) * radius * 0.6);
    manager.camera.lookAt(0, 0, 0);
  },
  clips: (index, context) => {
    POSES.rotation(index, context);
    for (const { object, position } of context.adapter.parts) {
      object.position.copy(position);
      object.position.x += Math.sin(index / 6) * 0.02;
    }
  },
});

function resolvePose(pose) {
  if (typeof pose === 'function') return pose;
  const resolved = POSES[pose];
  if (!resolved) throw new CapabilityError('pose', `Unknown pose "${pose}"; known poses: ${Object.keys(POSES).join(', ')}`);
  return resolved;
}

export const DEFAULT_CASES = Object.freeze([
  { name: 'still convergence', pose: 'still', frames: 48, captureTail: 4, convergence: true },
  { name: 'model rotation', pose: 'rotation', frames: 24, captureEvery: 4 },
  { name: 'camera orbit', pose: 'orbit', frames: 24, captureEvery: 4 },
  { name: 'independent clip motion', pose: 'clips', frames: 24, captureEvery: 4, requiresParts: true },
  { name: 'odd resolution 901x601', pose: 'rotation', frames: 12, captureEvery: 4, resolution: [901, 601] },
  { name: 'tiny resolution 37x25', pose: 'rotation', frames: 12, captureEvery: 6, resolution: [37, 25] },
  { name: 'portrait resolution 500x750', pose: 'rotation', frames: 12, captureEvery: 4, resolution: [500, 750] },
  { name: 'mid-sequence resize 640x480', pose: 'rotation', frames: 24, captureEvery: 6, resizeAt: { frame: 12, width: 640, height: 480 } },
  { name: 'toggle: TAA disabled', pose: 'rotation', frames: 16, captureEvery: 8, condition: 'taa-off' },
  { name: 'toggle: motion blur disabled', pose: 'rotation', frames: 16, captureEvery: 8, condition: 'motion-blur-off' },
  { name: 'preset: Reinhard tone mapping', pose: 'rotation', frames: 16, captureEvery: 8, condition: 'reinhard' },
  { name: 'preset: SMAA', pose: 'rotation', frames: 12, captureEvery: 6, condition: 'smaa-on' },
  { name: 'preset: MSAA disabled', pose: 'rotation', frames: 12, captureEvery: 6, condition: 'msaa-off' },
]);

function captureIndicesFor(definition) {
  const indices = new Set();
  if (definition.captureTail) {
    const count = Math.min(definition.captureTail, definition.frames);
    for (let i = definition.frames - count; i < definition.frames; ++i) indices.add(i);
  } else if (definition.captureEvery) {
    for (let i = 0; i < definition.frames; ++i) if ((i + 1) % definition.captureEvery === 0) indices.add(i);
  } else {
    indices.add(definition.frames - 1);
  }
  return indices;
}

function assertSharedOutputSize(adapters, width, height, pixelRatio) {
  const expectedWidth = Math.floor(width * pixelRatio);
  const expectedHeight = Math.floor(height * pixelRatio);
  const sizes = adapters.map((adapter) => ({ label: adapter.label, ...adapter.outputSize() }));
  for (const size of sizes) {
    if (size.width !== expectedWidth || size.height !== expectedHeight) {
      throw new ValidationError('output-size', `${size.label}: presented output is ${size.width}x${size.height}, expected ${expectedWidth}x${expectedHeight} for ${width}x${height} at pixel ratio ${pixelRatio}`);
    }
  }
  const first = sizes[0];
  for (const size of sizes.slice(1)) {
    if (size.width !== first.width || size.height !== first.height) {
      throw new ValidationError('output-size', `presented sizes differ between backends: ${first.label} ${first.width}x${first.height} vs ${size.label} ${size.width}x${size.height}`);
    }
  }
  return sizes;
}

// ---------------------------------------------------------------------------------------------
// Comparison harness.

async function runCase(context, definition, result) {
  const { adapters, signal, pixelRatio } = context;
  const resolution = definition.resolution ?? context.resolution;
  const caseResult = {
    name: definition.name,
    status: 'validated',
    resolution,
    frames: definition.frames,
    condition: null,
    captures: [],
    convergence: null,
    draws: null,
    errorMap: null,
    failures: [],
    notes: [],
  };
  const pose = resolvePose(definition.pose);
  if (definition.requiresParts) {
    const missing = adapters.filter((adapter) => adapter.parts.length === 0).map((adapter) => adapter.label);
    if (missing.length > 0) {
      caseResult.status = 'unavailable';
      caseResult.failures.push({ code: 'independent-parts-missing', message: `${missing.join(', ')}: no CLIP* meshes found, so independent per-mesh motion cannot be exercised` });
      return caseResult;
    }
  }
  let condition = null;
  try {
    if (definition.condition) {
      condition = applyCondition(adapters, definition.condition);
      caseResult.condition = { name: definition.condition, available: condition.available, reason: condition.reason ?? null, applied: condition.applied ?? null };
      if (!condition.available) {
        // Optional presets (SMAA, MSAA) may legitimately be absent; report them as not validated instead of
        // silently passing them.
        caseResult.status = 'unavailable';
        caseResult.notes.push(`Condition "${definition.condition}" is unavailable: ${condition.reason}`);
        return caseResult;
      }
    }
    for (const adapter of adapters) adapter.resize(resolution[0], resolution[1], pixelRatio);
    assertSharedOutputSize(adapters, resolution[0], resolution[1], pixelRatio);
    const captureIndices = [...captureIndicesFor(definition)];
    const captureIndexSet = new Set(captureIndices);
    const captures = adapters.map(() => []);
    for (let index = 0; index < definition.frames; ++index) {
      checkAbort(signal, `case ${definition.name}`);
      if (definition.resizeAt && index === definition.resizeAt.frame) {
        for (const adapter of adapters) adapter.resize(definition.resizeAt.width, definition.resizeAt.height, pixelRatio);
        assertSharedOutputSize(adapters, definition.resizeAt.width, definition.resizeAt.height, pixelRatio);
      }
      for (const adapter of adapters) pose(index, { manager: adapter.manager, adapter, frameCount: definition.frames });
      for (const adapter of adapters) await adapter.renderFrame(signal);
      if (captureIndexSet.has(index)) {
        for (let i = 0; i < adapters.length; ++i) captures[i].push(await adapters[i].capture(signal));
      }
    }
    caseResult.framesDriven = definition.frames;
    for (let index = 0; index < captures[0].length; ++index) {
      const reference = captures[0][index];
      const candidate = captures[1][index];
      const contentBounds = { minimumLitFraction: 0.002, maximumLitFraction: 1 };
      const referenceStats = assertCaptureContent(captureStats(reference), { label: `${definition.name} ${adapters[0].label}`, ...contentBounds });
      const candidateStats = assertCaptureContent(captureStats(candidate), { label: `${definition.name} ${adapters[1].label}`, ...contentBounds });
      const coverage = compareCoverage(referenceStats, candidateStats, { label: definition.name });
      const tolerance = definition.convergence ? STILL_TOLERANCE : context.tolerance;
      const comparison = compareCaptures(reference, candidate, { tolerance, label: `${definition.name} capture ${index}` });
      caseResult.captures.push({
        index,
        size: [reference.width, reference.height],
        [adapters[0].label]: referenceStats,
        [adapters[1].label]: candidateStats,
        coverage,
        comparison,
      });
      if (!coverage.pass) caseResult.failures.push({ code: 'coverage', message: `${definition.name} capture ${index}: ${coverage.reasons.join('; ')}`, index });
      if (!comparison.pass) {
        // Diagnose a likely encoding/format declaration mismatch rather than only reporting a large error.
        const alternateEncoding = candidate.encoding === 'srgb' ? 'display-linear' : 'srgb';
        const alternate = compareCaptures(reference, reinterpretEncoding(candidate, alternateEncoding), { tolerance, label: `${definition.name} alternate encoding` });
        if (comparison.rmse !== null && alternate.rmse !== null && alternate.rmse < comparison.rmse / 4) {
          comparison.encodingHint = `the native capture is much closer to the reference when reinterpreted as ${alternateEncoding} (declared ${candidate.format}); check pipeline.finalTarget format/encoding`;
          caseResult.notes.push(`capture ${index}: ${comparison.encodingHint}`);
        }
        caseResult.failures.push({ code: 'display-difference', message: `${definition.name} capture ${index}: ${comparison.reasons.join('; ')}`, index });
      }
    }
    // Error map of the final compared frame for locating any reported difference.
    const lastIndex = captures[0].length - 1;
    if (lastIndex >= 0) {
      const map = createErrorMap(captures[0][lastIndex], captures[1][lastIndex], { label: `${definition.name} final frame` });
      caseResult.errorMap = {
        index: captureIndices[lastIndex],
        width: map.width,
        height: map.height,
        maxStep: map.maxStep,
        visiblePixels: map.visiblePixels,
        tiles: tileSummary(map),
        data: map.data,
        note: 'data is a Uint8Array of per-pixel maximum sRGB code steps (not JSON serializable)',
      };
      if (!definition.convergence && map.maxStep >= Math.round(DISPLAY_TOLERANCE.visibleCodeStep * 255)) {
        const comparison = caseResult.captures[lastIndex].comparison;
        if (comparison.pass && comparison.visiblePixels > 0) {
          caseResult.notes.push(`${comparison.visibleEdgePixels} reported visible pixels are all edge-adjacent (documented shading/silhouette difference)`);
        }
      }
    }
    // Draw submission: measured after the captures so the extra render cannot disturb a captured frame.
    const draws = adapters.map((adapter) => ({ backend: adapter.label, ...adapter.measureDrawStats(signal) }));
    caseResult.draws = { backends: draws, sceneTriangles: context.sceneTriangles };
    for (const entry of draws) {
      if (!(entry.calls > 0) || !(entry.triangles > 0)) {
        caseResult.failures.push({ code: 'draw-stats', message: `${definition.name} ${entry.backend}: submitted ${entry.calls} draw calls / ${entry.triangles} triangles; the pipeline did not draw the scene` });
      } else if (entry.triangles < context.sceneTriangles) {
        caseResult.failures.push({ code: 'incomplete-draw', message: `${definition.name} ${entry.backend}: submitted ${entry.triangles} triangles, fewer than the ${context.sceneTriangles} scene triangles; the geometry stage is incomplete` });
      }
    }
    if (definition.convergence) {
      caseResult.convergence = {
        backends: adapters.map((adapter, i) => ({ backend: adapter.label, ...convergenceStats(captures[i], { tolerance: STILL_TOLERANCE, label: `${definition.name} ${adapter.label}` }) })),
      };
      for (const entry of caseResult.convergence.backends) {
        if (!entry.converged) caseResult.failures.push({ code: 'not-converged', message: `${definition.name} ${entry.backend}: still frames did not converge: ${entry.reasons.join('; ')}` });
      }
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    if (error instanceof ValidationError) {
      caseResult.status = 'failed';
      caseResult.failures.push({ code: error.code ?? 'validation', message: error.message });
    } else {
      throw error;
    }
  } finally {
    try {
      condition?.restore();
    } catch (error) {
      result.restoreFailures.push(`${definition.name}: restoring condition ${definition.condition} failed: ${error?.message ?? error}`);
    }
  }
  if (caseResult.failures.length > 0 && caseResult.status === 'validated') caseResult.status = 'failed';
  return caseResult;
}

async function collectEnvironment() {
  const environment = {
    userAgent: globalThis.navigator?.userAgent ?? null,
    devicePixelRatio: globalThis.devicePixelRatio ?? null,
    visibilityState: typeof document === 'undefined' ? null : document.visibilityState,
    hardwareConcurrency: globalThis.navigator?.hardwareConcurrency ?? null,
    webgpuAdapter: null,
  };
  if (globalThis.navigator?.gpu) {
    try {
      const adapter = await globalThis.navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      environment.webgpuAdapter = adapter ? {
        features: [...adapter.features],
        limits: {
          maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
          maxColorAttachments: adapter.limits.maxColorAttachments,
        },
        info: adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description } : null,
      } : null;
    } catch (error) {
      environment.webgpuAdapter = { error: String(error?.message ?? error) };
    }
  }
  return environment;
}

/**
 * Full-frame parity of the integrated pipeline: the WebGL reference manager against the native WebGPU
 * manager, driven frame-for-frame with identical deterministic poses. WebGPU uncaptured errors fail the
 * run. Returns structured results; throws the rejected results when `throwOnFailure` is true.
 */
export async function comparePipeline(referenceManager, nativeManager, {
  cases = DEFAULT_CASES,
  tolerance = DISPLAY_TOLERANCE,
  resolution = DEFAULT_RESOLUTION,
  pixelRatio = 1,
  signal,
  throwOnFailure = true,
  onProgress = (stage, detail) => console.info('WebGPU pipeline validation', stage, detail ?? ''),
} = {}) {
  checkAbort(signal, 'startup');
  const adapters = [
    createPipelineAdapter(referenceManager, { label: 'webgl-reference' }),
    createPipelineAdapter(nativeManager, { label: 'webgpu-native' }),
  ];
  if (adapters[0].backend !== 'webgl' || adapters[1].backend !== 'webgpu') {
    throw new CapabilityError('backend-pair', `comparePipeline needs a WebGL reference and a native WebGPU manager; received ${adapters.map((adapter) => `${adapter.label}=${adapter.backend}`).join(', ')}`);
  }
  if (!Array.isArray(cases) || cases.length === 0) throw new ValidationError('cases', 'comparePipeline needs at least one case');
  const lock = acquireExclusiveGpuLock(globalThis, 'webgpu-pipeline-validation');
  const result = {
    scope: 'integrated full pipeline, presented display output, WebGL reference vs native WebGPU',
    methodology: {
      drive: 'production rAF loop stopped and verified quiescent; frames driven manually with identical deterministic poses per backend',
      capture: 'WebGL default framebuffer readPixels (bottom-left rows) and WebGPU pipeline.finalTarget readback (top-left, row padding compacted); both normalized to display top-left',
      encoding: 'WebGL canvas sRGB codes and native display-linear target compared in display-linear light with sRGB code visibility classification',
      tolerance: { name: tolerance.name, ...tolerance },
      exclusivity: 'page-wide exclusive GPU lock; production render loop paused before driven frames; state restored in finally on success, failure and abort',
      notCovered: 'no whole-frame performance claim here; use benchmarkPipeline for separate sustained timings',
    },
    environment: null,
    backends: [],
    validation: { cases: [], pass: true, failures: [], unavailable: [] },
    errors: [],
    restoreFailures: [],
  };
  const savedErrors = { adapters: [] };
  let failure = null;
  try {
    result.environment = await collectEnvironment();
    result.backends = adapters.map((adapter) => adapter.describe());
    onProgress('environment', result.environment);
    for (const adapter of adapters) {
      adapter.saved = saveManagerState(adapter);
      adapter.parts = collectParts(adapter.manager.model);
    }
    const context = {
      adapters,
      signal,
      tolerance,
      pixelRatio,
      resolution,
      sceneTriangles: sceneTriangles(adapters[0].manager.model),
    };
    if (context.sceneTriangles <= 0) throw new ValidationError('scene', 'The model has no visible triangles; nothing to validate');
    // Surface native device errors as failures instead of console noise.
    const gpuDevice = adapters[1].manager.renderer.backend?.device;
    if (gpuDevice?.addEventListener) {
      const onUncaptured = (event) => result.errors.push(event.error?.message ?? 'uncaptured WebGPU error');
      gpuDevice.addEventListener('uncapturederror', onUncaptured);
      savedErrors.adapters.push({ device: gpuDevice, listener: onUncaptured });
    }
    const gl = adapters[0].manager.renderer.getContext?.();
    if (gl?.canvas?.addEventListener) {
      const onContextLost = (event) => { event.preventDefault(); result.errors.push('WebGL context lost during validation'); };
      gl.canvas.addEventListener('webglcontextlost', onContextLost);
      savedErrors.adapters.push({ canvas: gl.canvas, listener: onContextLost });
    }
    for (const adapter of adapters) await pauseProductionLoop(adapter, signal);
    for (const adapter of adapters) await adapter.drain(signal);
    onProgress('paused production loops');
    for (const definition of cases) {
      checkAbort(signal, `case ${definition.name}`);
      onProgress('case', definition.name);
      const caseResult = await runCase(context, definition, result);
      result.validation.cases.push(caseResult);
      for (const failure of caseResult.failures) result.validation.failures.push({ case: definition.name, ...failure });
      if (caseResult.status === 'unavailable') {
        result.validation.unavailable.push({ case: definition.name, reason: caseResult.failures[0]?.message ?? caseResult.notes.join('; ') });
      }
    }
    if (result.errors.length > 0) {
      result.validation.pass = false;
      for (const message of result.errors) result.validation.failures.push({ case: 'runtime', code: 'gpu-error', message });
    }
    result.validation.pass = result.validation.failures.length === 0;
    // `complete` is false when an optional preset could not be exercised: pass alone is not full acceptance.
    result.validation.complete = result.validation.unavailable.length === 0;
    onProgress('result', { pass: result.validation.pass, complete: result.validation.complete, failures: result.validation.failures.length });
    if (!result.validation.pass && throwOnFailure) {
      const rejected = new ValidationError('rejected', `Native pipeline validation failed: ${result.validation.failures.map((failure) => `${failure.case}/${failure.code}: ${failure.message}`).join(' | ')}`);
      rejected.results = result;
      throw rejected;
    }
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    for (const entry of savedErrors.adapters) {
      if (entry.device) entry.device.removeEventListener('uncapturederror', entry.listener);
      if (entry.canvas) entry.canvas.removeEventListener('webglcontextlost', entry.listener);
    }
    for (const adapter of adapters) result.restoreFailures.push(...restoreManagerState(adapter));
    lock.release();
    if (result.restoreFailures.length > 0) {
      onProgress('restore-failed', result.restoreFailures);
      if (!failure) throw new ValidationError('restore-failed', `State restoration failed: ${result.restoreFailures.join(' | ')}`);
      failure.restoreFailures = result.restoreFailures;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Exclusive benchmark harness.

export const DEFAULT_BENCHMARK_CONFIGS = Object.freeze([
  { name: 'production', conditions: [] },
]);

function applyConfig(adapters, config) {
  const applied = [];
  try {
    for (const conditionName of config.conditions ?? []) applied.push(applyCondition(adapters, conditionName));
  } catch (error) {
    for (const condition of applied.reverse()) condition.restore();
    throw error;
  }
  return {
    config: config.name,
    applied: applied.map((condition) => ({ condition: condition.condition, available: condition.available, applied: condition.applied ?? null })),
    restore() {
      for (const condition of [...applied].reverse()) condition.restore();
    },
  };
}

function createMeasurement(adapter, configName) {
  return {
    backend: adapter.label,
    backendKind: adapter.backend,
    config: configName,
    samplesMs: [],
    roundMedians: [],
    sustainedWallMs: [],
    sustainedGpuMs: [],
  };
}

/**
 * Exclusive GPU timing of the integrated pipeline. Per-frame GPU timings and whole-frame sustained timings
 * are measured and reported separately. One config is measured at a time, with warm-up frames, repeated
 * alternating rounds, disjoint/invalid timestamp rejection and full state restoration in `finally`.
 */
export async function benchmarkPipeline(managers, {
  samples = 24,
  rounds = 3,
  warmupFrames = 8,
  sustainedFrames = 30,
  resolutions = [DEFAULT_RESOLUTION],
  pixelRatio = 1,
  configs = DEFAULT_BENCHMARK_CONFIGS,
  animate = true,
  maxGpuRoundSpread = 0.25,
  maxSustainedRoundSpread = 0.35,
  signal,
  onProgress = (stage, detail) => console.info('WebGPU pipeline benchmark', stage, detail ?? ''),
} = {}) {
  checkAbort(signal, 'startup');
  if (!Array.isArray(managers) || managers.length === 0) throw new ValidationError('managers', 'benchmarkPipeline needs at least one manager');
  if (!Array.isArray(configs) || configs.length === 0) throw new ValidationError('configs', 'benchmarkPipeline needs at least one config');
  if (!Number.isInteger(samples) || samples < 2) throw new ValidationError('samples', `samples must be an integer >= 2, received ${String(samples)}`);
  if (!Number.isInteger(rounds) || rounds < 2) throw new ValidationError('rounds', `rounds must be an integer >= 2 so disjoint rounds can be rejected, received ${String(rounds)}`);
  if (!Number.isInteger(warmupFrames) || warmupFrames < 1) throw new ValidationError('warmup', `warmupFrames must be an integer >= 1, received ${String(warmupFrames)}`);
  if (!Number.isInteger(sustainedFrames) || sustainedFrames < 2) throw new ValidationError('sustained', `sustainedFrames must be an integer >= 2, received ${String(sustainedFrames)}`);
  const adapters = managers.map((manager, index) => createPipelineAdapter(manager, { label: manager?.label ?? `manager${index}` }));
  if (new Set(adapters.map((adapter) => adapter.backend)).size !== adapters.length) {
    throw new ValidationError('duplicate-backend', `benchmarkPipeline needs distinct backends, received ${adapters.map((adapter) => `${adapter.label}=${adapter.backend}`).join(', ')}`);
  }
  const lock = acquireExclusiveGpuLock(globalThis, 'webgpu-pipeline-benchmark');
  const result = {
    scope: 'integrated full pipeline, whole-frame GPU time and sustained throughput, reported separately',
    methodology: {
      isolation: 'one config at a time; production rAF loop stopped and verified quiescent; page-wide exclusive GPU lock; no concurrent GPU work',
      gpuTiming: 'per-frame isolated pipeline execution with a fenced queue drain per sample (WebGL EXT_disjoint_timer_query_webgl2 + fenceSync polling, never gl.finish(); WebGPU timestamp-query resolve after queue.onSubmittedWorkDone)',
      sustained: 'back-to-back submissions for a whole-frame batch with a single drain; wall clock per submitted frame, reported apart from the per-frame GPU timings and not as vsync/FPS behaviour',
      excluded: `${warmupFrames} warm-up frames per round, pipeline.compile() when available, asset uploads and all readbacks are outside timed samples`,
      rounds: `${samples} samples x ${rounds} alternating rounds; round medians must agree or the measurement is rejected`,
      noProbeSpeedups: 'these are whole-pipeline numbers; geometry-probe stage timings are not comparable',
    },
    environment: null,
    backends: [],
    capabilities: [],
    runs: [],
    notes: [],
    errors: [],
    restoreFailures: [],
  };
  const savedErrors = { adapters: [] };
  let failure = null;
  try {
    result.environment = await collectEnvironment();
    result.backends = adapters.map((adapter) => adapter.describe());
    onProgress('environment', result.environment);
    if (new Set(configs.map((config) => config.name)).size !== configs.length) {
      throw new ValidationError('configs', `Benchmark config names must be unique, received ${configs.map((config) => config.name).join(', ')}`);
    }
    result.capabilities = adapters.map((adapter) => ({ label: adapter.label, ...adapter.timingCapability() }));
    for (const adapter of adapters) {
      adapter.saved = saveManagerState(adapter);
      adapter.parts = collectParts(adapter.manager.model);
    }
    const gpuDevice = adapters.find((adapter) => adapter.backend === 'webgpu')?.manager.renderer.backend?.device;
    if (gpuDevice?.addEventListener) {
      const onUncaptured = (event) => result.errors.push(event.error?.message ?? 'uncaptured WebGPU error');
      gpuDevice.addEventListener('uncapturederror', onUncaptured);
      savedErrors.adapters.push({ device: gpuDevice, listener: onUncaptured });
    }
    for (const adapter of adapters) await pauseProductionLoop(adapter, signal);
    for (const adapter of adapters) await adapter.drain(signal);
    onProgress('paused production loops');
    result.notes.push(`Sustained timings use ${sustainedFrames} back-to-back submissions per round and are not interchangeable with the per-frame GPU timings.`);
    if (adapters.some((adapter) => adapter.backend === 'webgpu')) {
      result.notes.push('WebGPU per-frame durations come from Three\'s timestamp pool and are quantized on some browsers; compare round medians, not individual samples.');
    }
    for (const resolution of resolutions) {
      if (!Array.isArray(resolution) || resolution.length !== 2 || !Number.isInteger(resolution[0]) || !Number.isInteger(resolution[1]) || resolution[0] < 1 || resolution[1] < 1) {
        throw new ValidationError('resolution', `Invalid benchmark resolution ${JSON.stringify(resolution)}`);
      }
      for (const adapter of adapters) adapter.resize(resolution[0], resolution[1], pixelRatio);
      const sizes = assertSharedOutputSize(adapters, resolution[0], resolution[1], pixelRatio);
      onProgress('resolution', `${resolution[0]}x${resolution[1]} -> ${sizes[0].width}x${sizes[0].height}`);
      // Explicitly exclude shader compilation from timed samples when the pipeline can compile up front.
      for (const adapter of adapters) {
        if (typeof adapter.manager.pipeline.compile === 'function') {
          checkAbort(signal, 'compile');
          await adapter.manager.pipeline.compile();
        }
      }
      const measurements = new Map();
      for (let round = 0; round < rounds; ++round) {
        const configOrder = round % 2 ? [...configs].reverse() : [...configs];
        const adapterOrder = round % 2 ? [...adapters].reverse() : [...adapters];
        for (const config of configOrder) {
          checkAbort(signal, `round ${round + 1} config ${config.name}`);
          const applied = applyConfig(adapters, config);
          try {
            for (const adapter of adapterOrder) {
              const key = `${config.name}|${adapter.label}`;
              if (!measurements.has(key)) measurements.set(key, createMeasurement(adapter, config.name));
              const measurement = measurements.get(key);
              onProgress('measure', `${adapter.label} ${config.name} round ${round + 1}`);
              adapter.resetHistory();
              const poseRotation = (index) => {
                if (!animate) return;
                adapter.manager.model.quaternion.copy(adapter.saved.model.quaternion);
                adapter.manager.model.rotateOnAxis(adapter.manager.model.up, (index / samples) * Math.PI * 2);
              };
              for (let i = 0; i < warmupFrames; ++i) {
                checkAbort(signal, 'warmup');
                poseRotation(i);
                await adapter.renderFrame(signal);
              }
              await adapter.drain(signal);
              const roundSamples = [];
              for (let i = 0; i < samples; ++i) {
                checkAbort(signal, `sample ${i + 1}`);
                poseRotation(i);
                roundSamples.push(await adapter.measureFrameGpuMs(() => adapter.manager.pipeline.render(), signal));
              }
              const roundStats = timingStats(roundSamples, { label: `${adapter.label} ${config.name} round ${round + 1}`, minimumSamples: 2 });
              measurement.samplesMs.push(...roundSamples);
              measurement.roundMedians.push(roundStats.medianMs);
              // Sustained whole-frame throughput, measured after the isolated samples, also warm.
              adapter.resetHistory();
              for (let i = 0; i < warmupFrames; ++i) {
                checkAbort(signal, 'sustained warmup');
                poseRotation(i);
                await adapter.renderFrame(signal);
              }
              await adapter.drain(signal);
              const sustained = await adapter.measureSustainedBatch(sustainedFrames, (index) => {
                poseRotation(index);
                adapter.manager.pipeline.render();
              }, signal);
              measurement.sustainedWallMs.push(sustained.wallMsPerFrame);
              if (Number.isFinite(sustained.gpuMsPerFrame)) measurement.sustainedGpuMs.push(sustained.gpuMsPerFrame);
              measurement.sustainedMethod = sustained.method;
              onProgress('round', { backend: adapter.label, config: config.name, medianMs: roundStats.medianMs, wallMsPerFrame: sustained.wallMsPerFrame });
            }
          } finally {
            applied.restore();
          }
        }
      }
      for (const measurement of measurements.values()) {
        checkAbort(signal, `finalize ${measurement.backend} ${measurement.config}`);
        const adapter = adapters.find((entry) => entry.label === measurement.backend);
        const gpu = timingStats(measurement.samplesMs, { label: `${measurement.backend} ${measurement.config}`, minimumSamples: 2 });
        // Throws ValidationError('timing-disjoint') when the alternating rounds disagree.
        const stability = roundStability(measurement.roundMedians, { label: `${measurement.backend} ${measurement.config}`, maxRelativeSpread: maxGpuRoundSpread });
        const sustained = sustainedStats(measurement.sustainedWallMs, { label: `${measurement.backend} ${measurement.config} sustained` });
        const sustainedStability = roundStability(measurement.sustainedWallMs, { label: `${measurement.backend} ${measurement.config} sustained`, maxRelativeSpread: maxSustainedRoundSpread });
        // Timed work is complete: validity capture, draw stats and introspection happen outside timing.
        const capture = await adapter.capture(signal);
        const outputStats = assertCaptureContent(captureStats(capture), { label: `${measurement.backend} ${measurement.config}`, minimumLitFraction: 0.002, maximumLitFraction: 1 });
        const draws = { ...adapter.measureDrawStats(signal), sceneTriangles: sceneTriangles(adapter.manager.model) };
        if (!(draws.calls > 0) || !(draws.triangles > 0)) {
          throw new ValidationError('draw-stats', `${measurement.backend} ${measurement.config}: submitted ${draws.calls} draw calls / ${draws.triangles} triangles; the benchmarked frame drew nothing`);
        }
        if (draws.triangles < draws.sceneTriangles) {
          throw new ValidationError('incomplete-draw', `${measurement.backend} ${measurement.config}: submitted ${draws.triangles} triangles, fewer than the ${draws.sceneTriangles} scene triangles`);
        }
        result.runs.push({
          resolution,
          outputSize: sizes[0],
          config: measurement.config,
          backend: measurement.backend,
          backendKind: measurement.backendKind,
          gpu,
          gpuRoundMediansMs: measurement.roundMedians,
          gpuRoundStability: stability,
          sustained,
          sustainedGpuMsPerFrame: measurement.sustainedGpuMs.length > 0 ? timingStats(measurement.sustainedGpuMs, { label: `${measurement.backend} sustained GPU` }) : null,
          sustainedMethod: measurement.sustainedMethod,
          sustainedRoundStability: sustainedStability,
          output: outputStats,
          draws,
        });
      }
    }
    if (result.errors.length > 0) throw new ValidationError('gpu-error', `WebGPU reported errors during the benchmark: ${result.errors.join('; ')}`);
    onProgress('result', result.runs);
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    for (const entry of savedErrors.adapters) if (entry.device) entry.device.removeEventListener('uncapturederror', entry.listener);
    for (const adapter of adapters) result.restoreFailures.push(...restoreManagerState(adapter));
    lock.release();
    if (result.restoreFailures.length > 0) {
      onProgress('restore-failed', result.restoreFailures);
      if (!failure) throw new ValidationError('restore-failed', `State restoration failed: ${result.restoreFailures.join(' | ')}`);
      failure.restoreFailures = result.restoreFailures;
    }
  }
}
