# WebGPU geometry-stage experiment

## Status and scope

This is a dev-only experiment, not a WebGPU viewer port. The production renderer, worker, materials, postprocessing passes, dependencies and deployment entry points are unchanged. Importing the browser harness from the existing AA lab tab creates an off-DOM WebGPU canvas; it does not open another tab or window.

The experiment compares opaque forward geometry, encoded HDR color, per-mesh velocity and depth with 4× MSAA. It deliberately does not time glass, reactive masks, TAA, motion blur, bloom, GT7 or presentation. Those effects have not been disabled in a replacement viewer: there is no replacement viewer yet. They are outside this stage measurement.

Implementation: [`src/lab/WebGpuGeometryProbe.js`](../src/lab/WebGpuGeometryProbe.js). Harness: [`tests/webgpu-geometry-browser.js`](../tests/webgpu-geometry-browser.js). The saved M1 measurements and validation output are in [`tests/fixtures/webgpu-geometry-m1.json`](../tests/fixtures/webgpu-geometry-m1.json); that generated result is the measurement source of truth.

## Run in the existing AA lab tab

Start the Vite development server and use the already-open `/monk-viewer/aa-lab.html` tab. Use the modern preset, 4× MSAA, specular AA enabled, grazing clamp disabled, black background, no fog and the per-channel RGB edge-resolve encoding. Keep the tab visible. The first import of `three/webgpu` can cause Vite to optimize a new dependency and reload the page; repeat the console import after that one-time reload.

```js
const checks = await import('/monk-viewer/tests/webgpu-geometry-browser.js');
window.geometryProbeAbort = new AbortController();
window.geometryProbeResults = await checks.compareGeometry(window.mgr, {
  samples: 24,
  rounds: 3,
  signal: geometryProbeAbort.signal,
});
console.table(geometryProbeResults.runs.flatMap(run =>
  run.measurements.map(m => ({
    resolution: run.resolution.join('×'),
    variant: m.variant,
    medianGpuMs: m.gpu.medianMs,
    p10GpuMs: m.gpu.p10Ms,
    p90GpuMs: m.gpu.p90Ms,
  }))));
```

Cancel with `geometryProbeAbort.abort()`. Cleanup restores the viewer's resolution, camera aspect, transforms, temporal history state and rendering loop on success, cancellation or failure. Default resolutions are 900×600 and the current CSS viewport multiplied by native DPR. Explicit `resolutions` and `validationSize` options are also accepted.

### Avoiding concurrent rendering

The harness sets `mgr.isRendering = false`, awaits the pending animation frame, then drains outstanding WebGL work before testing. The visible viewer is frozen during measurement. Its small panel FPS callback can still tick; it does not render the scene. Only one backend is timed at a time, and the full viewer loop resumes in `finally`. Keep other GPU workloads idle and do not run builds/tests concurrently when recording measurements.

## Comparable inputs

- Same cloned model geometry, textures, camera pose and complete rotation sequence. Independent clip translation is exercised during validation.
- Same already-prefiltered environment: the existing WebGL CubeUV PMREM is copied into a CPU-backed texture for WebGPU, avoiding a different environment prefilter.
- Five opaque draws and 16,778 triangles on both backends, checked at each resolution.
- Encoded color: WebGL `R11F_G11F_B10F`, WebGPU `rg11b10ufloat`.
- Velocity: RGBA16F / `rgba16float`, including relative view-depth change in the third channel, not just XY motion.
- Depth: 32-bit float. Actual native WebGPU texture sample counts are checked: 4 for both multisampled color attachments and for depth.
- Modern geometric specular AA is ported to node-material roughness. Existing material maps and physical-material properties are retained.
- The custom RGB encoding is applied before the hardware color resolve, with the current resolve exposure.

Node material cache keys must retain their TSL graph identity. Replacing `NodeMaterial.customProgramCacheKey` with the basic WebGL material implementation incorrectly aliases different meshes' velocity bindings; the prototype deliberately preserves the node-material key.

## Timing method

WebGL uses `EXT_disjoint_timer_query_webgl2`. A GPU fence and asynchronous polling drain the queue after each sample; `gl.finish()` is not used as a synchronization guarantee. Disjoint measurements are rejected. WebGPU uses Three's native timestamp-query pool plus `queue.onSubmittedWorkDone()`. GPU initialization, PMREM transfer, shader compilation, readbacks and validation are outside timed samples.

