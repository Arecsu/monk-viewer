// Native WebGPU geometry stage: opaque forward shading into encoded HDR + per-mesh velocity, with the
// MSAA depth retained for the later stages (4x native; 2x and 8x are two averaged draws, see SAMPLE_LAYOUTS). This is a port of the reference geometry stage:
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

/**
 * How each logical MSAA level is rendered. WebGPU only allows 1 or 4 hardware samples, so 2x and 8x are built from
 * two draws of the scene at complementary sub-pixel offsets whose resolves are averaged:
 *
 * - 8x: two 4x MSAA draws offset by ±(1/16, 1/16) px. The union of the two rotated-grid 4x patterns is 8 samples with
 *   8 distinct rows and columns (n-rooks), like the D3D 8x pattern: (-1,-5) (7,-1) (-5,3) (3,7) / (-3,-7) (5,-3)
 *   (-7,1) (1,5) in 1/16 px. Coverage is 8x, shading 2 per pixel (one per draw), geometry cost 2x.
 * - 2x: two single-sample draws at the standard 2x positions ±(4/16, 4/16) px. Both coverage and shading are
 *   sampled twice, so this is 2x supersampling: a little better than real 2x MSAA on shading aliasing.
 *
 * The resolves are averaged in the encoded (tonemapped) space, which is exactly the encoded average of all the
 * samples. The pattern is symmetric under the y flip, so the projection's NDC-up offsets give the same set.
 */
export const SAMPLE_LAYOUTS = Object.freeze({
  0: Object.freeze({ hardwareSamples: 0, offsets: Object.freeze([[0, 0]]) }),
  2: Object.freeze({ hardwareSamples: 0, offsets: Object.freeze([[0.25, 0.25], [-0.25, -0.25]]) }),
  4: Object.freeze({ hardwareSamples: 4, offsets: Object.freeze([[0, 0]]) }),
  8: Object.freeze({ hardwareSamples: 4, offsets: Object.freeze([[0.0625, 0.0625], [-0.0625, -0.0625]]) }),
});

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
 * The logical MSAA level: 0, 2, 4 or 8, rounded down (see {@link SAMPLE_LAYOUTS}). The auto-tuner decides by testing
 * `samples > 0`, so a disabled stage stays 0, never 1.
 */
export function normalizeSamples(samples) {
  return samples >= 8 ? 8 : samples >= 4 ? 4 : samples >= 2 ? 2 : 0;
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

    return T.mix(T.float(1), scale, grazing.mul(this._strength));
  }

  /**
   * Applies the clamp to a lighting model's base outgoing light, before the physical model composes
   * clearcoat and sheen on top of it.
   *
   * The reference scales `reflectedLight.indirectSpecular` right after `lights_fragment_end`, i.e. before
   * `totalSpecular` and the clearcoat/sheen composition. The node lighting model has already folded the base
   * indirect specular into `outgoingLight` by the time `finish()` can be patched, so the same scale arrives
   * as a delta on that base value, and it has to be added before `finish()` composes the layers.
   *
   * @param {Object} context - The lighting context of the current build.
   * @param {Object} [extraScale] - Another scale of the indirect specular, applied in the same delta so the two
   *   multiply instead of each subtracting from the original (see {@link EdgeReflections#factor}).
   */
  apply(context, extraScale = null) {
    const indirectSpecular = context.reflectedLight.indirectSpecular;
    const scale = extraScale === null ? this.factor(indirectSpecular) : this.factor(indirectSpecular).mul(extraScale);
    const clamped = indirectSpecular.mul(scale);
    context.outgoingLight.assign(context.outgoingLight.add(clamped.sub(indirectSpecular)));
  }

}

