// Native WebGPU geometry stage: opaque forward shading into encoded HDR + per-mesh velocity, with the
// 4x MSAA depth retained for the later stages. This is a port of the reference geometry stage:
// GeometryPass (opaque draw), VelocityBuffer (per-object motion), TonemappedResolvePass.encodeMaterial
// (the MSAA encoding curves), SpecularAntialiasing and GrazingSpecularClamp.
//
// Glass materials are converted natively as well, but they are not encoded and not drawn here: prepare()
// assigns them to GLASS_LAYER for the transparency stage, exactly like TonemappedResolvePass.prepare.
//
// WebGL keeps the reference implementation. Only TSL nodes are used here; no GLSL material patch is
// WebGPU compatible.
import * as GPU from 'three/webgpu';
import * as T from 'three/tsl';

/** Opaque geometry layer, rendered by {@link WebGpuGeometry.render}. */
export const OPAQUE_LAYER = 0;

/** Transparent (glass) layer, rendered by the transparency stage on top of the decoded color. */
export const GLASS_LAYER = 1;

/**
 * The tonemapped resolve curves, in the same order as the reference: the index is the value the encoding
 * uniform carries, so the decode stage reads `ENCODINGS[encodingUniform]`.
 */
export const ENCODINGS = ['linear', 'rgb', 'max'];

const LUMINANCE = [0.2126, 0.7152, 0.0722];
const MAX_SAMPLES = 4;

// Scratch for the CPU velocity mirror; it is not part of the render path.
const _currentClip = new GPU.Vector4();
const _previousClip = new GPU.Vector4();

/**
 * Returns the uniform value for an encoding name, throwing on typos instead of silently rendering linear.
 *
 * @param {string} encoding - One of {@link ENCODINGS}.
 * @return {number} The index of the encoding.
 */
export function encodingIndex(encoding) {
  const index = ENCODINGS.indexOf(encoding);
  if (index === -1) throw new Error(`WebGpuGeometry: unknown encoding "${encoding}", expected one of ${ENCODINGS.join(', ')}`);
  return index;
}

/**
 * CPU mirror of the encoded-color curve the opaque materials write, used for the render-target clear color
 * and by the focused tests. It is the exact counterpart of the reference `TonemappedResolvePass.encodeColor`.
 *
 * @param {{r: number, g: number, b: number}} color - A linear color.
 * @param {number} exposure - The encoding exposure, matching the decode stage.
 * @param {string} encoding - One of {@link ENCODINGS}.
 * @param {GPU.Color} [target] - A color to store the result in.
 * @return {GPU.Color} The encoded color.
 */
export function encodeColor(color, exposure, encoding, target = new GPU.Color()) {
  const [r, g, b] = [color.r, color.g, color.b].map((channel) => Math.max(channel, 0) * exposure);
  const largest = Math.max(r, g, b);
  const curve = encoding === 'rgb' ? (channel) => channel / (1 + channel)
    : encoding === 'max' ? (channel) => channel / (1 + largest)
      : encoding === 'linear' ? (channel) => channel
        : null;
  if (curve === null) throw new Error(`WebGpuGeometry: unknown encoding "${encoding}", expected one of ${ENCODINGS.join(', ')}`);
  return target.setRGB(curve(r), curve(g), curve(b));
}

/**
 * CPU mirror of the velocity fragment math, so the motion contract stays testable without a GPU.
 *
 * The shader transforms the same object-space vertex twice, with the current and with the previous frame's
 * model and unjittered WebGL view-projection matrices. The result is (current - previous) screen motion in
 * UV units (positive X right, positive Y up), the relative view-depth change (previous / current - 1) and 0.
 *
 * @param {{x: number, y: number, z: number}} position - The object-space vertex position.
 * @param {Object} matrices - The four matrices of the transform pair.
 * @param {GPU.Matrix4} matrices.currentViewProjection - Current frame, unjittered, WebGL NDC.
 * @param {GPU.Matrix4} matrices.currentModel - The mesh's current model matrix.
 * @param {GPU.Matrix4} matrices.previousViewProjection - Previous frame, unjittered, WebGL NDC.
 * @param {GPU.Matrix4} matrices.previousModel - The mesh's model matrix of the last frame it was drawn.
 * @return {GPU.Vector4} The velocity, W = 0.
 */
