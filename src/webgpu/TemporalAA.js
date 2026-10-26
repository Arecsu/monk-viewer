// Native WebGPU temporal antialiasing component. Ports src/postprocessing/TemporalAAPass.ts: the same jitter,
// Gaussian reconstruction, Catmull-Rom history filter, YCoCg clamping, validation, locks and bounds. Algorithmic
// coordinates stay WebGL bottom-left; storage conversion happens only at texture boundaries.
import * as GPU from 'three/webgpu';
import * as TSL from 'three/tsl';
import { Box3, Matrix4, Vector2, Vector4 } from 'three';
import { webglProjection } from './Common.js';
import { TemporalAABounds } from '../postprocessing/TemporalAABounds.ts';
import { createTemporalAAMaterial } from './TemporalAAShader.js';

const BOX_MODES = ['variance', 'minmax', 'intersection'];
const FULL_SCREEN = new Vector4(0, 0, 1, 1);

/**
 * Radical inverse in the given base, used for the Halton sequence.
 *
 * @param {number} index - One-based sample index.
 * @param {number} base - Halton base.
 * @returns {number} The radical inverse.
 */
export function halton(index, base) {
  let result = 0;
  let f = 1;
  for (let i = index; i > 0; i = Math.floor(i / base)) {
    f /= base;
    result += f * (i % base);
  }
  return result;
}

/**
 * Jitter offset for a frame, in pixels. Frame zero uses the first Halton position, as the reference pass does.
 *
 * @param {number} frame - Zero-based frame index.
 * @param {number} samples - Number of Halton positions in the cycle.
 * @param {number} scale - Jitter amplitude in pixels.
 * @returns {{x: number, y: number}} The offset.
 */
export function jitterOffsetForFrame(frame, samples, scale) {
  const count = Math.max(1, Math.floor(samples));
  const index = (frame % count) + 1;
  return {
    x: (halton(index, 2) - 0.5) * scale,
    y: (halton(index, 3) - 0.5) * scale
  };
}

/**
 * Converts an algorithmic bottom-left pixel to native top-left texture storage. The shader applies the same flip.
 *
 * @param {number} x - Logical pixel X.
 * @param {number} y - Logical pixel Y.
 * @param {number} height - Texture height in pixels.
 * @returns {{x: number, y: number}} Storage pixel.
 */
export function logicalPixelToStorage(x, y, height) {
  return { x, y: height - 1 - y };
}

/**
 * Converts an algorithmic bottom-left UV to native top-left storage UV. Velocity stays (current - previous) in
 * logical UV, positive X right, positive Y up; this flip is only for reading/writing storage.
 *
 * @param {number} u - Logical U.
 * @param {number} v - Logical V.
 * @returns {{u: number, v: number}} Storage UV.
 */
export function logicalUVToStorage(u, v) {
  return { u, v: 1 - v };
}

function matricesEqual(a, b) {
  for (let i = 0; i < 16; ++i) {
    if (Math.abs(a.elements[i] - b.elements[i]) > 1e-6) return false;
  }
  return true;
}

/**
 * A public reactiveMask toggle (including an explicit null) is authoritative; only an unset component follows the
 * per-frame render input.
 *
 * @param {boolean} explicit - Whether the component's reactiveMask property was set.
 * @param {?GPU.Texture} own - The component's mask.
 * @param {?GPU.Texture} input - The mask passed to render().
 * @returns {?GPU.Texture} The mask to bind.
 */
export function effectiveReactiveMask(explicit, own, input) {
  return explicit ? own : (input ?? null);
}

/**
 * Whether the frame counts as still for static convergence. An independent per-mesh motion signal must prevent a
 * false still frame even when the camera and tracked object matrices are unchanged.
 *
 * @param {Object} state - Matrices and motion inputs.
 * @returns {boolean} True when static convergence may run.
 */
export function isTemporalStill({ staticConvergence, historyValid, viewProjection, previousViewProjection,
  objectMatrix, previousObjectMatrix, meshesMoved }) {
  return Boolean(staticConvergence) && Boolean(historyValid) &&
    matricesEqual(viewProjection, previousViewProjection) &&
    matricesEqual(objectMatrix, previousObjectMatrix) &&
    !meshesMoved;
}