There are six warm-up renders per variant. Each round measures one complete model revolution, and alternate rounds reverse backend/variant order. The saved run uses 24 samples × 3 rounds, or 72 samples per variant per resolution. Timestamps measure isolated stage execution, not sustained whole-viewer FPS. Polling and queue-drain latency are not included in the GPU duration. WebGPU timestamps on this browser are quantized, so small decimal differences should not be interpreted as fine-grained precision.

The variants are:

1. **WebGL:** existing ClearPass + GeometryPass, including its actual MSAA color/velocity/depth resolves.
2. **WebGPU, store MSAA color:** native per-attachment resolves while retaining multisampled color and depth.
3. **WebGPU, discard MSAA color:** same resolved outputs, but `storeMultisampledColorBuffer = false`. Multisampled depth stays stored and readable.
4. **WebGPU + R32F depth export:** variant 3 plus a full-resolution shader copying depth sample 0 into a single-sample, sampleable R32F color image. This is not a depth-test attachment.
5. **WebGPU + depth-attachment export:** variant 3 plus a full-resolution shader writing depth sample 0 to an actual single-sample depth32float attachment, suitable for subsequent depth testing. The probe conservatively also allocates an unwritten R32F color attachment because Three requires a color attachment on RenderTarget; this is not a custom minimal depth-only backend.

## Measured on this machine

MacBook Air M1, 7-core GPU, Chrome 156, native WebGPU Metal adapter. Median isolated GPU milliseconds from the saved run:

| Variant | 900×600 | 3360×1866 |
|---|---:|---:|
| WebGL | 1.78 | 13.67 |
| WebGPU, store MSAA color | 0.66 | 2.03 |
| WebGPU, discard MSAA color | 0.33 | 0.92 |
| WebGPU + R32F depth export | 0.66 | 2.69 |
| WebGPU + depth-attachment export | 0.66 | 2.88 |

This is strong evidence that a WebGPU port is worth pursuing for this workload. Even the conservative actual-depth-attachment variant is about 4.7× faster for this isolated stage in the saved run. It does **not** establish a 4.7× whole-viewer speedup, nor a pure API-only comparison: WebGPU uses Three's node-material implementation and WebGL uses its existing GLSL implementation. Round-to-round variation and individual outliers are included in the JSON; reproduce on the target browser/OS rather than treating these as universal numbers.

## Output validation and remaining differences

At 900×600, after rigid rotation and independently translating clips:

- Discarding WebGPU's multisampled color changes **zero channels** in the resolved encoded color, velocity or retained depth compared with storing it.
- Exporting depth into the single-sample depth attachment changes **zero depth pixels** relative to reading WebGPU depth sample 0.
- Across 93,823 locally continuous surface pixels, WebGL/WebGPU depth differs by at most approximately `5.96e-8`; velocity differs by at most approximately `1.91e-6` in the stored units.
- Encoded RGB is **not pixel-identical**. Full-image RMSE is approximately `0.000470`; the maximum absolute difference is `0.203125`. Interior maximum difference is `0.0546875`. Non-finite pixel values: zero. These measurements are in encoded RGB, not perceptual display error metrics.

The harness reports broad coverage-interior metrics and stricter continuous-surface metrics separately. A continuous-surface neighborhood excludes internal depth discontinuities independently within each backend, not by requiring their depths to agree; a constant backend depth error would still fail the check. Edge differences are retained in the broad/full-image reports.

WebGPU has no implicit hardware depth resolve equivalent to WebGL's. This prototype explicitly selects sample 0; matching WebGL's implementation-dependent depth behavior at discontinuities remains a porting issue. Node and GLSL material implementations can also differ in shading and rounding. Therefore these stage checks are **not acceptance of identical final image quality**. No production switch should be made on these timing numbers alone.

## Next decision

Proceed with an experimental WebGPU pipeline rather than swapping the production renderer immediately. The next parity work is encoded-color and depth-edge behavior, then glass compositing against the single-sample depth attachment. After that, port the existing TAA algorithm and compare its accumulated output, motion blur, reactive masks and final tone-mapped images against the WebGL reference. Retain a backend fallback until full-frame image regression and sustained frame-time measurements pass.

Relevant upstream references: [Three.js WebGPU migration](https://github.com/mrdoob/three.js/blob/r186/manual/pages/webgpurenderer.html), [render-target storage/depth options](https://github.com/mrdoob/three.js/blob/r186/docs/pages/RenderTarget.html), and [TSL MRT](https://github.com/mrdoob/three.js/blob/r186/src/nodes/core/MRTNode.js).
