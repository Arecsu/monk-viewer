// Run from the EXISTING aa-lab.html tab. No new tabs or visible canvases are created.
// const probe = await import('/monk-viewer/tests/webgpu-geometry-browser.js');
// const controller = new AbortController();
// const results = await probe.compareGeometry(window.mgr, { signal: controller.signal });
import { createWebGpuGeometryProbe, readWebGlAttachment, readWebGpuAttachment } from '../src/lab/WebGpuGeometryProbe.js';
import { timingStats, flipRows, comparePixels, interiorMask } from '../src/lab/geometry-probe-utils.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function waitForGl(gl, check) {
  const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.flush();
  const since = performance.now();
  try {
    while (true) {
      check();
      const value = gl.clientWaitSync(fence, 0, 0);
      if (value === gl.ALREADY_SIGNALED || value === gl.CONDITION_SATISFIED) return;
      assert(value !== gl.WAIT_FAILED && !gl.isContextLost(), 'WebGL fence/context failed');
      assert(performance.now() - since < 10000, 'WebGL GPU fence timed out');
      await delay(1);
    }
  } finally { gl.deleteSync(fence); }
}

/** Resolve the retained multisampled depth to a single-sample R32F texture, if a future consumer needs that. */
async function createDepthExport(probe, depthAttachment = false) {
  const GPU = await import('three/webgpu'), T = await import('three/tsl');
  const target = new GPU.RenderTarget(probe.target.width, probe.target.height, { type: GPU.FloatType, format: GPU.RedFormat, depthBuffer: depthAttachment });
  target.texture.internalFormat = 'r32float';
  const material = new GPU.MeshBasicNodeMaterial();
  const d = T.textureLoad(probe.target.depthTexture, T.ivec2(T.screenCoordinate.xy)).level(0);
  if (depthAttachment) {
    target.depthTexture = new GPU.DepthTexture(target.width, target.height, GPU.FloatType);
    material.depthNode = d;
    material.depthTest = false;
    material.depthWrite = true;
    material.colorWrite = false;
  }
  material.fragmentNode = depthAttachment ? T.vec4(0) : T.vec4(d, 0, 0, 1);
  const quad = new GPU.QuadMesh(material);
  return { target, render: () => { probe.renderer.setMRT(null); probe.renderer.setRenderTarget(target); quad.render(probe.renderer); }, dispose: () => { target.dispose(); material.dispose(); } };
}

