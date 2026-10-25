monk-viewer
-----------

model-viewer (https://modelviewer.dev/) is a beautiful project.

But I wanted something more specific.

Let's grab three.js and see what we can do.

**Welcome monk-viewer!**

## Cool features:

- **Offscreen Canvas + Web Workers!** No more jank in the main thread — keeps your UI buttery smooth. Although for very slow devices, it won't really help. But hey, no more jank when uploading textures to the GPU, which happened a lot for my models using model-viewer.
- **Performance Auto-Tuning:** Detects device power in the first 1500ms after firing the renderer. Below 54 FPS it drops MSAA first (TAA alone is the best quality per millisecond) and measures again, then lowers the resolution only if it's still too slow.
- **Total Three.js Control:** Full access to the rendering pipeline — custom shaders, post-processing, etc.
- **Ultra HDR Environment Maps:** Loads Adobe Gain Map JPGs, courtesy of [MONOGRID gainmap-js](https://github.com/MONOGRID/gainmap-js)
- **Smooth 3D Interaction:** Custom orbit controls with damping, auto-rotation, and slick transitions. Everything is smooth: camera interaction, model rotation, enabling/disabling interactions, interrumpting rotations or movement.
- **Tonemapped MSAA Resolve:** With an [HDR pipeline](https://mynameismjp.wordpress.com/2012/10/24/msaa-overview/) and a high-contrast scene, hardware MSAA averages samples in linear HDR, so a half-covered pixel of a bright edge still tonemaps to pure white and edges stay jagged no matter the sample count. Opaque materials write a Reinhard-encoded colour approximating the final tone mapping, the hardware resolve averages roughly what ends up on screen, and `TonemappedResolvePass` decodes back to linear HDR before bloom and tone mapping. Transparent objects (the glass) are drawn after the decode, since blending doesn't commute with the encoding. Combined with 4x MSAA, thin bright edges come out close to 16x supersampling. The lab's **Edge resolve** section tunes it: the curve (per channel, on the largest channel to keep the hue of coloured edges, or off for plain MSAA) and the exposure of the MSAA and TAA encodings. With GT7 the Reinhard encoding is an approximation (it must stay invertible for bloom, and GT7 clips): it still removes about two thirds of the edge error of plain MSAA.
- **Temporal Antialiasing:** `TemporalAAPass` jitters the camera and accumulates frames on top of the 4x MSAA, smoothing the sub-pixel steps MSAA leaves on thin edges. Reprojection uses depth plus the model's rigid motion (no velocity buffer needed for one object in front of a static background). While nothing moves, the history becomes a running average over all jitter positions without clipping, so still frames converge to a steady, render-like image instead of flickering with the jitter cycle. The history lookup intentionally stays on the same pixel instead of compensating the jitter offset: that is what averages the jitter positions, so still frames converge. Compensating the offset instead tracks the surface sub-pixel by sub-pixel and leaves the 1px jitter visible in still frames (`aa-lab.html` has the toggle; it needs ~0.65px jitter to hide and is not better in motion).
- **Bounded TAA:** Before bloom, pixels outside the tracked model's padded accumulated screen bounds are known black, so TAA skips their depth/history/filter work. Bounds include the transparent glass, not just opaque depth. This preserves the glass material, MSAA, TAA reconstruction and eight-level bloom. The footprint only grows until the history is reset, so faint motion trails are preserved too. Near-plane crossings, coloured/textured backgrounds, fog or disabled history clamping expand it to full-screen TAA until the next reset. It assumes all rendered geometry belongs to the tracked rigid object, without vertex displacement; standalone `TemporalAAPass` users must opt in with `backgroundFastPath: true`.
- **Bounded Bloom:** `BoundedBloomEffect` reuses TAA's certified black-background footprint to skip zero-valued luminance and downsample work. Conservative filter padding covers the complete downsample chain, including odd dimensions; all eight levels, thresholds, buffer formats and the upsampling filters are unchanged. It falls back to full-screen work when TAA cannot certify the input, so glass reflections and the wide halo are preserved.
- **Grazing-Angle Specular Clamp:** Seen edge-on, the 2.4mm edges of the frame shrink to sub-pixel slivers while Fresnel makes their reflection the brightest in the scene: thin HDR lines that stay jagged whatever the sample count. `GrazingSpecularClamp` patches the materials to compress the environment reflection above a low limit only on surfaces seen at a grazing angle (from the face normal, so normal maps don't make it noisy). Not physically based, but neither are the stairs. Off by default since specular antialiasing (below) prefilters the same highlights without dimming them; `grazing-specular-clamp="true"` enables it.
- **Modern TAA:** 3x3 variance clipping towards the current colour, history validated per pixel by depth and by motion (a part lying flush on another slides off without leaving its history behind), FSR 2 style thin feature locks, a reactive mask for the glass, edge-adaptive blend and per-frame sample confidence. A velocity buffer from the geometry pass gives every mesh its own motion, so parts animated on their own reproject correctly.
- **Specular antialiasing:** roughness widened by the screen-space variance of the normal (Tokuyoshi & Kaplanyan 2019, as in Filament), so sub-pixel bevels don't alias into bright stairs.
- **Motion blur:** McGuire 2012 / Jimenez 2014 tile-based reconstruction from the per-pixel motion, on by default (`motionBlur: false` in the renderer options, or `motionBlurPass.enabled`, turns it off).
- **Gran Turismo 7 tone mapping:** a port of Polyphony Digital's [MIT-licensed sample implementation](https://blog.selfshadow.com/publications/s2025-shading-course/pdi/supplemental/gt7_tone_mapping.cpp) from the SIGGRAPH 2025 talk *Driving Toward Reality*. The curve runs per channel, then the result is blended with one that keeps the input's hue and chroma in ICtCp, so bright colours roll towards white without the hue shifts of plain per-channel curves, and the blacks stay deep instead of Reinhard's lifted, milky look. The lab's **GT7** toggle (key K) compares against Reinhard. On top of the reference, `GT7ToneMappingEffect` exposes the curve and a grade: `blackPoint` (crush or lift), `shadowToe` and `toeLength` for the shadows, `shoulderStart` and `highlightHardness` for the roll-off (0 approaches white without clipping, keeping highlight detail like Reinhard; GT7's 0.25 clips), `chromaPreservation` (how much bright colours keep their hue instead of burning to white), plus `contrast`, `saturation` and `vibrance`. The effect's defaults are GT7's; the viewer uses a grade made in the lab (softer, never-clipping highlights, a slightly lifted black), where each has a slider and **copy settings** exports them. Costs ~0.2 ms at 4K on an RTX 3080.
- **Resolution-independent bloom:** the mip chain follows the output height, so the bloom keeps its reach at any render scale or pixel ratio.
- **Startup Transition:** smooth animations = ♥ UX
- **Augmented Reality (AR):** Auto-detects AR support on iOS/Android and adds a quick link to jump in, loading optimized GLB or USDZ files.
- **USDZ** files should use the latest Apple schemas, converted from GLB using Reality Converter in MacOS. Ambient Occlusion maps work!
- **Web Components API:** Drop in a `<monk-view>` tag, tweak it with attributes, and go.
- **Custom Events:** `interactivity` and `loaded`
- **Post-Processing:** Using `v7 alpha` version of [pmndrs/postprocessing](https://github.com/pmndrs/postprocessing/), which allows for easier effect chaining + better performance. Also added a custom dithering pattern which works better for our bloom + black background scene.
- Vite browser compile optimized modules. No repeating code. Same scripts for worker and non-worker code (this one was tricky).

Additional contribution to @monogrid/gainmap-js which made it compatible with web workers ♥

## Known issues

- Chrome precise FPS measurement is just pain. It is not possible. Android devices used to get MSAA disabled and a 2x pixel ratio cap up front; they have improved enough that they now get the same settings as iOS and desktop (4x MSAA + TAA), and the auto-tuner drops MSAA, then resolution, on the ones that can't keep up.
- Same as this, Firefox on Mac and Android works horrible with MSAA, high resolution and offscreen canvas. MSAA is disabled and pixel ratio is lowered.
- `postprocessing`'s SMAAEffect doesn't work in offscreen canvas mode: it decodes its lookup textures with `Image`, which workers lack. `src/postprocessing/SMAAEffect.ts` decodes them with `createImageBitmap` instead (opt-in via the `smaa="true"` attribute, off by default: it doesn't improve the thin bright edges beyond TAA).

## Performance checks

`npm test` checks conservative TAA bounds, bloom filter support across rounded mip sizes, composition settings, safe fallback guards and the GT7 tone mapping against Polyphony's reference (Node 22.6+ with TypeScript stripping).

For GPU measurements, run `npm run dev`, open `/monk-viewer/aa-lab.html?fixed=1&smaa=0` (the deployed copy is at `https://arecsu.github.io/monk-viewer/aa-lab.html`), choose **still** motion and use the browser console. `fixed=1` pins the deterministic 900×600 @1x framebuffer the numbers here assume; without it the lab fills the viewport at the device pixel ratio.

```js
const checks = await import('/monk-viewer/tests/taa-browser.js');
console.table(await checks.validateTaa(window.mgr, window.THREE));
console.table(await checks.benchmarkTaa(window.mgr, { pixelRatio: 1 }));
// Repeat at higher resolution, without changing CSS layout:
console.table(await checks.benchmarkTaa(window.mgr, { pixelRatio: 2 }));
```

The framebuffer checks compare bounds on/off through rotation, camera orbit, pan, near-plane clipping, resize/DPR changes and fallback settings. The benchmark uses asynchronous `EXT_disjoint_timer_query_webgl2` queries, warm-up frames and alternating A/B order, reporting GPU milliseconds rather than vsync-limited FPS. It rejects disjoint measurements; results vary by GPU/browser. The lab's **TAA bounds** toggle also permits visual comparison.
Bloom checks compare the optimized effect against the unmodified library `BloomEffect`, not against fewer levels or a smaller halo:

```js
const bloom = await import('/monk-viewer/tests/bloom-browser.js');
console.table(await bloom.validateBloom(window.mgr, window.THREE));
console.table(await bloom.benchmarkBloom(window.mgr, { pixelRatio: 1 }));
console.table(await bloom.benchmarkBloom(window.mgr, { pixelRatio: 2 }));
```

The bloom suite covers motion, odd/tiny/portrait sizes, resolution scaling, different mip counts/radii, full-resolution upsampling and disabled-TAA/background fallbacks. The lab's **bloom bounds** toggle disables only the optimization, not bloom itself. Savings depend on how much of the image TAA can certify as black; a full-screen history footprint safely gives up the optimization.

The GT7 shader is checked against its CPU port (which `npm test` checks against Polyphony's reference, built in double precision):

```js
const gt7 = await import('/monk-viewer/tests/gt7-browser.js');
console.table(await gt7.validateGT7(window.mgr, window.THREE));
```

WebGPU is not a renderer toggle for this codebase: the custom GLSL passes and `onBeforeCompile` material patches, the current post-processing pipeline and gain-map decoding would need migration. Three.js's WebGL fallback does not make those existing shaders compatible with `WebGPURenderer`; see the [migration guide](https://threejs.org/manual/en/webgpurenderer.html).

## Using it

### Method 1: Build

```bash
git clone https://github.com/Arecsu/monk-viewer.git
pnpm install
pnpm run build
```

Inside `dist/assets/`, you will find:

```
monk-viewer-1.1.0.js
offscreencanvas-worker-1.1.0.js
renderer-1.1.0.js
```

In your HTML document

```html
<script crossorigin type="module" src="monk-viewer-1.1.0.js"></script>
```

And serve `offscreencanvas-worker-1.1.0.js` and `renderer-1.1.0.js` from the same path as `monk-viewer-1.1.0.js` for them to be imported by `monk-viewer-1.1.0.js` correctly.

### The HTML component:

```html
<monk-view 
  id="viewer"
  model="False_Enlightenment.glb"
  startup="auto"
  min-distance="0.4"
  target-distance="0.8"
  max-distance="2.0"
  perf-stability-duration="1.0"
  perf-measure-duration="0.5"
  init-delay="0"
  init-delay-interactive="0.6"
  offscreencanvas="true"
  model-title="False Enlightenment"
  model-glb="False_Enlightenment.glb"
  model-usdz="False_Enlightenment.usdz"
  ar-vertical="true"
  envmap="old_bus_depot_2k_HDR.jpg">
</monk-view>
```

- `startup`: 'auto' or 'manual'. 'auto' means the renderer and scene will start as soon as assets are loaded. With 'manual' you have to `attemptInit()` at some point. The models and assets will preload in both scenarios.

- `offscreencanvas`: 'true' or 'false'. Recommended to leave it enabled. Will fallback to a normal canvas if for some reason it can't use offscreen canvas. No reason to not use it, 
unless researching purposes? Although what's being mentioned on Known Issues might be semi-valid concerns.

There are also attributes that will be set across the element's lifespan:

- `ready`: 'true' or null. Appears when the assets have been loaded and ready to be rendered.

- `loaded`: 'true' or null. Appears when the renderer and scene have been executed.

- `interactive`: 'true', 'false' or null. Triggered when clicked on the element to interact with it.

### CSS:

```css
monk-view,
monk-view canvas {
  width: 100%;
  height: 100%;
  display: block;
}

monk-view canvas:focus {
  outline: none;
}

monk-view {
  --delay-model: 660ms;
  --delay-ar: 3000ms;
  position: relative;
}

monk-view canvas {
  transition: opacity 4000ms var(--delay-model) ease-in-out;
  opacity: 0;
}

monk-view[loaded="true"] canvas {
  scale: 1;
  opacity: 1;
}

monk-view .ar-link {
  position: absolute;
  font-size: 1rem;
  right: 1.2rem;
  top: calc(100dvh - 3rem);
  padding: 5px 10px;
  background: hsl(0, 0%, 16%);
  border-radius: 0.2em;
  color: white;
  text-decoration: none;
  opacity: 0;
  transition: opacity 1500ms var(--delay-ar) ease-in-out;
}

monk-view[loaded="true"] .ar-link {
  opacity: 1;
}
```

### Events

There's the events you can make usage of:

```javascript
const monkView = document.getElementById('viewer');

monkView.addEventListener('interactivity', (e) => { // triggers false or true depending on interactivity changes
   const isInteractive = e.detail.state; // true or false
   isInteractive ? disableDragSlider(slider) : enableDragSlider(slider)
});

monkView.addEventListener('loaded', (e) => { // triggers when the renderer and scene have been executed
   document.querySelector('.loading-monk-view').textContent = 'LOADED'
})
```  

In case of using `startup="manual"`:

```javascript
let observer
const monkView = document.getElementById('viewer');

customElements.whenDefined('monk-view').then(() => {
  observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {

        // If assets are loaded, renderer will start.
        // If not, will do it as soon as assets are ready
        monkView.attemptInit();

      } else {

        // If the renderer has not yet started, will prevent it to execute. 
        // Won't stop execution of an already executed renderer
        monkView.abortInit(); 

      }
    });
  }, { threshold: 0.5 });

  observer.observe(monkView);
});

monkView.addEventListener('loaded', (e) => {
  if (observer) observer.disconnect();
});
```

## Method 2: custom project

This is not really a library. It should be manually copy-pasted and used in a given project.

- `src/main.ts` is the starting point and Web Components API declaration. It will invoke the `renderer` if no offscreen-canvas can be used. Otherwise, it will use `offscreencanvas-worker` to proxy between it and `renderer`
- `offscreencanvas-worker` is the worker and proxy between JS main thread and `renderer`
- `renderer` is the main 3D scene and logic
- `OrbitControls.js` is a fork of Three.js OrbitControls with bug fixes and quality of life modifications to add smoother interactions and animations. Makes usage of `Damper.ts` which is derived from `@google/model-viewer` project.