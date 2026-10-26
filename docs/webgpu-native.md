# Native WebGPU backend

Status: **implemented and rendering end to end, not yet the default.** The WebGL pipeline is untouched and remains the
reference and the fallback. `auto` deliberately keeps selecting WebGL until the acceptance gate is flipped
(`WEBGPU_ACCEPTED` in `src/BackendSelection.js`); this is a product decision, not a bug.

## What runs natively

`src/webgpu/` is a native TSL/node implementation of the whole viewer pipeline. Nothing in it uses WebGL, GLSL
`ShaderMaterial`s or `onBeforeCompile` patches.

| Stage | Module | Notes |
|---|---|---|
| Opaque geometry + velocity | `Geometry.js` | forward shading, encoded HDR (`rg11b10ufloat`) + per-mesh velocity (`rgba16float`), `depth32float`, real 4× MSAA, MSAA colour resolved then discarded, MSAA depth retained |
| Decode + glass + depth export | `Transparency.js` | inverse edge-resolve curves (`linear`/`rgb`/`max`), sample-0 depth exported into a real single-sample `depth32float` attachment, glass composited on it with the authored blend state, reactive facing mask (`r8unorm`) |
| Temporal AA | `TemporalAA.js`, `TemporalAAShader.js` | full reference algorithm: Halton jitter, Gaussian reconstruction, Catmull-Rom history, YCoCg variance/minmax/intersection clamp, clip-towards-current, depth and motion validation, thin-feature locks, edge-adaptive blend, sample confidence, static convergence, debug views, bounded fast path |
| Motion blur | `MotionBlur.js` | separable tile max (never `tileSize²`), neighbour max, McGuire/Jimenez depth-weighted gather, screen-relative reach |
| Bloom / GT7 / dither / SMAA | `PostColor.js`, `PostColorShaders.js`, `SMAA.js` | stock bloom weights and resolution-independent level plan, fused bloom+GT7 chain, exact dithering, SMAA with depth predication |
| Environment | `Environment.js` | gain-map JPEG reconstruction and PMREM with no WebGL renderer anywhere |
| Orchestration | `WebGpuPipeline.js` | pass order, resource ownership, state save/restore, one sRGB presentation |

The repository contract (`docs/webgpu-rendering-contract.md`) fixes formats, coordinate conventions, depth policy and
the component interfaces. The lane history is in `docs/webgpu-lanes.md`.

## Backend selection

```js
chooseBackend('auto')    // webgl + reason "webgpu-acceptance-pending" until WEBGPU_ACCEPTED
chooseBackend('webgpu')  // native, or webgl + reason "webgpu-unavailable"
chooseBackend('webgl')   // reference
```

Observability:

* `<monk-view>` gains a `backend` attribute (`auto` | `webgl` | `webgpu`), a `renderer-backend` attribute with the
  selected backend, a `backendchange` event (`{ requested, selected, phase, reason }`) and a `renderererror` event
  (`{ message, backend, needsCanvasReplacement, recoverable }`). `element.backendStatus` holds the latest status.
* `aa-lab.html` exposes the same switch and prints `selected · phase · reason`.

Native initialization happens on a **staging canvas**: the pipeline is built, rendered once and drained inside a
validation error scope before the user's canvas is bound. A failure therefore falls back to WebGL without ever binding
the visible canvas to a WebGPU context. After a device loss or runtime error the component replaces the canvas (a canvas
cannot change context type, including after transfer to a worker) and restarts on WebGL with the reason attached.

## Differences from the WebGL reference

Deliberate, documented and required by WebGPU:

1. **Glass composite target is `rgba16float`, not `rg11b10ufloat`.** WebGPU forbids blending into `rg11b10ufloat`
   (no `float32-blendable` for 11/11/10), and transparent glass blends. `rgba16float` is strictly more precise.
2. **Reactive mask material uses `NoBlending`.** Three's scene-override path forces `transparent`, and blending is not
   allowed on `r8unorm`. The mask shader writes alpha 1, so the reference's normal blend was already an exact write.
3. **No hardware depth resolve.** Depth sample 0 is exported explicitly into a single-sample `depth32float` attachment
   that both the glass pass and TAA read. Silhouette depth behaviour is therefore our own policy, not the driver's.
4. **Luma dithering has a defined zero-luma branch** instead of dividing 0/0; non-zero luma is unchanged.
5. Samples are logical 4 or 0 (the backend renders 1× or 4×); the auto-tuner's `samples > 0` test still terminates.

Everything else — effects, bloom reach, MSAA, temporal filtering, materials, presets, controls, lifecycle, deploy
prefixes — is preserved.

## Reproduction

```bash
pnpm install
pnpm dev                      # then open /monk-viewer/aa-lab.html?backend=webgpu&fixed=1&smaa=0
pnpm test                     # 126 node tests
pnpm build
```

Browser gates (supervisor-run, from the page console, exclusively; no other GPU work):

```js
// storage/UV helpers, TAA constant-HDR, blur, environment (native device, no viewer required)
const lifecycle = await import('/monk-viewer/tests/webgpu-lifecycle-browser.js');
await lifecycle.validateCommonStorage();
await lifecycle.validateTaaSmoke();
await lifecycle.validateMotionBlurSmoke();
await lifecycle.validateEnvironmentSmoke('https://raw.githubusercontent.com/Arecsu/model-viewer/monk/packages/shared-assets/environments/old_bus_depot_2k_HDR.jpg');
await lifecycle.validateElementLifecycle({ modelUrl, envmapUrl, backend: 'webgpu', worker: true });

// WebGL-vs-native parity and exclusive timings (open the lab with ?backend=webgpu)
const parity = await import('/monk-viewer/tests/webgpu-parity-browser.js');
await parity.measureParity({ ablations: ['geometry+tone'] });   // one ablation per call: clean state each time
await parity.sweepTaa({});
await parity.benchmark({ resolution: [900, 600], rounds: 3 });
```

Measured parity and timings, with method and caveats: `docs/webgpu-parity.md`.

## Known limitations

* `auto` still selects WebGL; `WEBGPU_ACCEPTED` is false pending the acceptance criteria below.
* Isolated per-frame WebGPU timestamps are not comparable to the WebGL timer queries (see the parity report); only
  sustained throughput is used for the performance claim.
* Skinning and morph targets are not carried into motion vectors (the reference has the same limitation).
* A gain-map JPEG with XMP metadata but no MPF image never settles inside the installed extractor; aborts escape it,
  an unaborted load inherits the reference hang.
* The model's glass and opaque meshes are assumed to use standard/physical materials; anything else throws instead of
  rendering incorrectly.

## Acceptance criteria for flipping `auto`

Final-image parity within the frozen tolerances for still, rotation, orbit, independent clips, odd/tiny/portrait sizes,
resize, and every preset/toggle (see the parity report); worker/main-thread/fallback lifecycle gates green; sustained
throughput not worse than the reference on this machine; and fresh independent review with no open blockers.
