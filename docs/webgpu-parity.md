# Native WebGPU: measured parity and performance

All numbers were produced on this machine (MacBook Air M1, 7-core GPU, Chrome, native WebGPU/Metal adapter), with the
production settings (4× MSAA, TAA modern preset, motion blur, 8-level bloom, GT7 grade, dithering, SMAA off, grazing
clamp off, specular AA on), **one measured condition per fresh session**. The machine-readable form of every row is in
[`tests/fixtures/webgpu-parity-m1.json`](../tests/fixtures/webgpu-parity-m1.json).

## What the statistic is, and what it is not

The comparison reads both presented frames — the WebGL reference canvas through `readPixels` (sRGB codes), the native
`rgba16float` display-linear target through the sRGB transfer function — and reports differences in **sRGB code steps
(0…255)**. Code space is used deliberately: it is the domain in which a step is perceptible, and it makes the dither
phase difference visible as what it is, a one-step per-pixel difference.

This is **not** the statistic the validation harness gates on. `tests/webgpu-validation-utils.js` gates in
display-linear light with `DISPLAY_TOLERANCE` (whole-frame visible fraction ≤ 6%) and `STILL_TOLERANCE` (≤ 0.2%). The
rows below **do not satisfy those gates** — the full chain reports 11.5% of pixels differing by more than 2 code steps,
essentially all of them dither phase and the last bloom-halo step. Anyone claiming "parity within the frozen
tolerances" for this port is quoting the wrong column; the honest statement is the per-statistic one in these tables,
and the harness gate still needs either a dither-off condition or a block-averaged visible-fraction statistic before it
can certify the production chain.

## Final image parity, still frames after 48 frames, 900×600

| Toggles | Mean | Worst | Pixels > 2 steps | Flat outliers | Flat RMSE | Edge mean | Coverage Δ |
|---|---:|---:|---:|---:|---:|---:|---:|
| geometry + glass + GT7 only | 0.40 | 56 | 0.53% | 0 | 0.39 | 0.56 | +0.20% |
| + TAA | 0.41 | 15.8 | 0.83% | 0 | 0.39 | 0.64 | +0.25% |
| + TAA + dither | 0.56 | 16.5 | 9.77% | 0 | 0.79 | 0.56 | +0.27% |
| + TAA + bloom | 0.40 | 16.0 | 1.26% | 0 | 0.42 | 0.94 | −0.92% |
| full chain | 0.69 | 15.9 | 11.5% | 0.001% | 0.85 | 0.72 | −1.05% |

The rows are **not cumulative**: each disables the named stages relative to the full chain, so "+ TAA + bloom" still has
dithering off. Flat surfaces agree to well under one code step (flat RMSE 0.85 for the full chain, 0.001% of flat
channels beyond four steps). The large "pixels > 2 steps" figure is dominated by dithering's per-pixel noise phase —
adding dither alone moves the row from 0.83% to 9.77% while flat outliers stay at zero and flat RMSE stays under one
step. Worst-case outliers sit on the thin high-contrast edge of the glass streak.

## TAA over time (TAA + GT7 only)

| Frames | Mean | Worst | Pixels > 2 steps | Flat outliers | Flat RMSE |
|---:|---:|---:|---:|---:|---:|
| 1 | 0.41 | 43.8 | 1.06% | 0 | 0.39 |
| 4 | 0.41 | 28.1 | 0.96% | 0 | 0.39 |
| 16 | 0.41 | 15.8 | 0.84% | 0 | 0.39 |
| 48 | 0.41 | 15.8 | 0.83% | 0 | 0.39 |

The transient edge difference shrinks from 43.8 to 15.8 worst-case steps between 1 and 16 frames and then **plateaus**:
a residual of 0.83% of pixels, ~16 steps worst case, persists at 48 frames. This is cross-backend agreement over time,
not a per-backend convergence proof, and it is not claimed to vanish. The harness has a real per-backend convergence
check (`convergenceStats`); its result is not yet recorded here.

## Motion, size and preset cases

| Case | Mean | Worst | Flat outliers | Flat RMSE | Coverage Δ |
|---|---:|---:|---:|---:|---:|
| rotation, 900×600, 24 frames | 0.62 | 41.1 | 0.67% | 1.08 | 0.00% |
| independent clips, 900×600, 24 frames | 0.70 | 80.7 | 0.001% | 0.85 | −1.03% |
| odd 901×601, rotation | 0.98 | 77.8 | 0.30% | 1.08 | +0.01% |
| tiny 37×25 | 1.06 | 20.7 | 0 | 1.09 | +1.30% |
| portrait 500×750 | 1.06 | 16.5 | 0.041% | 1.12 | −2.26% |
| TAA off, rotation | 0.65 | 238 | 0.948% | 1.02 | 0.00% |
| motion blur off, rotation | 0.75 | 195 | 1.505% | 1.11 | −0.05% |
| Reinhard preset, rotation | 0.77 | 131 | 0.182% | 0.68 | −0.75% |
| MSAA off, rotation | 1.98 | 172 | 5.634% | 4.69 | −0.77% |

MSAA off is **not a like-for-like pair**: in the WebGL reference `msaaSamples = 0` also removes the resolve pass, so
the glass is never composited on the decoded colour. The two frames are expected to differ; this is a reference-path
quirk, not a native regression. Widest outliers in the other rows are on thin bright edges (MSAA and TAA shape them
differently) and are one to a few pixels per case.

## Performance

See [`docs/webgpu-performance.md`](webgpu-performance.md) for the protocol and the current numbers. Summary of what is
and is not measured:

* Whole-pipeline sustained throughput at 900×600 and 1800×1200: native 1.73× and 1.95× the reference (dual-renderer
  sessions, stable). Round spread was not published and must be before this is quoted as a headline.
* 1920×1080, native only: 3.93 ms/frame (254 fps throughput) after the two full-resolution pass cuts; the
  geometry+glass+GT7 baseline is 2.16 ms.
* **Full-viewport 3360×1866 whole-pipeline comparison is not measured.** A dual-renderer run at that size froze the
  tab repeatedly; the isolated geometry-stage probe (13.67 ms WebGL vs 0.92–2.88 ms native) is not a whole-viewer
  number and is not quoted as one.
* Isolated per-frame WebGPU timestamps from the harness are **not usable**: they disagree with sustained throughput by
  ~11× (61.9 ms vs 5.5 ms at 1800×1200). The cause is not established; the earlier explanation ("measures drain
  latency") is wrong. Only sustained throughput is used, and the harness records no `gpuNotComparable` flag yet, so
  anyone reading the raw JSON must ignore `gpu.medianMs` for WebGPU until that is fixed.

## Not measured

Camera orbit (the driver's orbit pose was a no-op and is not yet re-measured), near-plane crossing, mid-sequence resize,
non-1 DPR in the parity matrix, SMAA on (its shader failed to compile on device, was reworked afterwards, and is not yet
re-verified), real device loss, and the full-viewport whole-pipeline comparison above.