/**
 * Edge reflection settings, for the bright sub-pixel lines along silhouettes and edge-on surfaces.
 *
 * At a silhouette the surface is seen exactly edge-on: the normal is perpendicular to the view ray, Fresnel is ~1
 * and the mirror reflection continues straight along the ray, i.e. it shows whatever is behind the object. When
 * that matches what the neighbouring background pixels show, coverage doesn't matter and the edge can't alias (the
 * "corrected edge normals + Fresnel + SSR" trick). Two things break it here:
 *
 * - Normals past edge-on. Interpolated and normal-mapped normals near a silhouette often face slightly away from the
 *   camera. three clamps N·V to 0 (full Fresnel) and the reflection vector bends back to some unrelated, often bright,
 *   part of the environment. `correctNormals` tilts the shading normal towards the view direction just enough to keep
 *   N·V >= minNdotV, so the reflection continues along the view ray instead.
 * - The background. The environment lights the model but the visible background is black, so the correct grazing
 *   reflection is a bright line on black: the worst case for antialiasing. `backgroundMatch` fades the environment
 *   reflection towards the visible background (black) as the reflection direction approaches the view ray. That only
 *   happens at grazing angles, so the faces seen head on and at moderate angles are unchanged.
 *
 * With the environment shown as the background (see WebGpuGeometry's background), the grazing reflection already
 * matches the pixels around it and the background match switches itself off.
 *
 * Not physically based: the model is lit by a world the camera doesn't show. Uniforms, so they change without a
 * recompile; all on by default.
 */
class EdgeReflections {

  // Defaults tuned in the AA lab: all on, full match, ground glass edges fully rough
  constructor({ correctNormals = true, minNdotV = 0.02, backgroundMatch = 1, width = 0.18,
    groundGlassEdges = true, glassEdgeRoughness = 1 } = {}) {
    this._groundEdges = T.uniform(groundGlassEdges ? 1 : 0);
    // 1 while the environment is drawn as the background: a grazing reflection then already matches it
    this._backgroundVisible = T.uniform(0);
    this._edgeRoughness = T.uniform(glassEdgeRoughness);
    this._correct = T.uniform(correctNormals ? 1 : 0);
    this._minNdotV = T.uniform(minNdotV);
    this._match = T.uniform(backgroundMatch);
    this._width = T.uniform(width);
  }

  /** Keeps the shading normal facing the camera by at least {@link minNdotV}. */
  get correctNormals() {
    return this._correct.value > 0;
  }

  set correctNormals(value) {
    this._correct.value = value ? 1 : 0;
  }

  /** The smallest N·V the corrected normal keeps; near 0 the reflection runs along the view ray. */
  get minNdotV() {
    return this._minNdotV.value;
  }

  set minNdotV(value) {
    this._minNdotV.value = value;
  }

  /** How much of the grazing environment reflection is replaced by the black background, 0..1. */
  get backgroundMatch() {
    return this._match.value;
  }

  set backgroundMatch(value) {
    this._match.value = value;
  }

  /**
   * The fade's reach, as 1 - cos of the angle between the reflection and the view ray: 0.18 fades reflections
   * within ~35° of the ray, i.e. surfaces within ~17° of edge-on.
   */
  get width() {
    return this._width.value;
  }

  set width(value) {
    this._width.value = value;
  }

  /**
   * Gives the thin side faces of glass panes this much roughness at least, as if their edges were ground (as framing
   * glass usually is) instead of polished. A polished 2 mm edge mirrors the environment's lamps into a sub-pixel line,
   * and the glass is drawn after the MSAA resolve, single-sampled, so nothing but TAA antialiases it.
   */
  get groundGlassEdges() {
    return this._groundEdges.value > 0;
  }

  set groundGlassEdges(value) {
    this._groundEdges.value = value ? 1 : 0;
  }

  get glassEdgeRoughness() {
    return this._edgeRoughness.value;
  }

  set glassEdgeRoughness(value) {
    this._edgeRoughness.value = value;
  }

  /**
   * Returns the roughness of a glass pane, raised to {@link glassEdgeRoughness} on the faces whose (flat) normal is
   * perpendicular to the pane's thickness axis, i.e. its edges.
   *
   * @param {Object} roughness - The material's roughness node.
   * @param {Object} thicknessAxis - The pane's thinnest axis in object space (a vec3 node).
   * @return {Object} The roughness node.
   */
  roughenGlassEdges(roughness, thicknessAxis) {
    const edge = T.float(1).sub(T.normalLocal.dot(thicknessAxis).abs()).mul(this._groundEdges);
    return T.mix(roughness, roughness.max(this._edgeRoughness), edge);
  }