function createHistoryTarget(width, height) {
  // One draw writes all three: accumulated history, the decoded output, and the per-pixel state for motion blur.
  const target = new GPU.RenderTarget(width, height, { depthBuffer: false, stencilBuffer: false, count: 3 });
  const [history, output, state] = target.textures;

  history.name = 'history';
  history.type = GPU.HalfFloatType;
  history.format = GPU.RGBAFormat;
  history.internalFormat = 'rgba16float';
  history.colorSpace = GPU.NoColorSpace;
  history.minFilter = history.magFilter = GPU.LinearFilter;
  history.generateMipmaps = false;

  output.name = 'output';
  output.type = GPU.HalfFloatType;
  output.format = GPU.RGBFormat;
  output.internalFormat = 'rg11b10ufloat';
  output.colorSpace = GPU.NoColorSpace;
  output.minFilter = output.magFilter = GPU.LinearFilter;
  output.generateMipmaps = false;

  // Not filtered: the shader fetches state texels, and half-precision motion must not interpolate across edges.
  state.name = 'state';
  state.type = GPU.HalfFloatType;
  state.format = GPU.RGBAFormat;
  state.internalFormat = 'rgba16float';
  state.colorSpace = GPU.NoColorSpace;
  state.minFilter = state.magFilter = GPU.NearestFilter;
  state.generateMipmaps = false;

  return target;
}

/**
 * Native WebGPU temporal antialiasing for one bounded rigid object in front of a static background.
 *
 * Options match {@link TemporalAAPass}. Frame order:
 * `beginFrame()` -> geometry.render({projection}) -> transparency -> `render({color,depth,velocity,reactiveMask,
 * meshesMoved})` -> `endFrame()`. `endFrame()` restores the unjittered native camera projection even after an abort.
 */
export class WebGpuTemporalAA {

