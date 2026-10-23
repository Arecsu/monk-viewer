// Dev-only regression/GPU checks, run from aa-lab.html. Compares against the unmodified library BloomEffect.
import { BloomEffect } from 'postprocessing';
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));

function comparison(mgr) {
  const pass = mgr.pipeline.passes.find(p => p.effects);
  const originalEffects = [...pass.effects], optimized = originalEffects[0];
  const stock = new BloomEffect({ luminanceThreshold: optimized.luminanceThreshold,
    luminanceSmoothing: optimized.luminanceSmoothing, intensity: optimized.intensity,
    radius: optimized.mipmapBlurPass.radius, levels: optimized.mipmapBlurPass.levels,
    fullResolutionUpsampling: optimized.mipmapBlurPass.fullResolutionUpsampling,
    clampToBorder: optimized.mipmapBlurPass.clampToBorder });
  return {
    optimized, stock,
    select(effect) {
      pass.effects = [effect, ...originalEffects.slice(1)];
      effect.input.defaultBuffer = pass.input.defaultBuffer;
    },
    dispose() { pass.effects = originalEffects; stock.dispose(); },
  };
}

export async function validateBloom(mgr, THREE, { start = 0, end = Infinity, frames = 32 } = {}) {
  const { renderer, model, camera, taa, scene } = mgr, gl = renderer.getContext(), pair = comparison(mgr);
  const b = pair.optimized, saved = {
    rendering: mgr.isRendering, position: model.position.clone(), rotation: model.quaternion.clone(),
    cameraPosition: camera.position.clone(), cameraRotation: camera.quaternion.clone(), aspect: camera.aspect,
    ratio: renderer.getPixelRatio(), background: scene.background, fog: scene.fog,
    taaEnabled: taa.enabled, taaBounds: taa.backgroundFastPath, msaa: mgr.geometryPass.samples,
    radius: b.mipmapBlurPass.radius, levels: b.mipmapBlurPass.levels,
    fullUp: b.mipmapBlurPass.fullResolutionUpsampling, scale: b.resolution.scale,
  };
  const reset = bloom => {
    taa.enabled = saved.taaEnabled; taa.backgroundFastPath = saved.taaBounds;
    mgr.geometryPass.samples = saved.msaa;
    model.position.copy(saved.position); model.quaternion.copy(saved.rotation);
    camera.position.copy(saved.cameraPosition); camera.quaternion.copy(saved.cameraRotation);
    camera.aspect = saved.aspect; camera.updateProjectionMatrix();
    scene.background = saved.background; scene.fog = saved.fog;
    pair.select(bloom);
    bloom.mipmapBlurPass.radius = saved.radius; bloom.mipmapBlurPass.levels = saved.levels;
    bloom.mipmapBlurPass.fullResolutionUpsampling = saved.fullUp; bloom.resolution.scale = saved.scale;
    mgr.updateRendererSize(900, 600, saved.ratio); taa.reset();
  };
  const cases = [
    ['still', () => {}],
    ['model rotation', i => { model.quaternion.copy(saved.rotation); model.rotateY(i * Math.PI * 2 / frames); }],
    ['camera orbit', i => { camera.position.set(Math.sin(i / 8) * 0.8, 0.15, Math.cos(i / 8) * 0.8); camera.lookAt(0, 0, 0); }],
    ['off-screen pan', i => { model.position.x = saved.position.x + Math.sin(i / 8) * 1.2; }],
    ['near-plane crossing', () => { camera.position.set(0, 0, 0.025); camera.lookAt(0, 0, 0); }],
    ['portrait resize + DPR', i => { if(i === frames / 2) { mgr.updateRendererSize(500, 750, 1.5); camera.aspect = 2 / 3; camera.updateProjectionMatrix(); } }],
    ['odd render dimensions', i => { if(i === 0) { mgr.updateRendererSize(901, 601, 1); camera.aspect = 901 / 601; camera.updateProjectionMatrix(); } }],
    ['tiny render dimensions', i => { if(i === 0) { mgr.updateRendererSize(37, 25, 1); camera.aspect = 37 / 25; camera.updateProjectionMatrix(); } }],
    ['half-resolution bloom', (i, bloom) => { if(i === 0) bloom.resolution.scale = 0.5; }],
    ['upsized bloom', (i, bloom) => { if(i === 0) bloom.resolution.scale = 1.5; }],
    ['multi-scale support blending', (i, bloom) => { if(i === 0) bloom.mipmapBlurPass.radius = 0.85; }],
    ['four bloom levels', (i, bloom) => { if(i === 0) bloom.mipmapBlurPass.levels = 4; }],
    ['ten bloom levels', (i, bloom) => { if(i === 0) bloom.mipmapBlurPass.levels = 10; }],
    ['full-resolution upsampling', (i, bloom) => { if(i === 0) bloom.mipmapBlurPass.fullResolutionUpsampling = true; }],
    ['TAA disabled', i => { if(i === 0) taa.enabled = false; }],
    ['TAA bounds disabled', i => { if(i === 0) taa.backgroundFastPath = false; }],
    ['coloured background', i => { if(i === 0) scene.background = new THREE.Color(0x223344); }],
    ['fog', i => { if(i === 0) scene.fog = new THREE.Fog(0x000000, 0.1, 2); }],
    ['MSAA disabled', i => { if(i === 0) mgr.geometryPass.samples = 0; model.quaternion.copy(saved.rotation); model.rotateY(i / 8); }],
  ];
  const results = [];
  mgr.isRendering = false;
  await frame();
  try {
    for(const [name, pose] of cases.slice(start, end)) {
      const images = [];
      for(const bloom of [pair.stock, b]) {
        reset(bloom);
        const captures = [];
        for(let i = 0; i < frames; ++i) {
          pose(i, bloom);
          await frame(); mgr.pipeline.render();
          if(i % 8 === 7) {
            const pixels = new Uint8Array(renderer.domElement.width * renderer.domElement.height * 4);
            gl.readPixels(0, 0, renderer.domElement.width, renderer.domElement.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            captures.push(pixels);
          }
        }
        images.push(captures);
      }
      let max = 0, sum = 0, count = 0;
      for(let i = 0; i < images[0].length; ++i) {
        const a = images[0][i], c = images[1][i];
        if(a.length !== c.length) throw Error(`${name}: size mismatch`);
        for(let j = 0; j < a.length; ++j) if(j % 4 !== 3) {
          const d = Math.abs(a[j] - c[j]); max = Math.max(max, d); sum += d; ++count;
        }
      }
      const result = { name, maxDifference8bit: max, meanDifference8bit: sum / count };
      results.push(result); console.info('Bloom regression', result);
      if(max !== 0) throw Error(`Bloom pixel regression: ${JSON.stringify(result)}`);
    }
    return results;
  } finally {
    reset(b); pair.dispose(); mgr.isRendering = saved.rendering;
    if(saved.rendering) mgr.startRenderLoop();
  }
}

export async function benchmarkBloom(mgr, { pixelRatio = 1, samples = 40, rounds = 3, rotating = false } = {}) {
  const { renderer, taa, model } = mgr, gl = renderer.getContext(), timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if(!timer) throw Error('GPU timer queries unavailable');
  const pair = comparison(mgr), saved = { rendering: mgr.isRendering, ratio: renderer.getPixelRatio(), rotation: model.quaternion.clone() };
  const groups = [pair.stock, pair.optimized].map(bloom => ({ bloom, times: [] })), outstanding = new Set();
  const render = () => { if(rotating) { model.quaternion.copy(saved.rotation); model.rotateY(taa.frame * Math.PI / 180); } mgr.pipeline.render(); };
  mgr.isRendering = false; await frame();
  try {
    mgr.updateRendererSize(900, 600, pixelRatio);
    for(let round = 0; round < rounds; ++round) for(const k of round % 2 ? [1, 0] : [0, 1]) {
      pair.select(groups[k].bloom); taa.reset();
      for(let i = 0; i < 16; ++i) { await frame(); render(); }
      const queries = [];
      for(let i = 0; i < samples; ++i) {
        await frame(); const q = gl.createQuery(); outstanding.add(q); queries.push(q);
        gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
        try { render(); } finally { gl.endQuery(timer.TIME_ELAPSED_EXT); }
      }
      let waits = 0;
      while(!gl.getQueryParameter(queries.at(-1), gl.QUERY_RESULT_AVAILABLE)) {
        if(gl.isContextLost() || ++waits > 300) throw Error('GPU query timed out'); await frame();
      }
      if(gl.getParameter(timer.GPU_DISJOINT_EXT)) throw Error('GPU disjoint: discard and rerun');
      for(const q of queries) { groups[k].times.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(q); outstanding.delete(q); }
    }
    return groups.map(({ bloom, times }) => {
      times.sort((a,b) => a-b);
      return { bloom: bloom === pair.stock ? 'stock' : 'bounded', size: [renderer.domElement.width, renderer.domElement.height],
        samples: times.length, medianGpuMs: times[Math.floor(times.length / 2)],
        p10: times[Math.floor(times.length * 0.1)], p90: times[Math.floor(times.length * 0.9)] };
    });
  } finally {
    outstanding.forEach(q => gl.deleteQuery(q)); pair.dispose(); model.quaternion.copy(saved.rotation);
    mgr.updateRendererSize(900, 600, saved.ratio); taa.reset(); mgr.isRendering = saved.rendering;
    if(saved.rendering) mgr.startRenderLoop();
  }
}