export function velocityForVertex(position, { currentViewProjection, currentModel, previousViewProjection, previousModel }) {
  _currentClip.set(position.x, position.y, position.z, 1).applyMatrix4(currentModel).applyMatrix4(currentViewProjection);
  _previousClip.set(position.x, position.y, position.z, 1).applyMatrix4(previousModel).applyMatrix4(previousViewProjection);
  return new GPU.Vector4(
    0.5 * (_currentClip.x / _currentClip.w - _previousClip.x / _previousClip.w),
    0.5 * (_currentClip.y / _currentClip.w - _previousClip.y / _previousClip.w),
    _previousClip.w / _currentClip.w - 1,
    0,
  );
}

/**
 * The GPU sample count three supports on its WebGPU backend: either 4x or none. The reference can request
 * other counts, the native attachments cannot.
 */
function normalizeSamples(samples) {
  return samples >= MAX_SAMPLES ? MAX_SAMPLES : 1;
}

/**
 * Geometric specular antialiasing settings (Tokuyoshi & Kaplanyan 2019, as in Filament), ported to node
 * materials: the roughness is widened by the screen-space variance of the shading normal, so sub-pixel
 * bevels do not alias into bright stairs. Settings are uniforms, so they can change at runtime without a
 * recompile, like the reference `SpecularAntialiasing`.
 */
class SpecularAntialiasing {

  constructor({ enabled = true, variance = 0.15, threshold = 0.2 } = {}) {
    this._strength = T.uniform(enabled ? 1 : 0);
    this._variance = T.uniform(variance);
    this._threshold = T.uniform(threshold);
  }

  get enabled() {
    return this._strength.value > 0;
  }

  set enabled(value) {
    this._strength.value = value ? 1 : 0;
  }

  get variance() {
    return this._variance.value;
  }

  set variance(value) {
    this._variance.value = value;
  }

  get threshold() {
    return this._threshold.value;
  }

  set threshold(value) {
    this._threshold.value = value;
  }

  /**
   * Returns the perceptual roughness widened by the normal's screen-space variance.
   *
   * @param {Object} roughness - The material's (map-modulated) perceptual roughness node.
   * @param {Object} normal - The shading normal node, normal maps included.
   * @return {Object} The filtered roughness node.
   */
  filter(roughness, normal) {
    const du = normal.dFdx();
    const dv = normal.dFdy();
    // Perceptual roughness r, GGX alpha = r², filtered alpha² = alpha² + kernel.
    const variance = du.dot(du).add(dv.dot(dv)).mul(this._variance);
    const kernel = variance.mul(2).min(this._threshold);
    const alpha = roughness.mul(roughness);
    const filtered = alpha.mul(alpha).add(kernel).min(1).sqrt().sqrt();
    return T.mix(roughness, roughness.max(filtered), this._strength);
  }

}

/**
 * Grazing-angle specular clamp settings: seen edge-on, Fresnel makes foreshortened surfaces the brightest and
 * thinnest highlights in the scene. The clamp compresses indirect specular above a low limit on those
 * surfaces only, from the face normal so normal maps cannot make it noisy. Not physically based, like the
 * reference. Off by default in the viewer, since the specular antialiasing above already pre-filters the
 * same highlights without dimming them.
 */
class GrazingSpecularClamp {

  constructor({ enabled = false, angle = 0.5, limit = 0.03 } = {}) {
    this._strength = T.uniform(enabled ? 1 : 0);
    this._angle = T.uniform(angle);
    this._limit = T.uniform(limit);
  }