  /**
   * @param {GPU.WebGPURenderer} renderer - The initialized native renderer.
   * @param {Object} options - TemporalAAPass options plus `{scene, camera, trackedObject}`.
   */
  constructor(renderer, options = {}) {
    const {
      scene = null,
      camera = null,
      trackedObject = null,
      exposure = 1.0,
      blend = 0.2,
      jitterScale = 1.0,
      jitterSamples = 8,
      filterSharpness = 5.0,
      motionFilterSharpness = null,
      motionFilterScale = 1.0,
      jitterCompensation = false,
      staticBlend = 0.02,
      staticConvergence = true,
      varianceGamma = 1.0,
      clampHistory = true,
      backgroundFastPath = false,
      neighbourhood = 5,
      boxMode = 'variance',
      clipTowardsCurrent = false,
      depthRejection = false,
      depthTolerance = 0.0015,
      motionRejection = false,
      motionTolerance = 1.0,
      trustedGamma = 2.0,
      disocclusionBlend = 0.35,
      thinFeatureLocks = false,
      lockFrames = 8,
      lockSimilarity = 0.75,
      lockStrength = 1.0,
      edgeAdaptiveBlend = false,
      edgeBlend = 0.08,
      sampleConfidence = false,
      lockMaxSpeed = 0.0,
      reactiveMask = null,
      reactiveStrength = 1.0,
      velocityBuffer = null,
      enabled = true,
      debugView = 0
    } = options;

    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.trackedObject = trackedObject;

    this._uniforms = {
      enabled: TSL.uniform(true),
      exposure: TSL.uniform(exposure),
      blend: TSL.uniform(blend),
      varianceGamma: TSL.uniform(varianceGamma),
      historyValid: TSL.uniform(false),
      clipHistory: TSL.uniform(true),
      moving: TSL.uniform(true),
      filterSharpness: TSL.uniform(filterSharpness),
      motionFilterSharpness: TSL.uniform(motionFilterSharpness ?? filterSharpness),
      motionFilterScale: TSL.uniform(motionFilterScale),
      jitterCompensation: TSL.uniform(jitterCompensation ? 1.0 : 0.0),
      neighbourCount: TSL.uniform(neighbourhood, 'int'),
      boxMode: TSL.uniform(Math.max(BOX_MODES.indexOf(boxMode), 0), 'int'),
      clipTowardsCurrent: TSL.uniform(clipTowardsCurrent),
      depthRejection: TSL.uniform(depthRejection),
      depthTolerance: TSL.uniform(depthTolerance),
      motionRejection: TSL.uniform(motionRejection),
      motionTolerance: TSL.uniform(motionTolerance),
      trustedGamma: TSL.uniform(trustedGamma),
      disocclusionBlend: TSL.uniform(disocclusionBlend),
      thinFeatureLocks: TSL.uniform(thinFeatureLocks),
      lockStep: TSL.uniform(1.0 / Math.max(lockFrames, 1.0)),
      lockMaxSpeed: TSL.uniform(lockMaxSpeed),
      lockSimilarity: TSL.uniform(lockSimilarity),
      lockStrength: TSL.uniform(lockStrength),
      edgeAdaptiveBlend: TSL.uniform(edgeAdaptiveBlend),
      edgeBlend: TSL.uniform(edgeBlend),
      sampleConfidence: TSL.uniform(sampleConfidence),
      reactiveStrength: TSL.uniform(0.0),
      debugView: TSL.uniform(debugView, 'int'),
      useVelocityBuffer: TSL.uniform(false),
      inverseViewProjectionJittered: TSL.uniform(new Matrix4()),
      viewProjection: TSL.uniform(new Matrix4()),
      previousViewProjection: TSL.uniform(new Matrix4()),
      objectMotion: TSL.uniform(new Matrix4()),
      texelSize: TSL.uniform(new Vector2(1, 1)),
      size: TSL.uniform(new Vector2(1, 1)),
      jitterOffset: TSL.uniform(new Vector2()),
      previousJitter: TSL.uniform(new Vector2()),
      backgroundBounds: TSL.uniform(new Vector4(0, 0, 1, 1))
    };

    // 1x1 opaque stand-ins. The shader only reads them when the corresponding feature is disabled.
    this._black = new GPU.DataTexture(new Uint8Array(4), 1, 1);
    this._black.needsUpdate = true;

    this._targets = [createHistoryTarget(1, 1), createHistoryTarget(1, 1)];
    // Explicit dummy UVs disable TextureNode's automatic matrix uniforms. Every read supplies its own logical UV
    // or pixel and performs the single top-left storage conversion itself; raw render-target textures have no useful
    // matrix, so the default UV would only add unused mat3 uniforms to every sample/load clone.
    const noMatrixUV = TSL.vec2(0);
    this._textureNodes = {
      color: TSL.texture(undefined, noMatrixUV),
      depth: TSL.texture(undefined, noMatrixUV),
      velocity: TSL.texture(this._black, noMatrixUV),
      reactive: TSL.texture(this._black, noMatrixUV),
      history: TSL.texture(this._targets[0].textures[0], noMatrixUV),
      state: TSL.texture(this._targets[0].textures[2], noMatrixUV)
    };

    this._width = 1;
    this._height = 1;
    this._frame = 0;
    this._stillFrames = 0;
    this._historyValid = false;
    this._disposed = false;
    this._jittered = false;
    this._jitterCamera = null;

    this._blend = blend;
    this._staticBlend = staticBlend;
    this._staticConvergence = staticConvergence;
    this._clampHistory = clampHistory;
    this._backgroundFastPath = backgroundFastPath;
    this._jitterScale = jitterScale;
    this._jitterSamples = jitterSamples;
    this._reactiveStrength = reactiveStrength;
    this._reactiveMask = reactiveMask ? reactiveMask : null;
    this._reactiveMaskExplicit = Object.prototype.hasOwnProperty.call(options, 'reactiveMask');
    this._velocityBuffer = velocityBuffer ? velocityBuffer : null;

    this._projection = new Matrix4();
    this._savedNativeProjection = new Matrix4();
    this._viewProjection = new Matrix4();
    this._previousViewProjection = new Matrix4();
    this._objectMatrix = new Matrix4();
    this._previousObjectMatrix = new Matrix4();
    this._jitter = new Vector2();
    this._boundsProjector = new TemporalAABounds();
    this._worldBounds = new Box3();
    this._currentBounds = new Vector4();
    this._previousBounds = new Vector4(0, 0, 1, 1);

    this.material = createTemporalAAMaterial(this._uniforms, this._textureNodes);
    this._quad = new GPU.QuadMesh(this.material);

    // Native material; the uniform view keeps aa-lab's reference tuning panel working without a GLSL material.
    this.fullscreenMaterial = {
      name: 'TemporalAAMaterial',
      outputPrecision: 'mediump',
      uniforms: this._uniforms
    };

    this._uniforms.useVelocityBuffer.value = this._velocityBuffer !== null;
    this.enabled = enabled;
    this.reset();
  }