  /**
   * Returns the shading normal tilted towards the view direction where N·V < minNdotV: n + v * (minNdotV - N·V)
   * brings N·V to exactly minNdotV before normalizing, the smallest change that does.
   *
   * @param {Object} normal - The view-space shading normal, normal maps included.
   * @return {Object} The corrected normal node.
   */
  correct(normal) {
    const view = T.positionViewDirection;
    const deficit = this._minNdotV.sub(normal.dot(view)).max(0).mul(this._correct);
    return normal.add(view.mul(deficit)).normalize();
  }

  /**
   * Returns the multiplier for the indirect specular: 1 until the reflection direction comes within {@link width} of
   * the view ray, then towards 1 - backgroundMatch.
   *
   * @return {Object} The scale node.
   */
  factor() {
    const view = T.positionViewDirection;
    // Mirror direction of the eye ray; dot with the ray is 1 exactly edge-on, -1 head on.
    const reflected = T.reflect(view.negate(), T.normalView);
    const alignment = reflected.dot(view.negate());
    const grazing = T.smoothstep(T.float(1).sub(this._width), 1, alignment);
    return T.float(1).sub(grazing.mul(this._match).mul(T.float(1).sub(this._backgroundVisible)));
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
 * Creates the environment background: a fullscreen triangle at the far plane, drawn last in the opaque pass so it
 * only shades the pixels (MSAA samples) no surface covered. It writes the same encoded colour as the opaque
 * materials, so the MSAA resolve of a silhouette against it is tonemapped like any other edge, and a camera-only
 * velocity (the direction at infinity, w = 0, so camera translation doesn't move it) for TAA and the motion blur.
 * The depth stays at the far plane: TAA, the glass and the motion blur still treat these pixels as background.
 */
function createBackgroundMesh(texture, { blurriness, intensity, exposure, encoding, viewProjection, previousViewProjection }) {
  const geometry = new GPU.BufferGeometry();
  geometry.setAttribute('position', new GPU.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));

  const material = new GPU.MeshBasicNodeMaterial({ name: 'EnvironmentBackgroundMaterial', depthWrite: false, depthTest: true });
  material.depthFunc = GPU.LessEqualDepth;
  const clip = T.vec4(T.positionGeometry.xy, 1, 1);
  material.vertexNode = clip;
  // World direction of the pixel through the camera's own (jittered) projection, so it is sampled like the geometry.
  const view = T.cameraProjectionMatrixInverse.mul(clip);
  const direction = T.varying(T.cameraWorldMatrix.mul(T.vec4(view.xyz.div(view.w), 0)).xyz, 'v_backgroundDirection').normalize();
  const radiance = T.pmremTexture(texture, direction, blurriness).rgb.mul(intensity);
  material.colorNode = T.vec4(radiance, 1);
  material.outputNode = createEncodedOutputNode(exposure, encoding);

  const current = viewProjection.mul(T.vec4(direction, 0));
  const previous = previousViewProjection.mul(T.vec4(direction, 0));
  const motion = current.xy.div(current.w).sub(previous.xy.div(previous.w)).mul(0.5);
  material.mrtNode = T.mrt({ velocity: T.vec4(motion, 0, 0) });

  const mesh = new GPU.Mesh(geometry, material);
  mesh.name = 'EnvironmentBackground';
  mesh.frustumCulled = false;
  mesh.renderOrder = Number.MAX_SAFE_INTEGER;
  mesh.layers.set(OPAQUE_LAYER);
  return mesh;
}

/**
 * Creates the two material classes the converted model uses. Both stay node materials (so the NodeMaterial
 * program cache key keeps its TSL graph identity) and only inject the roughness filter and the optional
 * specular clamp.
 */
function createMaterialClasses(specularAA, grazingClamp, edgeReflections) {
  const create = (Base) => class extends Base {

    setupNormal(builder) {
      // normalView, and through it the lighting and the reflection vector, read this
      return edgeReflections.correct(super.setupNormal(builder));
    }

    setupVariants(builder) {
      super.setupVariants(builder);
      // Glass panes: the thin side faces, ground instead of polished (see EdgeReflections.groundGlassEdges)
      if (this.paneThicknessAxis) T.roughness.assign(edgeReflections.roughenGlassEdges(T.roughness, this.paneThicknessAxis));
      // Equal to the reference patch: only ever makes surfaces rougher, normal maps included.
      T.roughness.assign(specularAA.filter(T.roughness, T.normalView));
      if (this.useClearcoat) T.clearcoatRoughness.assign(specularAA.filter(T.clearcoatRoughness, T.clearcoatNormalView));
    }

    setupLightingModel() {
      const model = super.setupLightingModel();
      const finish = model.finish.bind(model);
      model.finish = (builder) => {
        // The clamp scales the base outgoing light first: the physical model's finish then composes
        // clearcoat and sheen on the clamped value, exactly like the reference clamp before that composition.
        grazingClamp.apply(builder.context, edgeReflections.factor());
        finish(builder);
      };
      return model;
    }

  };
  // One class per base kind, so every converted mesh of a kind is an instance of the same class.
  return { standard: create(GPU.MeshStandardNodeMaterial), physical: create(GPU.MeshPhysicalNodeMaterial) };
}

/** Sets up the two attachments shared by the geometry and the merge targets: encoded HDR color and velocity. */
function configureAttachments(target) {
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
  return target;
}

/**
 * Creates the geometry render target: encoded HDR color + nearest velocity, both actually multisampled (when
 * samples is 4), with the depth samples retained for later stages.
 */
function createGeometryTarget(width, height, samples) {
  const target = configureAttachments(new GPU.RenderTarget(width, height, { depthBuffer: true, stencilBuffer: false, samples, count: 2 }));

  // DepthFormat + FloatType is depth32float; without reverse depth, near is 0 and far is 1.
  target.depthTexture = new GPU.DepthTexture(width, height, GPU.FloatType);

  // Resolve the multisampled color in hardware, then discard it: only the resolved HDR is needed.
  target.storeMultisampledColorBuffer = false;
  // Keep the multisampled depth: TAA and the glass pass read its sample 0, there is no implicit depth resolve.
  target.storeMultisampledDepthBuffer = true;

  return target;
}

/** The single-sample target the resolves of a two-draw level are averaged into. */
function createMergeTarget(width, height) {
  return configureAttachments(new GPU.RenderTarget(width, height, { depthBuffer: false, stencilBuffer: false, count: 2 }));
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
   * @param {number} [options.samples=4] - The logical MSAA level: 0, 2, 4 or 8, see {@link SAMPLE_LAYOUTS}.
   * @param {number} [options.exposure=1.6] - The encoding exposure shared with the decode stage.
   * @param {string} [options.encoding='rgb'] - The MSAA curve, one of {@link ENCODINGS}.
   * @param {Object} [options.specularAA] - Specular antialiasing settings: `{enabled, variance, threshold}`.
   * @param {Object} [options.grazingClamp] - Grazing clamp settings: `{enabled, angle, limit}`.
   * @param {Object} [options.edgeReflections] - Edge reflection settings: `{correctNormals, minNdotV,
   *   backgroundMatch, width}`, see {@link EdgeReflections}.
   */
  constructor(renderer, {
    scene = null,
    camera = null,
    samples = 4,
    exposure = 1.6,
    encoding = 'rgb',
    specularAA = {},
    grazingClamp = {},
    edgeReflections = {},
  } = {}) {
    if (!renderer) throw new Error('WebGpuGeometry: a native WebGPURenderer is required');
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    this.specularAA = new SpecularAntialiasing(specularAA);
    this.grazingClamp = new GrazingSpecularClamp(grazingClamp);
    this.edgeReflections = new EdgeReflections(edgeReflections);
    this._materialClasses = createMaterialClasses(this.specularAA, this.grazingClamp, this.edgeReflections);

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
    this._target = null;
    // Two-draw levels only: the target of the second draw, and the averaged resolve.
    this._secondTarget = null;
    this._mergeTarget = null;
    this._mergeSources = null;
    this._mergeQuad = null;
    this._savedProjection = new GPU.Matrix4();
    // The environment background, built for the first texture background and rebuilt if it changes
    this._backgroundMesh = null;
    this._backgroundTexture = null;
    this._backgroundBlurriness = T.uniform(0);
    this._backgroundIntensity = T.uniform(1);
    this._allocate();

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

  /**
   * The logical MSAA level: 0, 2, 4 or 8 (see {@link SAMPLE_LAYOUTS}), 0 when disabled. With 0 the multitarget is
   * single-sampled (`target.samples === 0`, like the reference's `msaaSamples`), which is what the auto-tuner tests.
   */
  get samples() {
    return this._samples;
  }

  set samples(value) {
    const samples = normalizeSamples(value);
    if (samples === this._samples) return;
    this._samples = samples;
    this._reallocate();
  }

  /** How the current level renders: `{hardwareSamples, draws}`, e.g. 8x is two draws of 4x MSAA. */
  get sampleLayout() {
    const layout = SAMPLE_LAYOUTS[this._samples];
    return { hardwareSamples: layout.hardwareSamples, draws: layout.offsets.length };
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
   * Whether a mesh moved independently of the camera in the current frame. `render()` also returns the value
   * as it stood after the geometry draw; this getter stays live, so a pipeline can read it after the
   * transparency pass and see a glass pane that moved on its own as well.
   */
  get meshesMoved() {
    return this._moved;
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
   *   the outputs belong to, and whether any mesh moved independently of the camera as of this draw (the live
   *   value afterwards, glass included, is the {@link meshesMoved} getter).
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
    // The reference clear pass clears to the encoded background color. A texture background (the environment's
    // PMREM, `scene.background = scene.environment`) is drawn by the opaque pass itself, see createBackgroundMesh.
    const backgroundMesh = this._prepareBackground(background, scene);
    this.edgeReflections._backgroundVisible.value = backgroundMesh === null ? 0 : 1;
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
      if (backgroundMesh !== null) scene.add(backgroundMesh);
      camera.layers.set(OPAQUE_LAYER);

      // The attachments own their clear values, so the stage does not depend on the caller's autoClear setup.
      renderer.autoClear = true;
      renderer.autoClearColor = true;
      renderer.autoClearDepth = true;
      renderer.autoClearStencil = false;

      this._mrt.setClearColor('output', clearColor, 1);
      this._mrt.setClearColor('velocity', this._background, 0);

      const { offsets } = SAMPLE_LAYOUTS[this._samples];
      if (offsets.length === 1) {
        renderer.setRenderTarget(this._target);
        renderer.setMRT(this._mrt);
        renderer.render(scene, camera);
      } else {
        this._renderDraws(offsets);
      }
    } finally {
      renderer.setMRT(previousMRT);
      renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel);
      scene.background = background;
      if (backgroundMesh !== null) scene.remove(backgroundMesh);
      camera.layers.mask = previousLayers;
      renderer.autoClear = previousAutoClear;
      renderer.autoClearColor = previousAutoClearColor;
      renderer.autoClearDepth = previousAutoClearDepth;
      renderer.autoClearStencil = previousAutoClearStencil;
    }

    this._pendingViewProjection = viewProjection;

    // Two-draw levels hand out the averaged resolve; the depth is the main draw's, the one `target` returns.
    const resolved = this._mergeTarget ?? this._target;
    return {
      color: resolved.textures[0],
      velocity: resolved.textures[1],
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
    this._releaseTargets();
    this._mergeQuad?.material.dispose();
    this._disposeBackground();
  }

  /**
   * Draws the scene once per offset and averages the resolves. The offsets shift the projection (on top of any TAA
   * jitter) by a fraction of a render pixel; the velocity uses the unjittered projection uniforms and is unaffected.
   * The main target is drawn last, so its retained depth and the `target` getter belong to the same draw.
   */
  _renderDraws(offsets) {
    const { renderer, camera } = this;
    const projection = camera.projectionMatrix;
    this._savedProjection.copy(projection);
    try {
      offsets.forEach(([x, y], index) => {
        projection.copy(this._savedProjection);
        projection.elements[8] += (2 * x) / this._width;
        projection.elements[9] += (2 * y) / this._height;
        camera.projectionMatrixInverse.copy(projection).invert();
        renderer.setRenderTarget(index === offsets.length - 1 ? this._target : this._secondTarget);
        renderer.setMRT(this._mrt);
        renderer.render(this.scene, camera);
      });
    } finally {
      projection.copy(this._savedProjection);
      camera.projectionMatrixInverse.copy(projection).invert();
    }

    const sources = this._mergeSources;
    sources.colorA.value = this._target.textures[0];
    sources.colorB.value = this._secondTarget.textures[0];
    sources.velocityA.value = this._target.textures[1];
    sources.velocityB.value = this._secondTarget.textures[1];
    renderer.setMRT(null);
    renderer.setRenderTarget(this._mergeTarget);
    this._mergeQuad.render(renderer);
  }

  /**
   * Returns the background mesh for a texture background (null for a colour or none), with the scene's
   * backgroundBlurriness (PMREM level, 0 sharp) and backgroundIntensity applied.
   */
  _prepareBackground(background, scene) {
    if (background === null || background === undefined || background.isTexture !== true) return null;
    if (this._backgroundTexture !== background) {
      this._disposeBackground();
      this._backgroundTexture = background;
      this._backgroundMesh = createBackgroundMesh(background, {
        blurriness: this._backgroundBlurriness, intensity: this._backgroundIntensity,
        exposure: this._exposure, encoding: this._encoding,
        viewProjection: this._viewProjection, previousViewProjection: this._previousViewProjection,
      });
    }
    this._backgroundBlurriness.value = scene.backgroundBlurriness ?? 0;
    this._backgroundIntensity.value = scene.backgroundIntensity ?? 1;
    return this._backgroundMesh;
  }

  _disposeBackground() {
    if (this._backgroundMesh === null) return;
    this._backgroundMesh.geometry.dispose();
    this._backgroundMesh.material.dispose();
    this._backgroundMesh = null;
    this._backgroundTexture = null;
  }

  /** The averaging pass: both attachments in one draw, same size, so storage pixels map 1:1. */
  _createMergeQuad() {
    // Dummy uvs keep TextureNode from adding texture matrix uniforms to the loads.
    const node = () => T.texture(new GPU.Texture(), T.vec2(0));
    const sources = { colorA: node(), colorB: node(), velocityA: node(), velocityB: node() };
    const pixel = T.ivec2(T.screenCoordinate.xy);
    const color = T.textureLoad(sources.colorA, pixel).rgb.add(T.textureLoad(sources.colorB, pixel).rgb).mul(0.5);
    const velocity = T.textureLoad(sources.velocityA, pixel).add(T.textureLoad(sources.velocityB, pixel)).mul(0.5);
    const material = new GPU.MeshBasicNodeMaterial({ name: 'GeometryMergeMaterial', depthTest: false, depthWrite: false, toneMapped: false });
    material.blending = GPU.NoBlending;
    material.colorNode = T.vec4(color, 1);
    // Member order matches the attachment order: color, velocity.
    material.outputNode = T.outputStruct(T.vec4(color, 1), velocity);
    this._mergeSources = sources;
    return new GPU.QuadMesh(material);
  }

  _allocate() {
    const layout = SAMPLE_LAYOUTS[this._samples];
    this._target = createGeometryTarget(this._width, this._height, layout.hardwareSamples);
    if (layout.offsets.length > 1) {
      this._secondTarget = createGeometryTarget(this._width, this._height, layout.hardwareSamples);
      this._mergeTarget = createMergeTarget(this._width, this._height);
      this._mergeQuad ??= this._createMergeQuad();
    }
  }

  _releaseTargets() {
    this._target?.dispose();
    this._secondTarget?.dispose();
    this._mergeTarget?.dispose();
    this._target = this._secondTarget = this._mergeTarget = null;
  }

  _reallocate() {
    this._releaseTargets();
    this._allocate();
    // A resize or a sample change invalidates the previous frame: the attachments and the motion history
    // both restart, so the first frame in the new configuration reports no motion.
    this.reset();
  }

  _convertMaterial(source, record) {
    if (source === null || source === undefined || source.isMeshStandardMaterial !== true) {
      const name = source?.name || source?.type || String(source);
      throw new Error(`WebGpuGeometry: "${name}" is not a standard or physical material, which are the only ones this stage ports natively`);
    }
    const Base = source.isMeshPhysicalMaterial === true ? this._materialClasses.physical : this._materialClasses.standard;
    const material = new Base().copy(source);

    if (record.glass) {
      // A pane: one bounding box extent much thinner than the other two. Its edges are the faces along that axis.
      const geometry = record.mesh.geometry;
      if (geometry.boundingBox === null) geometry.computeBoundingBox();
      const size = geometry.boundingBox.getSize(new GPU.Vector3()).toArray();
      const sorted = [...size].sort((a, b) => a - b);
      if (sorted[0] < 0.1 * sorted[1]) {
        const axis = size.indexOf(sorted[0]);
        material.paneThicknessAxis = T.vec3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
      }
    } else {
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
