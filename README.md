monk-viewer
-----------

model-viewer (https://modelviewer.dev/) is a beautiful project.

But I wanted something more specific.

Let's grab three.js and see what we can do.

**Welcome monk-viewer!**

## Cool features:

- **Offscreen Canvas + Web Workers!** No more jank in the main thread — keeps your UI buttery smooth. Although for very slow devices, it won't really help. But hey, no more jank when uploading textures to the GPU, which happened a lot for my models using model-viewer.
- **Performance Auto-Tuning:** Detects device power in the first 1500ms after firing the renderer, tweaking resolution and MSAA for the best experience.
- **Total Three.js Control:** Full access to the rendering pipeline — custom shaders, post-processing, etc.
- **Ultra HDR Environment Maps:** Loads Adobe Gain Map JPGs, courtesy of [MONOGRID gainmap-js](https://github.com/MONOGRID/gainmap-js)
- **Smooth 3D Interaction:** Custom orbit controls with damping, auto-rotation, and slick transitions. Everything is smooth: camera interaction, model rotation, enabling/disabling interactions, interrumpting rotations or movement.
- **Custom Specular Antialiasing Shader Injection:** Developed to reduce jagged lines at grazing angles. This is due to having an [HDR pipeline](https://mynameismjp.wordpress.com/2012/10/24/msaa-overview/) with a high-contrast scene, which renders traditional anti-aliasing solutions ineffective at identifying and smoothing aliased lines. This custom implementation is injected into Three's PBR Standard Material, monkey-patching radiance calculations to reduce the brightness of these lines at grazing angles.
- **Startup Transition:** smooth animations = ♥ UX
- **Augmented Reality (AR):** Auto-detects AR support on iOS/Android and adds a quick link to jump in, loading optimized GLB or USDZ files.
- **USDZ** files should use the latest Apple schemas, converted from GLB using Reality Converter in MacOS. Ambient Occlusion maps work!
- **Web Components API:** Drop in a `<monk-view>` tag, tweak it with attributes, and go.
- **Custom Events:** `interactivity` and `loaded`
- **Post-Processing:** Using `v7 alpha` version of [pmndrs/postprocessing](https://github.com/pmndrs/postprocessing/), which allows for easier effect chaining + better performance. Also added a custom dithering pattern which works better for our bloom + black background scene.
- Vite browser compile optimized modules. No repeating code. Same scripts for worker and non-worker code (this one was tricky).

Additional contribution to @monogrid/gainmap-js which made it compatible with web workers ♥

## Using it

### Method 1: Build

```bash
git clone https://github.com/Arecsu/monk-viewer.git
pnpm install
pnpm run build
```

Inside `dist/assets/`, you will find:

```
monk-viewer-1.0.0.js
offscreencanvas-worker-1.0.0.js
renderer-1.0.0.js
```

In your HTML document

```html
<script crossorigin type="module" src="monk-viewer-1.0.0.js"></script>
```

And serve `offscreencanvas-worker-1.0.0.js` and `renderer-1.0.0.js` from the same path as `monk-viewer-1.0.0.js` for them to be imported by `monk-viewer-1.0.0.js` correctly.

The HTML component:

```html
<monk-view 
   id="viewer"
   model="False_Enlightenment.glb"
   min-distance="0.4"
   target-distance="0.8"
   max-distance="2.0"
   perf-stability-duration="1.0"
   perf-measure-duration="0.5"
   init-delay="0"
   init-delay-interactive="0.6"
   model-title="False Enlightenment"
   model-glb="False_Enlightenment.glb"
   model-usdz="False_Enlightenment.usdz"
   ar-vertical="true"
   envmap="old_bus_depot_2k_HDR.jpg">
</monk-view>
```

CSS:

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

There's the events you can make usage of:

```javascript
const monkView = document.getElementById('viewer');

monkView.addEventListener('interactivity', (e) => {
   const isInteractive = e.detail.state; // true or false
   isInteractive ? disableDragSlider(slider) : enableDragSlider(slider)
});

monkView.addEventListener('loaded', (e) => {
   document.querySelector('.loading-monk-view').textContent = 'LOADED'
})
```  

## Method 2: custom project

This is not really a library. It should be manually copy-pasted and used in a given project.

- `src/main.ts` is the starting point and Web Components API declaration. It will invoke the `renderer` if no offscreen-canvas can be used. Otherwise, it will use `offscreencanvas-worker` to proxy between it and `renderer`
- `offscreencanvas-worker` is the worker and proxy between JS main thread and `renderer`
- `renderer` is the main 3D scene and logic
- `OrbitControls.js` is a fork of Three.js OrbitControls with bug fixes and quality of life modifications to add smoother interactions and animations. Makes usage of `Damper.ts` which is derived from `@google/model-viewer` project.