  /** Physical render width in pixels. */
  get width() { return this._width; }

  /** Physical render height in pixels. */
  get height() { return this._height; }

  /** The number of still frames accumulated by static convergence. */
  get stillFrames() { return this._stillFrames; }

  /** Whether the history is valid for the next frame. */
  get historyValid() { return this._historyValid; }

  /** Padded screen footprint certified by the bounded fast path, in logical UV. Full screen if unavailable. */
  get backgroundBounds() { return this._uniforms.backgroundBounds.value; }

  /** The state written by the latest frame: (depth, lock, motion.xy). */
  get stateTexture() { return this._targets[this._frame % 2].textures[2]; }

  /** The HDR output texture written by the latest frame. */
  get outputTexture() { return this._targets[this._frame % 2].textures[1]; }

  get enabled() { return this._enabled; }

  set enabled(value) {
    const next = Boolean(value);
    if (this._enabled === next) return;
    this._enabled = next;
    this._uniforms.enabled.value = next;
    this.reset();
  }

  get exposure() { return this._uniforms.exposure.value; }
  set exposure(value) { this._uniforms.exposure.value = value; }

  get blend() { return this._blend; }
  set blend(value) { this._blend = value; }

  get staticBlend() { return this._staticBlend; }
  set staticBlend(value) { this._staticBlend = value; }

  get staticConvergence() { return this._staticConvergence; }
  set staticConvergence(value) { this._staticConvergence = Boolean(value); }

  get clampHistory() { return this._clampHistory; }
  set clampHistory(value) { this._clampHistory = Boolean(value); }

  get backgroundFastPath() { return this._backgroundFastPath; }
  set backgroundFastPath(value) { this._backgroundFastPath = Boolean(value); }

  get jitterScale() { return this._jitterScale; }
  set jitterScale(value) { this._jitterScale = value; }

  get jitterSamples() { return this._jitterSamples; }
  set jitterSamples(value) { this._jitterSamples = value; }

  get filterSharpness() { return this._uniforms.filterSharpness.value; }
  set filterSharpness(value) { this._uniforms.filterSharpness.value = value; }

  get motionFilterSharpness() { return this._uniforms.motionFilterSharpness.value; }
  set motionFilterSharpness(value) { this._uniforms.motionFilterSharpness.value = value; }

  get motionFilterScale() { return this._uniforms.motionFilterScale.value; }
  set motionFilterScale(value) { this._uniforms.motionFilterScale.value = value; }

  get varianceGamma() { return this._uniforms.varianceGamma.value; }
  set varianceGamma(value) { this._uniforms.varianceGamma.value = value; }

  get jitterCompensation() { return this._uniforms.jitterCompensation.value !== 0.0; }
  set jitterCompensation(value) { this._uniforms.jitterCompensation.value = value ? 1.0 : 0.0; }

  get neighbourhood() { return this._uniforms.neighbourCount.value; }
  set neighbourhood(value) { this._uniforms.neighbourCount.value = value; }

  get boxMode() { return BOX_MODES[this._uniforms.boxMode.value] ?? 'variance'; }
  set boxMode(value) { this._uniforms.boxMode.value = Math.max(BOX_MODES.indexOf(value), 0); }

  get clipTowardsCurrent() { return this._uniforms.clipTowardsCurrent.value; }
  set clipTowardsCurrent(value) { this._uniforms.clipTowardsCurrent.value = Boolean(value); }

  get depthRejection() { return this._uniforms.depthRejection.value; }
  set depthRejection(value) { this._uniforms.depthRejection.value = Boolean(value); }

