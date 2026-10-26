// Dev-only experiment. Imported explicitly by tests/webgpu-geometry-browser.js, never by the viewer.
import * as GPU from 'three/webgpu';
import * as TSL from 'three/tsl';
import * as GL from 'three';
import { unpadRows } from './geometry-probe-utils.js';

const { Fn, uniform, varying, vec4, positionLocal, output, mrt, roughness, normalView } = TSL;

/** Download the EXISTING WebGL PMREM. Both backends then use the same prefiltered lighting, not two generators. */
export async function copyPmrem(mgr) {
  let source;
  mgr.model.traverse(o => { if (o.isMesh && !source) source = mgr.renderer.properties.get(Array.isArray(o.material) ? o.material[0] : o.material).envMap; });
  if (!source || source.mapping !== GL.CubeUVReflectionMapping) throw new Error('No compiled CubeUV PMREM available');
  const { width, height } = source.image;
  const target = new GL.WebGLRenderTarget(width, height, { type: GL.HalfFloatType, depthBuffer: false });
  const material = new GL.ShaderMaterial({
    uniforms: { map: { value: source } },
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}',
    fragmentShader: 'uniform sampler2D map; varying vec2 vUv; void main(){gl_FragColor=texture2D(map,vUv);}',
    depthTest: false, depthWrite: false,
  });
  const scene = new GL.Scene(), geometry = new GL.PlaneGeometry(2, 2);
  scene.add(new GL.Mesh(geometry, material));
  const saved = mgr.renderer.getRenderTarget();
  try {
    mgr.renderer.setRenderTarget(target);
    mgr.renderer.render(scene, new GL.Camera());
    const data = new Uint16Array(width * height * 4);
    await mgr.renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height, data);
    const texture = new GPU.DataTexture(data, width, height, GPU.RGBAFormat, GPU.HalfFloatType);
    texture.mapping = GPU.CubeUVReflectionMapping;
    texture.minFilter = GPU.LinearFilter;
    texture.magFilter = GPU.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  } finally {
    mgr.renderer.setRenderTarget(saved);
    material.dispose(); geometry.dispose(); target.dispose();
  }
}

function specularFilter(settings) {
  return Fn(([r, n]) => {
    const du = n.dFdx(), dv = n.dFdy();
    const kernel = du.dot(du).add(dv.dot(dv)).mul(settings.variance * 2).min(settings.threshold);
    return r.max(r.pow(4).add(kernel).min(1).sqrt().sqrt());
  });
}