  get enabled() {
    return this._strength.value > 0;
  }

  set enabled(value) {
    this._strength.value = value ? 1 : 0;
  }

  get angle() {
    return this._angle.value;
  }

  set angle(value) {
    this._angle.value = value;
  }

  get limit() {
    return this._limit.value;
  }

  set limit(value) {
    this._limit.value = value;
  }

  /**
   * Returns the multiplier for the indirect specular: 1 outside grazing angles and below the limit,
   * fading towards the soft-knee compression above it.
   *
   * @param {Object} indirectSpecular - The lighting model's indirect specular node.
   * @return {Object} The scale node.
   */
  factor(indirectSpecular) {
    // Face normal from the view-position derivatives: the foreshortening aliases, not the normal map.
    const faceNormal = T.positionView.dFdx().cross(T.positionView.dFdy()).normalize();
    const grazing = T.float(1).sub(T.smoothstep(0, this._angle, faceNormal.dot(T.positionViewDirection).abs()));

    // Soft knee: unchanged up to the limit, then compressed towards twice the limit.
    const luminance = indirectSpecular.dot(T.vec3(...LUMINANCE));
    const excess = luminance.sub(this._limit).max(0);
    const compressed = luminance.sub(excess).add(excess.div(excess.div(this._limit).add(1)));
    const scale = T.select(luminance.greaterThan(0), compressed.div(luminance), T.float(1));

    return T.mix(T.float(1), scale, grazing.mul(grazing).mul(this._strength));
  }

  /**
   * Applies the clamp to a lighting model's accumulated indirect specular. The reference scales
   * `reflectedLight.indirectSpecular` after `lights_fragment_end`; the node lighting model has already
   * folded the indirect specular into the outgoing light by then, so the same scale arrives as a delta.
   *
   * @param {Object} context - The lighting context of the current build.
   */
  apply(context) {
    const indirectSpecular = context.reflectedLight.indirectSpecular;
    const clamped = indirectSpecular.mul(this.factor(indirectSpecular));
    context.outgoingLight.assign(context.outgoingLight.add(clamped.sub(indirectSpecular)));
  }

}

/**
 * Builds the encoded-color output of an opaque material: max(color, 0) * exposure, compressed by the
 * resolve curve so the hardware MSAA resolve averages what ends up on screen.
 */
function createEncodedOutputNode(exposure, encoding) {
  const color = T.output.rgb.max(0).mul(exposure);
  const perChannel = color.div(color.add(1));
  const perLargest = color.div(color.r.max(color.g).max(color.b).add(1));
  return T.vec4(T.select(encoding.equal(1), perChannel, T.select(encoding.equal(2), perLargest, color)), 1);
}

/**
 * Builds the per-mesh velocity output: the same vertex transformed by the current and the previous frame's
 * unjittered view-projection and model matrices.
 */
function createVelocityNode(viewProjection, previousViewProjection, currentModel, previousModel) {
  const localPosition = T.vec4(T.positionLocal, 1);
  const currentClip = T.varying(viewProjection.mul(currentModel).mul(localPosition));
  const previousClip = T.varying(previousViewProjection.mul(previousModel).mul(localPosition));
  const motion = currentClip.xy.div(currentClip.w).sub(previousClip.xy.div(previousClip.w)).mul(0.5);
  return T.vec4(motion, previousClip.w.div(currentClip.w).sub(1), 0);
}

/**
 * Creates the two material classes the converted model uses. Both stay node materials (so the NodeMaterial
 * program cache key keeps its TSL graph identity) and only inject the roughness filter and the optional
 * specular clamp.
 */