  get depthTolerance() { return this._uniforms.depthTolerance.value; }
  set depthTolerance(value) { this._uniforms.depthTolerance.value = value; }

  get motionRejection() { return this._uniforms.motionRejection.value; }
  set motionRejection(value) { this._uniforms.motionRejection.value = Boolean(value); }

  get motionTolerance() { return this._uniforms.motionTolerance.value; }
  set motionTolerance(value) { this._uniforms.motionTolerance.value = value; }

  get trustedGamma() { return this._uniforms.trustedGamma.value; }
  set trustedGamma(value) { this._uniforms.trustedGamma.value = value; }

  get disocclusionBlend() { return this._uniforms.disocclusionBlend.value; }
  set disocclusionBlend(value) { this._uniforms.disocclusionBlend.value = value; }

  get thinFeatureLocks() { return this._uniforms.thinFeatureLocks.value; }
  set thinFeatureLocks(value) { this._uniforms.thinFeatureLocks.value = Boolean(value); }

  get lockFrames() { return 1.0 / this._uniforms.lockStep.value; }
  set lockFrames(value) { this._uniforms.lockStep.value = 1.0 / Math.max(value, 1.0); }

  get lockSimilarity() { return this._uniforms.lockSimilarity.value; }
  set lockSimilarity(value) { this._uniforms.lockSimilarity.value = value; }

  get lockStrength() { return this._uniforms.lockStrength.value; }
  set lockStrength(value) { this._uniforms.lockStrength.value = value; }

  get edgeAdaptiveBlend() { return this._uniforms.edgeAdaptiveBlend.value; }
  set edgeAdaptiveBlend(value) { this._uniforms.edgeAdaptiveBlend.value = Boolean(value); }

  get edgeBlend() { return this._uniforms.edgeBlend.value; }
  set edgeBlend(value) { this._uniforms.edgeBlend.value = value; }

  get sampleConfidence() { return this._uniforms.sampleConfidence.value; }
  set sampleConfidence(value) { this._uniforms.sampleConfidence.value = Boolean(value); }

  get lockMaxSpeed() { return this._uniforms.lockMaxSpeed.value; }
  set lockMaxSpeed(value) { this._uniforms.lockMaxSpeed.value = value; }

  get reactiveStrength() { return this._reactiveStrength; }
  set reactiveStrength(value) { this._reactiveStrength = value; }

  /**
   * Public reactive-mask toggle. Setting it (including to null) makes the component authoritative, so a per-frame
   * render input cannot silently re-enable a mask the viewer turned off.
   */
  get reactiveMask() { return this._reactiveMask; }

  set reactiveMask(value) {
    this._reactiveMask = value ? value : null;
    this._reactiveMaskExplicit = true;
  }

  /** Truthy per-mesh velocity input. False/undefined keeps the analytic rigid-object reprojection fallback. */
  get velocityBuffer() { return this._velocityBuffer; }

  set velocityBuffer(value) {
    this._velocityBuffer = value ? value : null;
    this._uniforms.useVelocityBuffer.value = this._velocityBuffer !== null;
    this.reset();
  }

  get debugView() { return this._uniforms.debugView.value; }
  set debugView(value) { this._uniforms.debugView.value = value; }

  /**
   * Saves the native camera projection, returns the unjittered WebGL-NDC projection for the geometry frame and
   * applies the reference Halton jitter when enabled. The returned matrix is owned by this component until the next
   * beginFrame.
   *
   * @returns {{projection: Matrix4}} Unjittered WebGL projection (Z -1..1).
   */
  beginFrame() {
    if (this._disposed) throw new Error('WebGpuTemporalAA: beginFrame() after dispose()');
    const camera = this.camera;
    if (!camera || camera.isPerspectiveCamera !== true) {
      throw new Error('WebGpuTemporalAA: a PerspectiveCamera is required');
    }

    // A previous frame that never reached endFrame() is restored before the new save, so a lost call cannot bake
    // the old jitter into the new "native" projection.
    if (this._jittered) this.endFrame();

    this._savedNativeProjection.copy(camera.projectionMatrix);
    this._projection.copy(webglProjection(camera, camera.projectionMatrix));

    if (typeof this._velocityBuffer?.update === 'function') {
      this._velocityBuffer.update(camera, this._projection);
    }

    this._jitterCamera = camera;
    this._jittered = true;

    if (!this._enabled) {
      this._jitter.set(0, 0);
      this._uniforms.jitterOffset.value.set(0, 0);
      this._uniforms.previousJitter.value.set(0, 0);
      return { projection: this._projection };
    }

    const { x, y } = jitterOffsetForFrame(this._frame, this._jitterSamples, this._jitterScale);
    const elements = camera.projectionMatrix.elements;
    elements[8] += (2.0 * x) / this._width;
    elements[9] += (2.0 * y) / this._height;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

    this._uniforms.previousJitter.value.copy(this._jitter);
    this._jitter.set(x, y);
    this._uniforms.jitterOffset.value.copy(this._jitter);

    return { projection: this._projection };
  }

