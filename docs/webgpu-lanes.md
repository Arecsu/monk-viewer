# Native WebGPU lane board

Topology: **multi-seam**. Geometry, transparency/depth, TAA, blur, post-color, environment and validation have separate target/resource contracts and focused tests. One writer per isolated cwd. Supervisor alone owns shared integration, dependency/config changes, and browser/GPU access. All children use explicit `deepseek/deepseek-flash` (direct provider); no nested delegation, publishing or deployment.

Original checkout `/Users/arecsu/stuff/monk-viewer` is preserved, including untracked audio. Integration `/Users/arecsu/stuff/monk-viewer-webgpu` contains committed snapshot of relevant current project files. Lane worktrees branch from the contract baseline on `webgpu/native-integration`. Shared dependencies read-only, no lane installation/patching.

| Lane / owner | Exclusive files | cwd | Dependencies | Status / next gate | Handoff |
|---|---|---|---|---|---|
| Geometry / worker | src/webgpu/Geometry.js, tests/webgpu-geometry-native.test.ts | ../monk-viewer-webgpu-geometry | contract/Common | assigned: material/MRT parity | managed geometry.md + commit |
| Transparency / worker | src/webgpu/Transparency.js, tests/webgpu-transparency-native.test.ts | ../monk-viewer-webgpu-transparency | geometry contract, no implementation wait | assigned: depth attachment + glass/mask | managed transparency.md + commit |
| TAA / worker | src/webgpu/TemporalAA.js, src/webgpu/TemporalAAShader.js, tests/webgpu-taa-native.test.ts | ../monk-viewer-webgpu-taa | contract/Common, reference bounds helper | assigned: full reference algorithm | managed taa.md + commit |
| Blur / worker | src/webgpu/MotionBlur.js, tests/webgpu-motion-native.test.ts | ../monk-viewer-webgpu-blur | TAA state contract | assigned: separable reduction/gather parity | managed blur.md + commit |
| Post-color / worker | src/webgpu/PostColor.js, src/webgpu/PostColorShaders.js, src/webgpu/SMAA.js, tests/webgpu-post-native.test.ts | ../monk-viewer-webgpu-color | contract/Common, installed bloom/SMAA source | assigned: exact filters/GT7/dither/SMAA | managed color.md + commit |
| Assets / worker | src/webgpu/Environment.js, tests/webgpu-environment-native.test.ts | ../monk-viewer-webgpu-assets | native renderer, installed loader source | assigned: gain-map native worker decoding | managed assets.md + commit |
| Validation / worker | tests/webgpu-pipeline-browser.js, tests/webgpu-validation-utils.js, tests/webgpu-validation.test.ts | ../monk-viewer-webgpu-validation | public manager/pipeline contract | assigned: deterministic final sequences + exclusive timing | managed validation.md + commit |
| Supervisor / architect-integrator | Common.js, WebGpuPipeline.js, renderer.js, main.ts, worker, backend selection, lab, docs/config | ../monk-viewer-webgpu | component handoffs | active: native lifecycle scaffolding | integration commits |

## Gates / authority

Workers run focused Node tests and import/static checks; no shared browser, no GPU benchmarks, no dependency installation, no shared source edits. Ask supervisor for incompatible contract changes. Durable handoff includes changed files/commit, interface, test commands/results, limitations, integration instructions and explicit unvalidated gates. Supervisor reads code and cherry-picks component commits, runs pnpm test/build, browser sequences and measured full-pipeline acceptance. Fresh-context direct-DeepSeek reviewers run read-only after integration with architecture and image/temporal/methodology scopes. No `auto` native preference before acceptance. Missing evidence or unfinished features block full-conversion claims.