function createMaterialClasses(specularAA, grazingClamp) {
  const create = (Base) => class extends Base {

    setupVariants(builder) {
      super.setupVariants(builder);
      // Equal to the reference patch: only ever makes surfaces rougher, normal maps included.
      T.roughness.assign(specularAA.filter(T.roughness, T.normalView));
      if (this.useClearcoat) T.clearcoatRoughness.assign(specularAA.filter(T.clearcoatRoughness, T.clearcoatNormalView));
    }

    setupLightingModel() {
      const model = super.setupLightingModel();
      const finish = model.finish.bind(model);
      model.finish = (builder) => {
        finish(builder);
        grazingClamp.apply(builder.context);
      };
      return model;
    }

  };
  // One class per base kind, so every converted mesh of a kind is an instance of the same class.
  return { standard: create(GPU.MeshStandardNodeMaterial), physical: create(GPU.MeshPhysicalNodeMaterial) };
}

/**
 * Creates the geometry render target: encoded HDR color + nearest velocity, both actually 4x multisampled,
 * with the depth samples retained for later stages.
 */
function createGeometryTarget(width, height, samples) {
  const target = new GPU.RenderTarget(width, height, { depthBuffer: true, stencilBuffer: false, samples, count: 2 });
  const [color, velocity] = target.textures;

  color.name = 'output';
  color.format = GPU.RGBFormat;
  color.type = GPU.UnsignedInt101111Type;
  color.internalFormat = 'rg11b10ufloat';
  color.colorSpace = GPU.NoColorSpace;
  color.minFilter = color.magFilter = GPU.LinearFilter;
  color.generateMipmaps = false;

  // Velocities must not interpolate across edges; RGBA because RGB half float is not renderable.
  velocity.name = 'velocity';
  velocity.format = GPU.RGBAFormat;
  velocity.type = GPU.HalfFloatType;
  velocity.colorSpace = GPU.NoColorSpace;
  velocity.minFilter = velocity.magFilter = GPU.NearestFilter;
  velocity.generateMipmaps = false;

  // DepthFormat + FloatType is depth32float; without reverse depth, near is 0 and far is 1.
  target.depthTexture = new GPU.DepthTexture(width, height, GPU.FloatType);

  // Resolve the multisampled color in hardware, then discard it: only the resolved HDR is needed.
  target.storeMultisampledColorBuffer = false;
  // Keep the multisampled depth: TAA and the glass pass read its sample 0, there is no implicit depth resolve.
  target.storeMultisampledDepthBuffer = true;

  return target;
}

/**
 * Native geometry stage.
 *
 * Renders the opaque meshes of the scene into encoded HDR color and per-mesh velocity, with the MSAA depth
 * retained, and tracks each mesh's previous transform for safe motion vectors.
 */
export class WebGpuGeometry {

  /**
   * @param {GPU.WebGPURenderer} renderer - The native renderer.
   * @param {Object} [options] - The stage options.
   * @param {GPU.Scene} [options.scene] - The scene to render.
   * @param {GPU.Camera} [options.camera] - The camera to render with; its layers are set to OPAQUE_LAYER for the draw.
   * @param {number} [options.samples=4] - The requested MSAA level. The native backend supports 1 or 4, so values are clamped.
   * @param {number} [options.exposure=1.6] - The encoding exposure shared with the decode stage.
   * @param {string} [options.encoding='rgb'] - The MSAA curve, one of {@link ENCODINGS}.
   * @param {Object} [options.specularAA] - Specular antialiasing settings: `{enabled, variance, threshold}`.
   * @param {Object} [options.grazingClamp] - Grazing clamp settings: `{enabled, angle, limit}`.
   */
  constructor(renderer, {
    scene = null,
    camera = null,
    samples = 4,
    exposure = 1.6,
    encoding = 'rgb',
    specularAA = {},
    grazingClamp = {},
  } = {}) {
    if (!renderer) throw new Error('WebGpuGeometry: a native WebGPURenderer is required');
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    this.specularAA = new SpecularAntialiasing(specularAA);
    this.grazingClamp = new GrazingSpecularClamp(grazingClamp);
    this._materialClasses = createMaterialClasses(this.specularAA, this.grazingClamp);

    this._exposure = T.uniform(exposure);
    this._encoding = T.uniform(encodingIndex(encoding));

    // Unjittered view-projections of the current and the previous frame, in the reference's WebGL NDC.
    this._viewProjection = T.uniform(new GPU.Matrix4());
    this._previousViewProjection = T.uniform(new GPU.Matrix4());
    // Shared color output: the MRT the renderer uses while drawing, so the material MRT can stay per mesh.
    this._mrt = T.mrt({ output: T.output });
    this._clearColor = new GPU.Color(0, 0, 0);
    this._background = new GPU.Color(0, 0, 0);

    this._samples = normalizeSamples(samples);
    this._width = 1;
    this._height = 1;
    this._target = createGeometryTarget(this._width, this._height, this._samples);

    /** @type {Array<Object>} Per-mesh records created by prepare(), in traversal order. Read-only for consumers. */
    this.meshes = [];
    this._materials = [];

    this._frame = 0;
    this._lastViewProjection = null;
    this._pendingViewProjection = null;
    this._moved = false;
    this._disposed = false;
  }

