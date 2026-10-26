# Full-viewport performance: what is measured, what changed, what is next

## Hard warning about the measurement setup

The whole-pipeline benchmark must run **one renderer per tab**. Creating a second high-resolution renderer (the WebGL
reference) next to the running native one at ≥1280×720 froze the tab three times on this machine (MacBook Air M1), even
with the production loops paused. The frozen runs produced no numbers and must not be counted. Anything below was
measured either with a single renderer in the tab, or with two renderers at 900×600/1800×1200 where that is stable.

Recommended next step for full-viewport numbers: a dedicated benchmark page that owns exactly one renderer, takes the
backend from the query string, renders N frames back to back and drains once — no model/environment duplication, no
post chain in a second context. A skeleton already exists in `tests/webgpu-perf-browser.js::benchmarkCurrent`, which
benchmarks the manager the page already owns.

## What is measured (single renderer unless noted)

Whole-pipeline sustained throughput, production settings, presented frames, back-to-back submission with one drain:

| Size | Backend | ms/frame | fps | Source |
|---|---|---:|---:|---|
| 900×600 | WebGL | 3.25 | 308 | dual-renderer, stable |
| 900×600 | native | 1.88 | 532 | dual-renderer, stable |
| 1800×1200 | WebGL | 10.66 | 94 | dual-renderer, stable |
| 1800×1200 | native | 5.47 | 183 | dual-renderer, stable |
| 1920×1080 | native | 3.93 | 254 | single renderer |
| 1920×1080 | native, all effects off except geometry+glass+GT7 | 2.16 | 463 | single renderer |

Native cost breakdown at 1920×1080 (single renderer, stage switched off one at a time, 2 rounds × 20 frames):

| Stage disabled | Full frame cost removed |
|---|---:|
| TAA | ~0.6–0.9 ms |
| Bloom | ~0.7–1.0 ms |
| Motion blur | ~0.2–0.35 ms |
| Dither (inside the tone pass) | ~0.2–0.5 ms |
| Reactive mask | below noise |
| Everything except geometry+glass+GT7 | 1.77 ms |

Attribution at 1080p is noisy (±0.15 ms) because the whole frame is only ~4 ms; treat the shares as guidance, not
precise per-stage timings. The `dither`/`reactive mask` deltas occasionally came out negative, which is measurement
noise, not a negative cost.

**Full-viewport (3360×1866) whole-pipeline comparison is NOT measured.** The earlier geometry probe measured 13.67 ms
(WebGL) versus 0.92–2.88 ms (native) for the opaque geometry stage at that size, but that is a stage measurement, not
the whole viewer.

## Optimizations shipped in this change

Both remove a full-resolution pass, which is what matters at large sizes:

1. **Decode and depth export are one pass.** Previously a full-screen pass wrote depth sample 0 into the export depth
   attachment and a second full-screen pass wrote the decoded colour. One quad now writes both (`depthWrite` on,
   `depthTest` off, colour and `depthNode` from the same fragment). The exported depth is bit-identical by construction
   — same sample, same shader — and the glass pass still depth-tests against it.
2. **Tone mapping writes straight to the canvas.** Without SMAA the final pass renders to the default framebuffer, so
   there is no presentation copy and no full-resolution display texture. The renderer's output transform is still the
   single sRGB boundary. `pipeline.captureFinal = true` restores the presentable texture for validation tools.

Measured effect at 1920×1080 (single renderer, same protocol): 4.20 → 3.93 ms/frame (~6%), and the
geometry+glass+GT7 baseline 2.56 → 2.16 ms (~15%). At 3360×1866 the saving should be larger, because both changes scale
with pixel count, but that is not measured.

Parity after both changes is unchanged (still frames: mean 0.69 code steps, flat RMSE 0.84 steps; rotation: 0.61 / 1.01).

## Next performance work, in expected-value order

1. **Reactive mask at reduced cost.** It re-draws the transparent objects with an override material. It is cheap on this
   model (below noise) but is a second geometry pass on glass-heavy models. Options: skip it when no transparent mesh
   exists; or render it at half resolution and let TAA's per-pixel read use the filtered value, which changes mask
   precision only on glass silhouettes.
2. **Bloom chain** (~20–25% of the frame). The level plan, filters and reach must stay reference-equal. The remaining
   structural win is to fold the luminance threshold into the first downsample instead of a separate luminance pass at
   ~0.96× resolution — that is a parity risk and needs an image gate before adoption.
3. **TAA** (~15–22%). The 9-tap neighbourhood and the 5-tap history are the algorithm. A cheaper path would key the
   3×3 sample set on the active preset (the legacy preset only needs the cross), which is a quality-preserving win for
   that preset and no win for the default.
4. **Memory at 4K.** Two full-resolution 16-bit targets were removed by the changes above; the remaining large ones are
   the TAA history pair (history + output + state) and the 4× MSAA geometry attachments. A 4K run should be profiled
   with `renderer.info.memory` before and after, and is likely the real constraint on the freeze observed above.