/** A stage experiment, NOT a whole-viewer performance or pixel-parity claim. */
export async function compareGeometry(mgr, {
  samples = 24, rounds = 2,
  resolutions = [[900, 600], [Math.floor(mgr.renderer.domElement.clientWidth * devicePixelRatio), Math.floor(mgr.renderer.domElement.clientHeight * devicePixelRatio)]],
  validationSize = [900, 600], signal, onProgress = (stage, result) => console.info('Geometry probe', stage, result ?? ''),
} = {}) {
  assert(Number.isInteger(samples) && samples >= 4 && Number.isInteger(rounds) && rounds >= 1, 'Invalid benchmark sample count');
  assert(mgr.resolvePass?.encoding === 'rgb', 'This prototype implements the RGB encoded resolve only');
  assert(mgr.geometryPass.samples === 4, 'Use the production 4x MSAA configuration');
  assert(mgr.specularAA.enabled && !mgr.grazingClamp.enabled, 'Use modern specular AA with grazing clamp disabled');
  assert(!mgr.scene.fog && mgr.scene.background?.isColor && mgr.scene.background.getHex() === 0, 'Probe requires the lab black background and no fog');
  const r = mgr.renderer, gl = r.getContext(), timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  assert(timer, 'WebGL timer queries unavailable');
  const check = () => {
    if (signal?.aborted) throw new DOMException('Geometry probe cancelled', 'AbortError');
    assert(document.visibilityState === 'visible', 'Keep the existing benchmark tab visible');
  };
  const saved = { rendering: mgr.isRendering, width: r.domElement.clientWidth, height: r.domElement.clientHeight, ratio: r.getPixelRatio(),
    aspect: mgr.camera.aspect, quaternion: mgr.model.quaternion.clone(), autoReset: r.info.autoReset };
  const baseQuaternion = (mgr.initialModelRotation ?? saved.quaternion).clone();
  const result = { scope: 'opaque forward geometry, encoded color + velocity MRT, 4x MSAA and retained depth; no glass or postprocessing', validation: null, runs: [], errors: [] };
  let probe, depthExport, depthAttachmentExport;
  const outstanding = new Set();
  const glMeshes = [], gpuMeshes = [];
  mgr.model.traverse(o => { if (o.isMesh) glMeshes.push({ mesh: o, position: o.position.clone() }); });
  mgr.isRendering = false;
  try {
    await nextFrame(); check(); await waitForGl(gl, check);
    onProgress('initializing');
    probe = await createWebGpuGeometryProbe(mgr, { width: validationSize[0], height: validationSize[1], samples: 4 });
    probe.renderer.backend.device.addEventListener('uncapturederror', event => result.errors.push(event.error.message));
    result.webgpu = probe.metadata;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    result.adapter = { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description };
    probe.model.traverse(o => { if (o.isMesh) gpuMeshes.push({ mesh: o, position: o.position.clone() }); });
    const axis = mgr.model.up.clone();
    const pose = (frame, count, parts = false) => {
      mgr.model.quaternion.copy(baseQuaternion); mgr.model.rotateOnAxis(axis, frame / count * Math.PI * 2);
      probe.model.quaternion.copy(mgr.model.quaternion);
      for (const entries of [glMeshes, gpuMeshes]) for (const { mesh, position } of entries) {
        mesh.position.copy(position);
        if (parts && mesh.name.startsWith('CLIP')) mesh.position.x += Math.sin(frame / 6) * 0.02;
      }
    };
    const resize = (width, height) => {
      assert(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0, 'Invalid resolution');
      mgr.updateRendererSize(width, height, 1);
      mgr.camera.aspect = width / height; mgr.camera.updateProjectionMatrix();
      probe.target.setSize(width, height); probe.renderer.setSize(width, height, false);
      probe.camera.aspect = width / height; probe.camera.updateProjectionMatrix();
      mgr.velocityBuffer.initialized = false; probe.reset();
    };
    const renderGl = () => {
      mgr.velocityBuffer.update(mgr.camera, mgr.camera.projectionMatrix);
      mgr.pipeline.passes[1].render(); // ClearPass, same color/depth/velocity clears as the viewer.
      mgr.geometryPass.render();
    };
    resize(...validationSize);
    onProgress('validating');
    for (let frame = 0; frame <= 2; ++frame) { pose(frame, 180, true); renderGl(); probe.render(); }
    const capture = {};
    for (const [name, attachment] of [['color', 0], ['velocity', 1], ['depth', 'depth']]) {
      check();
      capture[name] = { gl: await readWebGlAttachment(mgr, attachment), gpu: flipRows(await readWebGpuAttachment(probe, attachment), ...validationSize) };
    }
    const mask = interiorMask(capture.depth.gl, capture.depth.gpu, ...validationSize, 2);
    // Reject neighborhoods crossing INTERNAL depth discontinuities as well as the outside silhouette.
    // This does not require cross-backend agreement: a constant depth offset still fails the depth comparison.
    const continuous = interiorMask(capture.depth.gl, capture.depth.gpu, ...validationSize, 2, 0.00005);
    result.validation = { resolution: validationSize, motion: 'rigid rotation plus independently translated clips', interiorPixels: mask.reduce((a, b) => a + b, 0), continuousSurfacePixels: continuous.reduce((a, b) => a + b, 0),
      colorAll: comparePixels(capture.color.gl, capture.color.gpu), colorInterior: comparePixels(capture.color.gl, capture.color.gpu, [0, 1, 2], mask),
      velocityInterior: comparePixels(capture.velocity.gl, capture.velocity.gpu, [0, 1, 2], mask), depthInterior: comparePixels(capture.depth.gl, capture.depth.gpu, [0], mask),
      velocityContinuous: comparePixels(capture.velocity.gl, capture.velocity.gpu, [0, 1, 2], continuous), depthContinuous: comparePixels(capture.depth.gl, capture.depth.gpu, [0], continuous),
      note: 'Color is reported, not declared pixel-identical. WebGPU node BRDF and WebGL GLSL BRDF can differ. Depth compares sample 0 against the WebGL implementation-defined resolve; silhouette/depth-discontinuity errors are reported separately, not claimed equivalent.' };
    onProgress('validation', result.validation);
    assert(Object.values(result.validation).filter(v => v?.nonFinite !== undefined).every(v => v.nonFinite === 0), 'Non-finite validation pixels');
    assert(result.validation.continuousSurfacePixels > 0, 'Empty continuous-surface validation');
    assert(result.validation.velocityContinuous.maxAbs < 0.0001, 'Velocity port failed parity gate; refusing misleading timing results');
    assert(result.validation.depthContinuous.maxAbs < 0.00001, 'Depth port failed continuous-surface parity gate');
    probe.target.storeMultisampledColorBuffer = false;
    probe.reset();
    for (let frame = 0; frame <= 2; ++frame) { pose(frame, 180, true); probe.render(); }
    result.validation.discardColor = {};
    for (const [name, attachment] of [['color', 0], ['velocity', 1], ['depth', 'depth']]) {
      const pixels = flipRows(await readWebGpuAttachment(probe, attachment), ...validationSize);
      const comparison = comparePixels(capture[name].gpu, pixels);
      result.validation.discardColor[name] = comparison;
      assert(comparison.maxAbs === 0 && comparison.nonFinite === 0, `Discarding MSAA color changed ${name}`);
    }
    onProgress('discard-color validation', result.validation.discardColor);
    depthAttachmentExport = await createDepthExport(probe, true);
    depthAttachmentExport.render();
    const exportedDepth = flipRows(await readWebGpuAttachment({ renderer: probe.renderer, target: depthAttachmentExport.target }, 'depth'), ...validationSize);
    result.validation.depthAttachmentExport = comparePixels(capture.depth.gpu, exportedDepth, [0]);
    assert(result.validation.depthAttachmentExport.maxAbs === 0 && result.validation.depthAttachmentExport.nonFinite === 0, 'Depth attachment export changed sample-0 depth');
    for (const resolution of resolutions) {
      resize(...resolution);
      depthExport?.dispose(); depthExport = await createDepthExport(probe);
      depthAttachmentExport?.dispose(); depthAttachmentExport = await createDepthExport(probe, true);
      const variants = [
        { name: 'webgl', gpu: false },
        { name: 'webgpu-store-msaa-color', gpu: true, store: true },
        { name: 'webgpu-discard-msaa-color', gpu: true, store: false },
        { name: 'webgpu-discard-color+depth-export', gpu: true, store: false, exportDepth: true },
        { name: 'webgpu-discard-color+depth-attachment', gpu: true, store: false, exportDepth: true, depthAttachment: true },
      ];
      const collections = variants.map(variant => ({ ...variant, times: [], cpu: [], roundMedians: [] }));
      for (let round = 0; round < rounds; ++round) {
        for (const variant of round % 2 ? [...collections].reverse() : collections) {
          check();
          probe.target.storeMultisampledColorBuffer = variant.store ?? true;
          onProgress(`benchmark ${resolution.join('x')} round ${round + 1}: ${variant.name}`);
          const render = () => {
            if (variant.gpu) { probe.render(); if (variant.exportDepth) (variant.depthAttachment ? depthAttachmentExport : depthExport).render(); }
            else renderGl();
          };
          // Compilation/uploads/previous queue work excluded. Warm each actual pipeline, including the depth export.
          for (let frame = 0; frame < 6; ++frame) { pose(frame, samples); render(); }
          if (variant.gpu) { await probe.renderer.backend.device.queue.onSubmittedWorkDone(); await probe.renderer.resolveTimestampsAsync(); }
          else await waitForGl(gl, check);
          const roundTimes = [];
          for (let frame = 0; frame < samples; ++frame) {
            check(); pose(frame, samples);
            let query;
            if (!variant.gpu) { query = gl.createQuery(); outstanding.add(query); gl.beginQuery(timer.TIME_ELAPSED_EXT, query); }
            const start = performance.now(); render(); variant.cpu.push(performance.now() - start);
            let duration;
            if (variant.gpu) {
              await probe.renderer.backend.device.queue.onSubmittedWorkDone();
              duration = await probe.renderer.resolveTimestampsAsync();
            } else {
              gl.endQuery(timer.TIME_ELAPSED_EXT);
              await waitForGl(gl, check);
              while (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) { check(); await delay(1); }
              assert(!gl.getParameter(timer.GPU_DISJOINT_EXT), 'Disjoint WebGL timestamps; rerun');
              duration = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
              gl.deleteQuery(query); outstanding.delete(query);
            }
            assert(Number.isFinite(duration) && duration > 0, 'Missing GPU timestamp measurement');
            assert(result.errors.length === 0, `WebGPU validation error: ${result.errors.join('; ')}`);
            variant.times.push(duration); roundTimes.push(duration);
          }
          variant.roundMedians.push(timingStats(roundTimes).medianMs);
        }
      }
      const glTarget = mgr.geometryPass.output.defaultBuffer.value;
      const gpuTextures = probe.target.textures.map(texture => probe.renderer.backend.get(texture));
      const gpuFormats = gpuTextures.map(data => data.texture.format);
      const actualMsaaSamples = gpuTextures.map(data => data.msaaTexture?.sampleCount);
      const actualDepthSamples = probe.renderer.backend.get(probe.target.depthTexture).texture.sampleCount;
      assert(gpuFormats[0] === 'rg11b10ufloat' && gpuFormats[1] === 'rgba16float', 'WebGPU target formats changed');
      assert(actualMsaaSamples.every(count => count === 4) && actualDepthSamples === 4, 'WebGPU silently lost 4x MSAA');
      assert(gpuTextures.every(data => data.texture.width === resolution[0] && data.texture.height === resolution[1]), 'WebGPU target size mismatch');
      r.info.autoReset = false; r.info.reset(); renderGl();
      const glDraws = { calls: r.info.render.calls, triangles: r.info.render.triangles };
      probe.renderer.info.reset(); probe.render();
      const gpuDraws = { calls: probe.renderer.info.render.drawCalls, triangles: probe.renderer.info.render.triangles };
      await waitForGl(gl, check); await probe.renderer.backend.device.queue.onSubmittedWorkDone(); await probe.renderer.resolveTimestampsAsync();
      assert(glDraws.calls === gpuDraws.calls && glDraws.triangles === gpuDraws.triangles, 'Backends submitted different geometry');
      const run = { resolution, parameters: { samples, rounds, poses: 'one full rotation per round from initial model rotation', gpuDrainPerSample: true, postprocessingEnabledDuringTiming: false }, formats: { gl: glTarget.textures.map(t => ({ type: t.type, format: t.format, internal: t.internalFormat })), gpu: gpuFormats, actualMsaaSamples, actualDepthSamples }, draws: { gl: glDraws, gpu: gpuDraws },
        measurements: collections.map(v => ({ variant: v.name, gpu: timingStats(v.times), cpuSubmission: timingStats(v.cpu), roundMedians: v.roundMedians })) };
      result.runs.push(run); onProgress('result', run);
    }
    return result;
  } finally {
    outstanding.forEach(q => gl.deleteQuery(q));
    depthExport?.dispose(); depthAttachmentExport?.dispose(); if (probe) await probe.dispose();
    glMeshes.forEach(({ mesh, position }) => mesh.position.copy(position));
    mgr.model.quaternion.copy(saved.quaternion);
    mgr.updateRendererSize(saved.width, saved.height, saved.ratio);
    mgr.camera.aspect = saved.aspect; mgr.camera.updateProjectionMatrix();
    mgr.velocityBuffer.initialized = false; mgr.taa.reset(); r.info.autoReset = saved.autoReset;
    mgr.isRendering = saved.rendering;
    if (saved.rendering) mgr.startRenderLoop();
  }
}