  /** The render target: texture 0 is encoded color, texture 1 is velocity, `depthTexture` is the retained MSAA depth. */
  get target() {
    return this._target;
  }

  /** The actual MSAA level of the attachments: 1 or {@link MAX_SAMPLES}. */
  get samples() {
    return this._samples;
  }

  set samples(value) {
    const samples = normalizeSamples(value);
    if (samples === this._samples) return;
    this._samples = samples;
    this._reallocate();
  }

  /** The encoding exposure shared with the decode stage. */
  get exposure() {
    return this._exposure.value;
  }

  set exposure(value) {
    this._exposure.value = value;
  }

  /** The MSAA curve, one of {@link ENCODINGS}. */
  get encoding() {
    return ENCODINGS[this._encoding.value];
  }

  set encoding(value) {
    this._encoding.value = encodingIndex(value);
  }

  /** The unjittered view-projection the current frame's velocity uses, in the reference's WebGL NDC. */
  get viewProjection() {
    return this._viewProjection.value;
  }

  /** The previous frame's view-projection, which the velocity shader subtracts. */
  get previousViewProjection() {
    return this._previousViewProjection.value;
  }

  /**
   * Converts the materials of the loader model in place: opaque materials write encoded color and velocity,
   * transparent ones are converted but left unencoded and moved to {@link GLASS_LAYER}.
   *
   * The model object is kept as it is, not cloned, so runtime motion of the loaded graph stays visible.
   *
   * @param {GPU.Object3D} model - The loaded model root.
   */
  prepare(model) {
    this._assertNotDisposed();
    if (!model || typeof model.traverse !== 'function') throw new Error('WebGpuGeometry.prepare: an Object3D model is required');
    model.updateMatrixWorld(true);

    model.traverse((child) => {
      if (child.isMesh !== true) return;
      if (this.meshes.some((record) => record.mesh === child)) return;

      const materialArray = Array.isArray(child.material);
      const sourceMaterials = materialArray ? child.material : [child.material];
      const glass = sourceMaterials.some((material) => material.transparent === true);

      const record = {
        mesh: child,
        glass,
        sourceMaterials,
        materialArray,
        materials: [],
        // Model matrices of this frame and of the last frame the mesh was drawn, plus the bookkeeping that
        // makes a culled or newly visible mesh restart from rest instead of jumping from its last position.
        currentModel: glass ? null : T.uniform(new GPU.Matrix4()),
        previousModel: glass ? null : T.uniform(new GPU.Matrix4()),
        previousMatrix: new GPU.Matrix4(),
        lastDrawnMatrix: new GPU.Matrix4(),
        lastDrawnFrame: -1,
        previousLayers: child.layers.mask,
        previousOnBeforeRender: child.onBeforeRender,
      };

      record.materials = sourceMaterials.map((source) => this._convertMaterial(source, record));
      child.material = materialArray ? record.materials.slice() : record.materials[0];
      // Layer separation of TonemappedResolvePass.prepare: glass is drawn by the transparency stage, the
      // opaque meshes must stay in the geometry pass.
      child.layers.set(glass ? GLASS_LAYER : OPAQUE_LAYER);

      // Recorded at draw time, like the reference VelocityBuffer: a mesh that was not drawn restarts from rest.
      child.onBeforeRender = (...args) => {
        record.previousOnBeforeRender.apply(child, args);
        if (record.lastDrawnFrame === this._frame) return;
        this._moved ||= !record.previousMatrix.equals(child.matrixWorld);
        record.lastDrawnMatrix.copy(child.matrixWorld);
        record.lastDrawnFrame = this._frame;
      };

      this.meshes.push(record);
    });
  }