  /**
   * Restores the native camera projection saved by beginFrame(). Idempotent and safe after a failed render.
   */
  endFrame() {
    if (this._jittered && this._jitterCamera !== null) {
      this._jitterCamera.projectionMatrix.copy(this._savedNativeProjection);
      this._jitterCamera.projectionMatrixInverse.copy(this._savedNativeProjection).invert();
    }
    this._jittered = false;
    this._jitterCamera = null;
  }

  /**
   * Resolves the current frame into the history/output/state targets.
   *
   * @param {Object} input - `{color, depth, velocity, reactiveMask, meshesMoved}`. Textures are borrowed.
   * @returns {{color: GPU.Texture, state: GPU.Texture}} The output and state textures written this frame.
   */
  render({ color, depth, velocity = null, reactiveMask = null, meshesMoved = undefined } = {}) {
    if (this._disposed) throw new Error('WebGpuTemporalAA: render() after dispose()');
    if (!color || !depth) throw new Error('WebGpuTemporalAA: render() requires color and depth textures');

    const camera = this.camera;
    if (!camera || camera.isPerspectiveCamera !== true) {
      throw new Error('WebGpuTemporalAA: a PerspectiveCamera is required');
    }

    // With TAA disabled the pipeline reports no motion and the state is unused; a missing velocity texture must not
    // block the bypass. While enabled, a truthy velocityBuffer promises a per-mesh input and silently falling back
    // to rigid reprojection would weaken the algorithm.
    const useVelocity = this._velocityBuffer !== null && velocity !== null;
    if (this._enabled && this._velocityBuffer !== null && velocity === null) {
      throw new Error('WebGpuTemporalAA: velocityBuffer is set but render() received no velocity texture');
    }
    // A public reactiveMask toggle is authoritative; only an unset component follows the per-frame input.
    const mask = effectiveReactiveMask(this._reactiveMaskExplicit, this._reactiveMask, reactiveMask);
    const uniform = this._uniforms;

    this._textureNodes.color.value = color;
    this._textureNodes.depth.value = depth;
    this._textureNodes.velocity.value = useVelocity ? velocity : this._black;
    this._textureNodes.reactive.value = mask ?? this._black;
    uniform.useVelocityBuffer.value = useVelocity;
    uniform.reactiveStrength.value = mask ? this._reactiveStrength : 0.0;

    // camera.matrixWorldInverse and the object matrix were updated while rendering the geometry.
    const jitteredProjection = webglProjection(camera, camera.projectionMatrix);
    uniform.inverseViewProjectionJittered.value
      .multiplyMatrices(jitteredProjection, camera.matrixWorldInverse)
      .invert();
    this._viewProjection.multiplyMatrices(this._projection, camera.matrixWorldInverse);
    uniform.viewProjection.value.copy(this._viewProjection);
    uniform.previousViewProjection.value.copy(this._previousViewProjection);
    this._updateBackgroundBounds();

    if (this.trackedObject !== null) {
      this._objectMatrix.copy(this.trackedObject.matrixWorld);
      uniform.objectMotion.value.copy(this._objectMatrix).invert().premultiply(this._previousObjectMatrix);
    } else {
      this._objectMatrix.identity();
      uniform.objectMotion.value.identity();
    }

    const velocityMoved = useVelocity &&
      (meshesMoved ?? this._velocityBuffer?.meshesMoved ?? false);
    const still = isTemporalStill({
      staticConvergence: this._staticConvergence,
      historyValid: this._historyValid,
      viewProjection: this._viewProjection,
      previousViewProjection: this._previousViewProjection,
      objectMatrix: this._objectMatrix,
      previousObjectMatrix: this._previousObjectMatrix,
      meshesMoved: velocityMoved
    });

    this._stillFrames = still ? this._stillFrames + 1 : 0;
    uniform.historyValid.value = this._historyValid;
    uniform.blend.value = still ?
      Math.max(1.0 / (1.0 / this._blend + this._stillFrames), this._staticBlend) : this._blend;
    uniform.clipHistory.value = this._clampHistory && !still;
    uniform.moving.value = !still;

    const historyRead = this._targets[this._frame % 2];
    const historyWrite = this._targets[(this._frame + 1) % 2];
    this._textureNodes.history.value = historyRead.textures[0];
    this._textureNodes.state.value = historyRead.textures[2];

    const renderer = this.renderer;
    const previousTarget = renderer.getRenderTarget();
    const previousMRT = renderer.getMRT?.() ?? null;
    try {
      renderer.setMRT(null);
      renderer.setRenderTarget(historyWrite);
      this._quad.render(renderer);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.setMRT(previousMRT);
    }

    this._historyValid = true;
    uniform.historyValid.value = true;
    this._previousViewProjection.copy(this._viewProjection);
    this._previousObjectMatrix.copy(this._objectMatrix);
    this._previousBounds.copy(uniform.backgroundBounds.value);
    ++this._frame;

    return { color: historyWrite.textures[1], state: historyWrite.textures[2] };
  }