/** Stage only: opaque forward shading + encoded HDR/velocity MRT + retained depth. Glass/post effects are not timed. */
export async function createWebGpuGeometryProbe(mgr, { width, height, samples = 4 } = {}) {
  if (!navigator.gpu) throw new Error('WebGPU unavailable; this experiment must not silently fall back to WebGL');
  if (mgr.grazingClamp.enabled) throw new Error('Prototype requires grazing clamp off; it does port the modern specular-AA filter');
  const renderer = new GPU.WebGPURenderer({ canvas: document.createElement('canvas'), antialias: false, trackTimestamp: true, powerPreference: 'high-performance' });
  const materials = [], target = new GPU.RenderTarget(width, height, { samples, count: 2, depthBuffer: true, stencilBuffer: false });
  let environment;
  try {
    await renderer.init();
    if (!renderer.backend.isWebGPUBackend) throw new Error('WebGPU initialization fell back to WebGL');
    if (!renderer.backend.trackTimestamp) throw new Error('WebGPU timestamp-query feature is required for GPU comparison');
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    renderer.outputColorSpace = GPU.LinearSRGBColorSpace;
    renderer.toneMapping = GPU.NoToneMapping;
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 1);
    environment = await copyPmrem(mgr);
    const scene = new GPU.Scene();
    scene.environment = environment;
    scene.environmentIntensity = mgr.scene.environmentIntensity;
    scene.environmentRotation.copy(mgr.scene.environmentRotation);
    scene.background = null;
    const model = mgr.model.clone(true);
    scene.add(model);
    const camera = mgr.camera.clone();
    camera.layers.mask = 1; // Same opaque layer as GeometryPass. Transparent glass is intentionally a later stage.
    camera.coordinateSystem = renderer.coordinateSystem;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    const currentVP = uniform(new GPU.Matrix4()), previousVP = uniform(new GPU.Matrix4());
    const exposure = uniform(mgr.resolvePass.exposure);
    const filter = specularFilter({ variance: mgr.specularAA.variance, threshold: mgr.specularAA.threshold });
    const entries = [];
    model.traverse(mesh => {
      if (!mesh.isMesh) return;
      const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const currentModel = uniform(mesh.matrixWorld.clone());
      const previousModel = uniform(mesh.matrixWorld.clone());
      const last = mesh.matrixWorld.clone();
      const converted = sourceMaterials.map(source => {
        const Base = source.isMeshPhysicalMaterial ? GPU.MeshPhysicalNodeMaterial : GPU.MeshStandardNodeMaterial;
        class ProbeMaterial extends Base {
          setupVariants(builder) {
            super.setupVariants(builder);
            if (mgr.specularAA.enabled) roughness.assign(filter(roughness, normalView));
            if (this.useClearcoat && mgr.specularAA.enabled) TSL.clearcoatRoughness.assign(filter(TSL.clearcoatRoughness, TSL.clearcoatNormalView));
          }
        }
        const material = new ProbeMaterial().copy(source);
        // Keep NodeMaterial.customProgramCacheKey: it includes the per-material TSL graph/bindings.
        // Replacing it with Material's WebGL key aliases different meshes' velocity uniforms.
        material.onBeforeCompile = GPU.Material.prototype.onBeforeCompile;
        material.toneMapped = false;
        const currentClip = varying(currentVP.mul(currentModel).mul(vec4(positionLocal, 1)));
        const previousClip = varying(previousVP.mul(previousModel).mul(vec4(positionLocal, 1)));
        const motion = currentClip.xy.div(currentClip.w).sub(previousClip.xy.div(previousClip.w)).mul(0.5);
        const velocity = vec4(motion, previousClip.w.div(currentClip.w).sub(1), 0);
        material.outputNode = Fn(() => {
          const c = output.rgb.max(0).mul(exposure);
          return vec4(c.div(c.add(1)), 1);
        })();
        material.mrtNode = mrt({ velocity });
        materials.push(material);
        return material;
      });
      mesh.material = Array.isArray(mesh.material) ? converted : converted[0];
      mesh.onBeforeRender = () => {};
      entries.push({ mesh, currentModel, previousModel, last });
    });
    target.textures[0].name = 'output';
    target.textures[0].type = GPU.HalfFloatType;
    target.textures[0].format = GPU.RGBFormat;
    target.textures[0].internalFormat = 'rg11b10ufloat';
    target.textures[0].colorSpace = GPU.NoColorSpace;
    target.textures[1].name = 'velocity';
    target.textures[1].type = GPU.HalfFloatType;
    target.textures[1].format = GPU.RGBAFormat;
    target.textures[1].minFilter = GPU.NearestFilter;
    target.textures[1].magFilter = GPU.NearestFilter;
    target.depthTexture = new GPU.DepthTexture(width, height, GPU.FloatType);
    target.storeMultisampledDepthBuffer = true; // Required: downstream TAA must still be able to read depth.
    target.storeMultisampledColorBuffer = true;
    const outputs = mrt({ output });
    outputs.setClearColor('velocity', new GPU.Color(0), 0);
    renderer.setRenderTarget(target);
    renderer.setMRT(outputs);
    let initialized = false;
    const render = () => {
      model.updateMatrixWorld(true);
      camera.updateMatrixWorld();
      previousVP.value.copy(currentVP.value);
      // Keep the original WebGL NDC convention for the velocity channels, including its Y direction.
      const velocityCamera = camera.clone();
      velocityCamera.coordinateSystem = GL.WebGLCoordinateSystem;
      velocityCamera.updateProjectionMatrix();
      currentVP.value.multiplyMatrices(velocityCamera.projectionMatrix, camera.matrixWorldInverse);
      if (!initialized) previousVP.value.copy(currentVP.value);
      for (const entry of entries) {
        entry.currentModel.value.copy(entry.mesh.matrixWorld);
        entry.previousModel.value.copy(initialized ? entry.last : entry.mesh.matrixWorld);
        entry.last.copy(entry.mesh.matrixWorld);
      }
      renderer.setRenderTarget(target);
      renderer.setMRT(outputs);
      renderer.render(scene, camera);
      initialized = true;
    };
    const dispose = async () => {
      target.dispose(); materials.forEach(m => m.dispose()); environment.dispose();
      await renderer.dispose();
    };
    return { renderer, scene, model, camera, target, render, dispose, reset: () => { initialized = false; },
      metadata: { backend: renderer.backend.constructor.name, features: [...renderer.backend.device.features], samples, width, height, colorFormat: 'rg11b10ufloat', velocityFormat: 'rgba16float', depthFormat: 'depth32float', specularAA: mgr.specularAA.enabled, encodeExposure: exposure.value } };
  } catch (error) {
    target.dispose(); materials.forEach(m => m.dispose()); environment?.dispose(); await renderer.dispose();
    throw error;
  }
}