  /**
   * Draws the opaque layer.
   *
   * @param {Object} options - The frame inputs.
   * @param {GPU.Matrix4} options.projection - The unjittered WebGL projection (Z -1..1). It is used as given for
   *   the velocity; the draw itself uses the camera's own projection through the renderer's coordinate system.
   * @return {{color: GPU.Texture, velocity: GPU.Texture, depth: GPU.Texture, target: GPU.RenderTarget, meshesMoved: boolean}}
   *   The resolved encoded HDR color, the resolved velocity, the retained MSAA depth32float texture, the target
   *   the outputs belong to, and whether any mesh moved independently of the camera.
   */
  render({ projection } = {}) {
    this._assertNotDisposed();
    const { renderer, scene, camera } = this;
    if (scene === null || camera === null) throw new Error('WebGpuGeometry.render: options.scene and options.camera are required');
    if (!projection || projection.isMatrix4 !== true) throw new Error('WebGpuGeometry.render: an unjittered WebGL projection Matrix4 is required');

    // Commit the previous frame if the caller did not call finishFrame().
    this.finishFrame();

    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    this._frame += 1;
    this._moved = false;

    const viewProjection = new GPU.Matrix4().multiplyMatrices(projection, camera.matrixWorldInverse);
    this._viewProjection.value.copy(viewProjection);
    // The reference VelocityBuffer.update: the first frame reports no motion at all.
    this._previousViewProjection.value.copy(this._lastViewProjection === null ? viewProjection : this._lastViewProjection);

    const previousFrame = this._frame - 1;
    for (const record of this.meshes) {
      const drawnLastFrame = record.lastDrawnFrame === previousFrame;
      record.previousMatrix.copy(drawnLastFrame ? record.lastDrawnMatrix : record.mesh.matrixWorld);
      if (record.currentModel !== null) {
        record.currentModel.value.copy(record.mesh.matrixWorld);
        record.previousModel.value.copy(record.previousMatrix);
      }
    }

    const background = scene.background;
    // The reference clear pass clears to the encoded background color; a texture background cannot be
    // encoded here and is left to the post-color stage.
    const clearColor = background !== null && background.isColor === true
      ? encodeColor(background, this._exposure.value, ENCODINGS[this._encoding.value], this._clearColor)
      : this._clearColor.setRGB(0, 0, 0);

    // Everything below is restored in finally, whatever the draw does.
    const previousTarget = renderer.getRenderTarget();
    const previousCubeFace = renderer.getActiveCubeFace();
    const previousMipmapLevel = renderer.getActiveMipmapLevel();
    const previousMRT = renderer.getMRT();
    const previousLayers = camera.layers.mask;
    const previousAutoClear = renderer.autoClear;
    const previousAutoClearColor = renderer.autoClearColor;
    const previousAutoClearDepth = renderer.autoClearDepth;
    const previousAutoClearStencil = renderer.autoClearStencil;

    try {
      scene.background = null;
      camera.layers.set(OPAQUE_LAYER);

      // The attachments own their clear values, so the stage does not depend on the caller's autoClear setup.
      renderer.autoClear = true;
      renderer.autoClearColor = true;
      renderer.autoClearDepth = true;
      renderer.autoClearStencil = false;

      this._mrt.setClearColor('output', clearColor, 1);
      this._mrt.setClearColor('velocity', this._background, 0);

      renderer.setRenderTarget(this._target);
      renderer.setMRT(this._mrt);
      renderer.render(scene, camera);
    } finally {
      renderer.setMRT(previousMRT);
      renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel);
      scene.background = background;
      camera.layers.mask = previousLayers;
      renderer.autoClear = previousAutoClear;
      renderer.autoClearColor = previousAutoClearColor;
      renderer.autoClearDepth = previousAutoClearDepth;
      renderer.autoClearStencil = previousAutoClearStencil;
    }

