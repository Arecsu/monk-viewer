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