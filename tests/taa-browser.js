// Dev-only browser checks. From aa-lab.html's console:
// const checks = await import('/monk-viewer/tests/taa-browser.js');
// await checks.validateTaa(window.mgr, window.THREE);
// await checks.benchmarkTaa(window.mgr);
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/** Compare actual display pixels with/without bounds; never replace any model materials. */
export async function validateTaa(mgr, THREE) {
  const { renderer, camera, model, scene, taa } = mgr;
  const gl = renderer.getContext();
  const saved = {
    rendering: mgr.isRendering, background: scene.background, fog: scene.fog,
    cameraPosition: camera.position.clone(), cameraRotation: camera.quaternion.clone(), cameraAspect: camera.aspect,
    modelPosition: model.position.clone(), modelRotation: model.quaternion.clone(),
    fastPath: taa.backgroundFastPath, clamp: taa.clampHistory, samples: mgr.geometryPass.samples,
    pixelRatio: renderer.getPixelRatio(),
  };
  const reset = () => {
    scene.background = saved.background;
    scene.fog = saved.fog;
    camera.position.copy(saved.cameraPosition);
    camera.quaternion.copy(saved.cameraRotation);
    camera.aspect = saved.cameraAspect;
    camera.updateProjectionMatrix();
    model.position.copy(saved.modelPosition);
    model.quaternion.copy(saved.modelRotation);
    taa.clampHistory = saved.clamp;
    mgr.geometryPass.samples = saved.samples;
    mgr.updateRendererSize(renderer.domElement.clientWidth, renderer.domElement.clientHeight, saved.pixelRatio);
    taa.reset();
  };
  const fullBounds = () => taa.fullscreenMaterial.uniforms.backgroundBounds.value.toArray().every(
    (v, i) => v === [0, 0, 1, 1][i]);
  const cases = [
    { name: 'still', pose: () => {} },
    { name: 'model rotation', pose: (i) => { model.quaternion.copy(saved.modelRotation); model.rotateY(i * Math.PI / 32); } },
    { name: 'camera orbit', pose: (i) => { camera.position.set(Math.sin(i / 10) * 0.8, 0.12, Math.cos(i / 10) * 0.8); camera.lookAt(0, 0, 0); } },
    { name: 'panning off-screen', pose: (i) => { model.position.x = saved.modelPosition.x + Math.sin(i / 10) * 1.2; } },
    { name: 'near-plane crossing', pose: () => { camera.position.set(0, 0, 0.025); camera.lookAt(0, 0, 0); }, fallback: true },
    { name: 'resize + DPR change', pose: (i) => { if(i === 32) { mgr.updateRendererSize(500, 750, 1.5); camera.aspect = 2 / 3; camera.updateProjectionMatrix(); } } },
    { name: 'coloured background', pose: () => { scene.background = new THREE.Color(0x223344); }, fallback: true },
    { name: 'fog', pose: () => { scene.fog = new THREE.Fog(0x000000, 0.1, 2); }, fallback: true },
    { name: 'unclamped history', pose: (i) => { taa.clampHistory = false; model.quaternion.copy(saved.modelRotation); model.rotateY(i / 10); }, fallback: true },
    { name: 'without MSAA', pose: (i) => { mgr.geometryPass.samples = 0; model.quaternion.copy(saved.modelRotation); model.rotateY(i / 10); } },
  ];
  const results = [];
  mgr.isRendering = false;
  await nextFrame(); // Let the previously scheduled viewer loop stop.
  try {
    for(const scenario of cases) {
      const captures = [];
      for(const fastPath of [false, true]) {
        reset();
        taa.backgroundFastPath = fastPath;
        const frames = [];
        for(let i = 0; i < 64; ++i) {
          scenario.pose(i);
          await nextFrame();
          mgr.pipeline.render();
          if(fastPath && scenario.fallback && !fullBounds()) throw new Error(`${scenario.name}: fallback failed`);
          if(i % 8 === 7) {
            const pixels = new Uint8Array(renderer.domElement.width * renderer.domElement.height * 4);
            gl.readPixels(0, 0, renderer.domElement.width, renderer.domElement.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            frames.push(pixels);
          }
        }
        captures.push(frames);
      }
      let max = 0, sum = 0, channels = 0;
      for(let i = 0; i < captures[0].length; ++i) {
        const a = captures[0][i], b = captures[1][i];
        if(a.length !== b.length) throw new Error(`${scenario.name}: size mismatch`);
        for(let j = 0; j < a.length; ++j) {
          if(j % 4 === 3) continue;
          const difference = Math.abs(a[j] - b[j]);
          max = Math.max(max, difference);
          sum += difference;
          ++channels;
        }
      }
      const result = { name: scenario.name, maxDifference8bit: max, meanDifference8bit: sum / channels };
      results.push(result);
      console.info('TAA regression', result);
      if(max > 1) throw new Error(`Pixel regression: ${JSON.stringify(result)}`);
    }
    return results;
  } finally {
    reset();
    taa.backgroundFastPath = saved.fastPath;
    mgr.isRendering = saved.rendering;
    if(saved.rendering) mgr.startRenderLoop();
  }
}

/** Whole-frame GPU time, unaffected by the display's FPS/vsync ceiling. No readPixels or gl.finish in timed frames. */
export async function benchmarkTaa(mgr, { samples = 40, rounds = 3, pixelRatio = 1 } = {}) {
  const gl = mgr.renderer.getContext();
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if(!timer) throw new Error('GPU timer queries are not available on this browser');
  const savedRendering = mgr.isRendering, savedBounds = mgr.taa.backgroundFastPath;
  const savedRatio = mgr.renderer.getPixelRatio();
  const canvas = mgr.renderer.domElement;
  const results = [false, true].map((enabled) => ({ enabled, times: [] }));
  const outstanding = new Set();
  mgr.isRendering = false;
  await nextFrame();
  try {
    mgr.updateRendererSize(canvas.clientWidth, canvas.clientHeight, pixelRatio);
    for(let round = 0; round < rounds; ++round) {
      for(const k of round % 2 ? [1, 0] : [0, 1]) {
        mgr.taa.backgroundFastPath = results[k].enabled;
        mgr.taa.reset();
        for(let i = 0; i < 12; ++i) { await nextFrame(); mgr.pipeline.render(); }
        const queries = [];
        for(let i = 0; i < samples; ++i) {
          await nextFrame();
          const query = gl.createQuery();
          outstanding.add(query);
          queries.push(query);
          gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
          try { mgr.pipeline.render(); } finally { gl.endQuery(timer.TIME_ELAPSED_EXT); }
        }
        let waits = 0;
        while(!gl.getQueryParameter(queries.at(-1), gl.QUERY_RESULT_AVAILABLE)) {
          if(gl.isContextLost() || ++waits > 300) throw new Error('GPU query timed out');
          await nextFrame();
        }
        if(gl.getParameter(timer.GPU_DISJOINT_EXT)) throw new Error('GPU disjoint: discard and rerun this measurement');
        for(const query of queries) {
          results[k].times.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
          gl.deleteQuery(query);
          outstanding.delete(query);
        }
      }
    }
    return results.map(({ enabled, times }) => {
      times.sort((a, b) => a - b);
      return { backgroundFastPath: enabled, samples: times.length,
        resolution: [canvas.width, canvas.height],
        medianGpuMs: times[Math.floor(times.length / 2)],
        p10GpuMs: times[Math.floor(times.length * 0.1)], p90GpuMs: times[Math.floor(times.length * 0.9)] };
    });
  } finally {
    outstanding.forEach((query) => gl.deleteQuery(query));
    mgr.taa.backgroundFastPath = savedBounds;
    mgr.updateRendererSize(canvas.clientWidth, canvas.clientHeight, savedRatio);
    mgr.taa.reset();
    mgr.isRendering = savedRendering;
    if(savedRendering) mgr.startRenderLoop();
  }
}