  /**
   * Physical render size. Reallocates history only when the integer size changes and invalidates history/bounds.
   *
   * @param {number} width - Physical width.
   * @param {number} height - Physical height.
   */
  setSize(width, height) {
    if (this._disposed) return;
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this._width && h === this._height) return;
    this._width = w;
    this._height = h;
    this._targets.forEach((target) => target.setSize(w, h));
    this._uniforms.size.value.set(w, h);
    this._uniforms.texelSize.value.set(1.0 / w, 1.0 / h);
    this.reset();
  }

  /**
   * Discards history, restarts the jitter sequence and expands the certified bounds until the next render.
   */
  reset() {
    this._frame = 0;
    this._stillFrames = 0;
    this._historyValid = false;
    this._uniforms.historyValid.value = false;
    this._uniforms.previousJitter.value.copy(this._jitter);
    this.backgroundBounds.copy(FULL_SCREEN);
    this._previousBounds.copy(FULL_SCREEN);
  }

  _updateBackgroundBounds() {
    const bounds = this._currentBounds.copy(FULL_SCREEN);
    const scene = this.scene;
    const object = this.trackedObject;
    const background = scene?.background;

    if (this._backgroundFastPath && this._clampHistory && object !== null && scene !== null &&
      !scene.fog && background?.isColor === true &&
      background.r === 0 && background.g === 0 && background.b === 0) {
      // Box3 includes the glass even though it doesn't write depth. Recompute from cached geometry boxes so child
      // transforms and camera motion stay covered.
      this._worldBounds.setFromObject(object);
      this._boundsProjector.project(this._worldBounds, this._viewProjection, this._width, this._height,
        3 + Math.abs(this._jitterScale), bounds);
    }

    const output = this.backgroundBounds;
    output.copy(bounds);

    if (this._historyValid) {
      // Keep the entire history footprint, not just last frame's silhouette. An unsafe projection expands this to
      // full screen until the next reset().
      output.set(Math.min(bounds.x, this._previousBounds.x), Math.min(bounds.y, this._previousBounds.y),
        Math.max(bounds.z, this._previousBounds.z), Math.max(bounds.w, this._previousBounds.w));
    }
  }

  /** Releases targets, the material and the fallback texture. Idempotent. */
  dispose() {
    if (this._disposed) return;
    this.endFrame();
    this._disposed = true;
    this._targets.forEach((target) => target.dispose());
    this.material.dispose();
    this._black.dispose();
  }

}