    this._pendingViewProjection = viewProjection;

    return {
      color: this._target.textures[0],
      velocity: this._target.textures[1],
      depth: this._target.depthTexture,
      target: this._target,
      meshesMoved: this._moved,
    };
  }

  /**
   * Commits this frame as the previous frame for the next one. render() calls it itself when the caller did
   * not, so a pipeline that never commits still gets frame-to-frame motion.
   */
  finishFrame() {
    if (this._pendingViewProjection === null) return;
    this._lastViewProjection = this._pendingViewProjection;
    this._pendingViewProjection = null;
  }

  /**
   * Drops all motion history: the next frame after a reset reports no motion, as after a camera cut.
   */
  reset() {
    this._frame = 0;
    this._lastViewProjection = null;
    this._pendingViewProjection = null;
    this._moved = false;
    for (const record of this.meshes) {
      record.lastDrawnFrame = -1;
    }
  }

  /**
   * Sets the physical pixel size of the attachments. Resizing reallocates the target, so consumers must not
   * hold on to the textures it returned earlier.
   *
   * @param {number} width - Physical width in pixels.
   * @param {number} height - Physical height in pixels.
   */
  setSize(width, height) {
    this._assertNotDisposed();
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));
    if (nextWidth === this._width && nextHeight === this._height) return;
    this._width = nextWidth;
    this._height = nextHeight;
    this._reallocate();
  }

  /**
   * Frees the target and the converted materials and puts the model back to its original materials, layers
   * and onBeforeRender hooks. Idempotent.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    for (const record of this.meshes) {
      record.mesh.material = record.materialArray ? record.sourceMaterials.slice() : record.sourceMaterials[0];
      record.mesh.layers.mask = record.previousLayers;
      record.mesh.onBeforeRender = record.previousOnBeforeRender;
    }
    this.meshes.length = 0;

    for (const material of this._materials) material.dispose();
    this._materials.length = 0;
    this._target.dispose();
  }

  _reallocate() {
    this._target.dispose();
    this._target = createGeometryTarget(this._width, this._height, this._samples);
  }

  _convertMaterial(source, record) {
    if (source === null || source === undefined || source.isMeshStandardMaterial !== true) {
      const name = source?.name || source?.type || String(source);
      throw new Error(`WebGpuGeometry: "${name}" is not a standard or physical material, which are the only ones this stage ports natively`);
    }
    const Base = source.isMeshPhysicalMaterial === true ? this._materialClasses.physical : this._materialClasses.standard;
    const material = new Base().copy(source);

    if (!record.glass) {
      material.outputNode = createEncodedOutputNode(this._exposure, this._encoding);
      material.mrtNode = T.mrt({ velocity: createVelocityNode(this._viewProjection, this._previousViewProjection, record.currentModel, record.previousModel) });
    }

    this._materials.push(material);
    return material;
  }

  _assertNotDisposed() {
    if (this._disposed) throw new Error('WebGpuGeometry: used after dispose()');
  }

}
