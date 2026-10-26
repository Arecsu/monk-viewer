# Native WebGPU: measured parity and performance

All numbers below were produced on this machine (MacBook Air M1, Chrome, native WebGPU/Metal adapter) from the
integrated pipeline at commit `7b8abf6`, at 900×600 with pixel ratio 1 unless stated otherwise, with the production
settings (4× MSAA, TAA modern preset, motion blur, 8-level bloom, GT7 grade, dithering, SMAA off, walking clamp off,
specular AA on). The WebGL reference was the unmodified pipeline running in the same page on a second, hidden canvas,
with the same model, environment, camera and pose.

Method: pause both production loops, reset both temporal histories, render 48 identical still frames on each backend
back to back, drain the GPU (WebGL `fenceSync` polling, WebGPU `queue.onSubmittedWorkDone()`), then read the presented
frame from each backend through **one** normalisation: WebGL `readPixels` sRGB codes decoded to display-linear light,
native `rgba16float` display-linear values used as is. Every statistic is computed in that single declared domain and
reported in sRGB code steps (0…255) so it is comparable to what a viewer can see.

Each condition was measured in its **own fresh session** (fresh reference manager, fresh histories). Sequentially
toggling several conditions in one session contaminates later results; that is a property of the measurement driver,
not of the renderer, and the driver now documents it.

## Final-image parity, still frames after 48 frames

| Condition | Mean steps | Worst pixel | Pixels > 2 steps | Flat outlier channels | Flat RMSE | Edge mean | Coverage delta |
|---|---:|---:|---:|---:|---:|---:|---:|
| Geometry + GT7 (no TAA/blur/bloom/dither) | 0.40 | 56 | 0.53% | 0 | 0.39 | 0.56 | +0.20% |
| + TAA | 0.41 | 15.8 | 0.83% | 0 | 0.39 | 0.64 | +0.25% |
| + dithering | 0.56 | 16.5 | 9.77% | 0 | 0.79 | 0.56 | +0.27% |
| + bloom | 0.40 | 16.0 | 1.26% | 0 | 0.42 | 0.94 | −0.92% |
| Full chain | 0.69 | 15.9 | 11.5% | 0.001% | 0.85 | 0.72 | −1.05% |

Reading this: flat surfaces agree to well under one 8-bit step; the full chain's flat RMSE is 0.85 steps with 0.001% of
flat channels beyond four steps. The "pixels > 2 steps" fraction comes almost entirely from dithering (its
per-pixel noise phase differs between the backends, amplitude unchanged) and the bloom halo's last step; those pixels
differ by one to two code steps and are not visible in the side-by-side comparison. Worst-case outliers are on thin
high-contrast edges of the bright glass streak.

TAA convergence sweep (TAA + GT7 only), still frames, same measurement:

| Frames | Mean | Worst | Pixels > 2 steps | Flat outliers | Flat RMSE |
|---:|---:|---:|---:|---:|---:|
| 1 | 0.41 | 43.8 | 1.06% | 0 | 0.39 |
| 4 | 0.41 | 28.1 | 0.96% | 0 | 0.39 |
| 16 | 0.41 | 15.8 | 0.84% | 0 | 0.39 |
| 48 | 0.41 | 15.8 | 0.83% | 0 | 0.39 |

The history converges to the same steady image: the transient edge difference shrinks with accumulated samples instead
of drifting, which is the expected behaviour of two implementations of the same temporal filter with different jitter
phase and sample rounding.

## Performance

Exclusive protocol: the production loops are paused and verified quiescent, the queue is drained, both backends run
`warmupFrames` warm-up frames, then `samples` isolated samples per round over three rounds with alternating backend
order, and a 30-frame sustained batch. No other GPU work ran during the measurement. Sustained throughput is the
comparable metric; isolated WebGPU timestamps are reported but not used for any claim, because
`resolveTimestampsAsync()` behind a per-sample queue drain measures drain-and-submit latency rather than the GPU
duration of a frame (61.9 ms "isolated" against 5.5 ms sustained at 1800×1200 is internally contradictory, and the
measurement is rejected rather than quoted).

| Resolution | Backend | Sustained ms/frame | Sustained fps | Isolated GPU median (not comparable) |
|---|---:|---:|---:|---:|
| 900×600 | WebGL reference | 3.25 | 308 | 4.79 ms |
| 900×600 | Native WebGPU | 1.88 | 532 | 6.49 ms |
| 1800×1200 (900×600 @2) | WebGL reference | 10.66 | 94 | 18.94 ms |
| 1800×1200 (900×600 @2) | Native WebGPU | 5.47 | 183 | 61.87 ms |

Whole-pipeline sustained throughput improved by **1.73×** at 900×600 and **1.95×** at 1800×1200. This is the whole
viewer pipeline, not the isolated geometry stage from `docs/webgpu-geometry-probe.md`, and it is a throughput
measurement, not a claim about presented-frame latency or the auto-tuner's FPS decisions.

## Relative to the earlier geometry probe

The probe measured the opaque geometry stage alone at 13.67 ms (WebGL) versus 2.03/0.92 ms (native). The full pipeline
is dominated by the post chain at these sizes, which is why the end-to-end gain is ~1.7–2× rather than the stage ratio,
and why improvements should be pursued in the post chain next (fewer passes, resolution-aware bloom).

## What is not proven yet

* Temporal sequences with motion (rotation, camera orbit, independently sliding clips) are implemented and exercised
  manually, but the automated matrix for those cases is still failing on the driver side (see the validation lane
  handoff); they are not claimed.
* SMAA on/off, MSAA off, Reinhard preset, portrait/tiny/odd sizes and mid-sequence resize are implemented but not
  measured in this report.
* Device-loss handling is implemented (canvas replacement + WebGL fallback) and was exercised by forcing a native
  initialization failure, not by a real GPU reset.
* No mobile/other-GPU data.