/** Read debug RGBA32F copies, not packed R11G11B10 bytes. This work is NEVER included in timed samples. */
export async function readWebGpuAttachment(probe, which) {
  const { renderer, target } = probe;
  const debug = new GPU.RenderTarget(target.width, target.height, { type: GPU.FloatType, depthBuffer: false });
  const material = new GPU.MeshBasicNodeMaterial();
  const source = which === 'depth' ? target.depthTexture : target.textures[which];
  // For multisampled depth .level(0) supplies the sample index to WGSL textureLoad, not an implicit depth resolve.
  const value = TSL.textureLoad(source, TSL.ivec2(TSL.screenCoordinate.xy)).level(0);
  material.fragmentNode = which === 'depth' ? TSL.vec4(value, value, value, 1) : TSL.vec4(value.rgb, 1);
  const quad = new GPU.QuadMesh(material);
  try {
    renderer.setMRT(null); renderer.setRenderTarget(debug); quad.render(renderer);
    return unpadRows(await renderer.readRenderTargetPixelsAsync(debug, 0, 0, debug.width, debug.height), debug.width, debug.height);
  } finally {
    renderer.setMRT(null); renderer.setRenderTarget(target); material.dispose(); debug.dispose();
  }
}

export async function readWebGlAttachment(mgr, which) {
  const r = mgr.renderer, sourceTarget = mgr.geometryPass.output.defaultBuffer.value;
  const source = which === 'depth' ? sourceTarget.depthTexture : sourceTarget.textures[which];
  const debug = new GL.WebGLRenderTarget(sourceTarget.width, sourceTarget.height, { type: GL.FloatType, depthBuffer: false });
  const material = new GL.ShaderMaterial({ uniforms: { map: { value: source } }, depthTest: false, depthWrite: false,
    vertexShader: 'void main(){gl_Position=vec4(position.xy,0.0,1.0);}',
    fragmentShader: `uniform sampler2D map; void main(){vec4 v=texelFetch(map,ivec2(gl_FragCoord.xy),0);gl_FragColor=${which === 'depth' ? 'vec4(v.rrr,1.0)' : 'vec4(v.rgb,1.0)'};}` });
  const scene = new GL.Scene(), geometry = new GL.PlaneGeometry(2, 2);
  scene.add(new GL.Mesh(geometry, material));
  const saved = r.getRenderTarget();
  try {
    r.setRenderTarget(debug); r.render(scene, new GL.Camera());
    const pixels = new Float32Array(debug.width * debug.height * 4);
    await r.readRenderTargetPixelsAsync(debug, 0, 0, debug.width, debug.height, pixels);
    return pixels;
  } finally { r.setRenderTarget(saved); material.dispose(); geometry.dispose(); debug.dispose(); }
}
