import assert from "node:assert/strict";
import test from "node:test";
import { BoxGeometry, Color, Matrix4, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, Texture, WebGPUCoordinateSystem } from "three";
import * as GPU from "three/webgpu";
import { webglProjection } from "../src/webgpu/Common.js";
import { createTemporalAAMaterial } from "../src/webgpu/TemporalAAShader.js";
import {
  WebGpuTemporalAA,
  effectiveReactiveMask,
  halton,
  isTemporalStill,
  jitterOffsetForFrame,
  jitterPhaseCount,
  logicalPixelToStorage,
  logicalUVToStorage
} from "../src/webgpu/TemporalAA.js";

function makeCamera(coordinateSystem = WebGPUCoordinateSystem): PerspectiveCamera {
  const camera = new PerspectiveCamera(50, 1.5, 0.03, 100);
  camera.coordinateSystem = coordinateSystem;
  camera.position.set(0, 0, 1);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return camera;
}

function makeTaa(options: Record<string, unknown> = {}): WebGpuTemporalAA {
  const camera = (options.camera as PerspectiveCamera | undefined) ?? makeCamera();
  const scene = (options.scene as Scene | undefined) ?? new Scene();
  return new WebGpuTemporalAA({}, { ...options, camera, scene });
}


// Full TSL graph build without a device. WGSLNodeBuilder is the same class the native backend uses, so this catches
// lazy node materialization and texture-binding regressions that merely executing callback bodies cannot.
function buildTemporalAAWGSL({ renderWidth = 19, renderHeight = 13, options = {} as Record<string, unknown>, specialized = false } = {}) {
  const width = 19, height = 13;
  const renderer = new GPU.WebGPURenderer({ antialias: false, canvas: { width, height, style: {} } });
  // The backend is not initialized; feature queries only affect generated texture helpers, not the shader graph.
  renderer.hasFeature = () => false;
  const target = new GPU.RenderTarget(width, height, { count: 3, depthBuffer: false });
  target.textures[0].name = "history";
  target.textures[1].name = "output";
  target.textures[2].name = "state";
  renderer.setRenderTarget(target);
  const camera = makeCamera();
  camera.position.set(0, 0, 2);
  camera.updateMatrixWorld();
  const scene = new GPU.Scene();
  const taa = new WebGpuTemporalAA(renderer, { camera, scene, ...options });
  taa.setSize(width, height, renderWidth, renderHeight);
  const input = new GPU.RenderTarget(renderWidth, renderHeight, { depthBuffer: true });
  input.depthTexture = new GPU.DepthTexture(renderWidth, renderHeight, GPU.FloatType);
  taa._textureNodes.color.value = input.texture;
  taa._textureNodes.depth.value = input.depthTexture;
  // render() picks the material; the graph build here needs it chosen up front
  if (specialized) taa._quad.material = (taa as any)._selectMaterial();
  else if (taa.upscaling) taa._quad.material = taa._upscaleMaterial = createUpscaleMaterial(taa);
  const builder = new GPU.WGSLNodeBuilder(taa._quad, renderer);
  builder.scene = scene;
  builder.camera = camera;
  builder.build();
  return { taa, target, input, builder, source: builder.fragmentShader };
}

function createUpscaleMaterial(taa: WebGpuTemporalAA) {
  return createTemporalAAMaterial((taa as any)._uniforms, (taa as any)._textureNodes, { upscale: true });
}

function wgslVariableDepths(source: string) {
  const lines = source.split("\n");
  const depths: number[] = [];
  let depth = 0;
  for (const line of lines) {
    depths.push(depth);
    for (const character of line.replace(/\/\/.*$/, "")) {
      if (character === "{") depth++;
      else if (character === "}") depth--;
    }
  }
  return (name: string) => {
    const assignments: Array<{ depth: number; line: number }> = [];
    const reads: Array<{ depth: number; line: number }> = [];
    const declaration = new RegExp(`^var<private>\\s+${name}\\s*:`);
    const assignment = new RegExp(`^\\s*${name}\\s*=`);
    const word = new RegExp(`\\b${name}\\b`);
    lines.forEach((line, index) => {
      if (declaration.test(line)) return;
      if (assignment.test(line)) assignments.push({ depth: depths[index], line: index });
      else if (word.test(line)) reads.push({ depth: depths[index], line: index });
    });
    return { assignments, reads };
  };
}

const FULL = [0, 0, 1, 1];

test("reference defaults are present and every tuning option is mutable", () => {
  const taa = makeTaa();
  try {
    assert.equal(taa.exposure, 1);
    assert.equal(taa.blend, 0.2);
    assert.equal(taa.jitterScale, 1);
    assert.equal(taa.jitterSamples, 8);
    assert.equal(taa.filterSharpness, 5);
    assert.equal(taa.motionFilterSharpness, 5);
    assert.equal(taa.motionFilterScale, 1);
    assert.equal(taa.jitterCompensation, false);
    assert.equal(taa.staticBlend, 0.02);
    assert.equal(taa.staticConvergence, true);
    assert.equal(taa.varianceGamma, 1);
    assert.equal(taa.clampHistory, true);
    assert.equal(taa.backgroundFastPath, false);
    assert.equal(taa.neighbourhood, 5);
    assert.equal(taa.boxMode, "variance");
    assert.equal(taa.clipTowardsCurrent, false);
    assert.equal(taa.depthRejection, false);
    assert.equal(taa.depthTolerance, 0.0015);
    assert.equal(taa.motionRejection, false);
    assert.equal(taa.motionTolerance, 1);
    assert.equal(taa.trustedGamma, 2);
    assert.equal(taa.disocclusionBlend, 0.35);
    assert.equal(taa.thinFeatureLocks, false);
    assert.equal(taa.lockFrames, 8);
    assert.equal(taa.lockSimilarity, 0.75);
    assert.equal(taa.lockStrength, 1);
    assert.equal(taa.edgeAdaptiveBlend, false);
    assert.equal(taa.edgeBlend, 0.08);
    assert.equal(taa.sampleConfidence, false);
    assert.equal(taa.lockMaxSpeed, 0);
    assert.equal(taa.enabled, true);
    assert.equal(taa.debugView, 0);
    assert.equal(taa.reactiveMask, null);
    assert.equal(taa.velocityBuffer, null);
    assert.equal(taa.historyValid, false);
    assert.equal(taa.stillFrames, 0);

    taa.exposure = 5.15;
    taa.blend = 0.15;
    taa.jitterScale = 0.65;
    taa.jitterSamples = 16;
    taa.filterSharpness = 3;
    taa.motionFilterSharpness = 2;
    taa.motionFilterScale = 0.5;
    taa.jitterCompensation = true;
    taa.staticBlend = 0.01;
    taa.staticConvergence = false;
    taa.varianceGamma = 1.5;
    taa.clampHistory = false;
    taa.backgroundFastPath = true;
    taa.neighbourhood = 9;
    taa.boxMode = "intersection";
    taa.clipTowardsCurrent = true;
    taa.depthRejection = true;
    taa.depthTolerance = 0.002;
    taa.motionRejection = true;
    taa.motionTolerance = 2;
    taa.trustedGamma = 3;
    taa.disocclusionBlend = 0.5;
    taa.thinFeatureLocks = true;
    taa.lockFrames = 4;
    taa.lockSimilarity = 0.5;
    taa.lockStrength = 0.75;
    taa.edgeAdaptiveBlend = true;
    taa.edgeBlend = 0.1;
    taa.sampleConfidence = true;
    taa.lockMaxSpeed = 12;
    taa.debugView = 4;

    assert.equal(taa.exposure, 5.15);
    assert.equal(taa.blend, 0.15);
    assert.equal(taa.jitterScale, 0.65);
    assert.equal(taa.jitterSamples, 16);
    assert.equal(taa.filterSharpness, 3);
    assert.equal(taa.motionFilterSharpness, 2);
    assert.equal(taa.motionFilterScale, 0.5);
    assert.equal(taa.jitterCompensation, true);
    assert.equal(taa.staticBlend, 0.01);
    assert.equal(taa.staticConvergence, false);
    assert.equal(taa.varianceGamma, 1.5);
    assert.equal(taa.clampHistory, false);
    assert.equal(taa.backgroundFastPath, true);
    assert.equal(taa.neighbourhood, 9);
    assert.equal(taa.boxMode, "intersection");
    assert.equal(taa.clipTowardsCurrent, true);
    assert.equal(taa.depthRejection, true);
    assert.equal(taa.depthTolerance, 0.002);
    assert.equal(taa.motionRejection, true);
    assert.equal(taa.motionTolerance, 2);
    assert.equal(taa.trustedGamma, 3);
    assert.equal(taa.disocclusionBlend, 0.5);
    assert.equal(taa.thinFeatureLocks, true);
    assert.equal(taa.lockFrames, 4);
    assert.equal(taa.lockSimilarity, 0.5);
    assert.equal(taa.lockStrength, 0.75);
    assert.equal(taa.edgeAdaptiveBlend, true);
    assert.equal(taa.edgeBlend, 0.1);
    assert.equal(taa.sampleConfidence, true);
    assert.equal(taa.lockMaxSpeed, 12);
    assert.equal(taa.debugView, 4);

    // Native uniforms are the same knobs the reference pass exposed; aa-lab reads these .value fields directly.
    const uniforms = taa.fullscreenMaterial.uniforms;
    assert.equal(uniforms.boxMode.value, 2);
    assert.equal(uniforms.neighbourCount.value, 9);
    assert.equal(uniforms.lockStep.value, 0.25);
    assert.equal(uniforms.jitterCompensation.value, 1);
    assert.equal(uniforms.clipTowardsCurrent.value, true);
    assert.equal(uniforms.debugView.value, 4);
    assert.equal(uniforms.blend.value, 0.2);
    assert.equal(uniforms.clipHistory.value, true);
    assert.equal(taa.fullscreenMaterial.name, "TemporalAAMaterial");
  } finally {
    taa.dispose();
  }
});

test("beginFrame returns the unjittered WebGL projection and endFrame restores the native camera", () => {
  const camera = makeCamera();
  const taa = makeTaa({ camera });
  try {
    taa.setSize(900, 600);
    const nativeBefore = camera.projectionMatrix.clone();
    const inverseBefore = camera.projectionMatrixInverse.clone();

    const { projection } = taa.beginFrame();
    const expected = webglProjection(camera, nativeBefore);
    for (let i = 0; i < 16; ++i) assert.equal(projection.elements[i], expected.elements[i]);
    // Native depth 0..1 becomes WebGL NDC -1..1 only in the reprojection matrix; the camera keeps native depth.
    assert.notEqual(expected.elements[10], nativeBefore.elements[10]);

    const offset = jitterOffsetForFrame(0, 8, 1);
    const jittered = camera.projectionMatrix;
    assert.ok(Math.abs(jittered.elements[8] - nativeBefore.elements[8] - 2 * offset.x / 900) < 1e-12);
    assert.ok(Math.abs(jittered.elements[9] - nativeBefore.elements[9] - 2 * offset.y / 600) < 1e-12);
    assert.ok(Math.abs(taa.fullscreenMaterial.uniforms.jitterOffset.value.y - offset.y) < 1e-12);

    taa.endFrame();
    assert.ok(camera.projectionMatrix.equals(nativeBefore));
    assert.ok(camera.projectionMatrixInverse.equals(inverseBefore));
  } finally {
    taa.dispose();
  }
});

test("endFrame restores the camera after an aborted frame and is idempotent", () => {
  const camera = makeCamera();
  const taa = makeTaa({ camera });
  try {
    const before = camera.projectionMatrix.clone();
    taa.beginFrame();
    try {
      throw new Error("pipeline abort");
    } catch {
      // A pipeline failure must not leave the camera jittered.
    } finally {
      taa.endFrame();
    }
    assert.ok(camera.projectionMatrix.equals(before));
    taa.endFrame();
    assert.ok(camera.projectionMatrix.equals(before));
    assert.equal(taa.historyValid, false);
  } finally {
    taa.dispose();
  }
});

test("disabled TAA does not jitter or filter the camera", () => {
  const camera = makeCamera();
  const taa = makeTaa({ camera, enabled: false });
  try {
    taa.setSize(900, 600);
    const before = camera.projectionMatrix.clone();
    const { projection } = taa.beginFrame();
    assert.ok(camera.projectionMatrix.equals(before));
    assert.deepEqual(taa.fullscreenMaterial.uniforms.jitterOffset.value.toArray(), [0, 0]);
    assert.deepEqual(taa.fullscreenMaterial.uniforms.previousJitter.value.toArray(), [0, 0]);
    assert.ok(projection.equals(webglProjection(camera, before)));
    taa.endFrame();

    taa.enabled = true;
    assert.equal(taa.fullscreenMaterial.uniforms.enabled.value, true);
    taa.beginFrame();
    assert.ok(!camera.projectionMatrix.equals(before));
    taa.endFrame();
  } finally {
    taa.dispose();
  }
});

test("jitter uses the reference Halton sequence, cycles, and reset restarts it", () => {
  assert.equal(halton(1, 2), 0.5);
  assert.ok(Math.abs(halton(1, 3) - 1 / 3) < 1e-12);
  assert.deepEqual(jitterOffsetForFrame(0, 8, 0), { x: 0, y: -0 });
  assert.notDeepEqual(jitterOffsetForFrame(0, 8, 1), jitterOffsetForFrame(1, 8, 1));
  assert.deepEqual(jitterOffsetForFrame(8, 8, 1), jitterOffsetForFrame(0, 8, 1));

  const taa = makeTaa();
  try {
    taa.setSize(900, 600);
    const first = jitterOffsetForFrame(0, taa.jitterSamples, taa.jitterScale);
    taa.beginFrame();
    assert.ok(Math.abs(taa.fullscreenMaterial.uniforms.jitterOffset.value.x - first.x) < 1e-12);
    assert.ok(Math.abs(taa.fullscreenMaterial.uniforms.jitterOffset.value.y - first.y) < 1e-12);
    taa.endFrame();

    taa.backgroundBounds.set(0.2, 0.2, 0.8, 0.8);
    taa.reset();
    assert.deepEqual(taa.backgroundBounds.toArray(), FULL);
    assert.equal(taa.historyValid, false);
    assert.equal(taa.stillFrames, 0);
    taa.beginFrame();
    assert.ok(Math.abs(taa.fullscreenMaterial.uniforms.jitterOffset.value.y - first.y) < 1e-12);
    taa.endFrame();
  } finally {
    taa.dispose();
  }
});

test("logical bottom-left state converts to top-left storage exactly once", () => {
  // Logical pixel (3, 2) in a 10-row image is storage row 7; applying the conversion again round-trips.
  assert.deepEqual(logicalPixelToStorage(3, 2, 10), { x: 3, y: 7 });
  assert.deepEqual(logicalPixelToStorage(3, 7, 10), { x: 3, y: 2 });
  const storage = logicalUVToStorage(0.25, 0.1);
  assert.equal(storage.u, 0.25);
  assert.ok(Math.abs(storage.v - 0.9) < 1e-12);
  const roundTrip = logicalUVToStorage(storage.u, storage.v);
  assert.ok(Math.abs(roundTrip.u - 0.25) < 1e-12);
  assert.ok(Math.abs(roundTrip.v - 0.1) < 1e-12);
});

test("independent meshesMoved prevents a false still frame", () => {
  const base = {
    staticConvergence: true,
    historyValid: true,
    viewProjection: new Matrix4(),
    previousViewProjection: new Matrix4(),
    objectMatrix: new Matrix4(),
    previousObjectMatrix: new Matrix4(),
    meshesMoved: false
  };
  assert.equal(isTemporalStill(base), true);
  assert.equal(isTemporalStill({ ...base, meshesMoved: true }), false);
  assert.equal(isTemporalStill({ ...base, staticConvergence: false }), false);
  assert.equal(isTemporalStill({ ...base, historyValid: false }), false);

  const movedView = base.viewProjection.clone().makeTranslation(0, 0, -0.001);
  assert.equal(isTemporalStill({ ...base, viewProjection: movedView }), false);
  const movedObject = base.objectMatrix.clone().makeTranslation(0.001, 0, 0);
  assert.equal(isTemporalStill({ ...base, objectMatrix: movedObject }), false);
});

test("a public reactiveMask toggle overrides the per-frame render input", () => {
  const own = new GPU.Texture();
  const input = new GPU.Texture();
  assert.equal(effectiveReactiveMask(true, null, input), null);
  assert.equal(effectiveReactiveMask(true, own, input), own);
  assert.equal(effectiveReactiveMask(false, null, input), input);
  assert.equal(effectiveReactiveMask(false, null, null), null);

  const taa = makeTaa();
  try {
    taa.reactiveMask = input;
    assert.equal(taa.reactiveMask, input);
    taa.reactiveMask = null;
    assert.equal(taa.reactiveMask, null);
  } finally {
    taa.dispose();
  }
  own.dispose();
  input.dispose();
});

test("velocityBuffer truthy selects the per-mesh path and resets history when toggled", () => {
  const taa = makeTaa();
  try {
    assert.equal(taa.fullscreenMaterial.uniforms.useVelocityBuffer.value, false);
    taa.velocityBuffer = {};
    assert.equal(taa.fullscreenMaterial.uniforms.useVelocityBuffer.value, true);
    taa.reset();
    assert.equal(taa.historyValid, false);
    taa.velocityBuffer = false;
    assert.equal(taa.velocityBuffer, null);
    taa.velocityBuffer = null;
    assert.equal(taa.velocityBuffer, null);
    assert.equal(taa.fullscreenMaterial.uniforms.useVelocityBuffer.value, false);
  } finally {
    taa.dispose();
  }
});

test("setSize uses physical integer dimensions, clamps, and invalidates bounds/history", () => {
  const taa = makeTaa();
  try {
    taa.setSize(900.9, 600.2);
    assert.equal(taa.width, 900);
    assert.equal(taa.height, 600);
    assert.equal(taa.fullscreenMaterial.uniforms.size.value.x, 900);
    assert.equal(taa.fullscreenMaterial.uniforms.size.value.y, 600);
    assert.ok(Math.abs(taa.fullscreenMaterial.uniforms.texelSize.value.x - 1 / 900) < 1e-12);

    taa.backgroundBounds.set(0.1, 0.1, 0.9, 0.9);
    taa.setSize(450.4, 300.8);
    assert.equal(taa.width, 450);
    assert.equal(taa.height, 300);
    assert.deepEqual(taa.backgroundBounds.toArray(), FULL);
    assert.equal(taa.historyValid, false);

    taa.setSize(0, -10);
    assert.equal(taa.width, 1);
    assert.equal(taa.height, 1);
  } finally {
    taa.dispose();
  }
});

test("dispose is idempotent and leaves no usable component", () => {
  const taa = makeTaa();
  taa.dispose();
  taa.dispose();
  taa.setSize(100, 100);
  assert.equal(taa.width, 1);
  assert.throws(() => taa.beginFrame(), /dispose/);
  assert.throws(() => taa.render({ color: new GPU.Texture(), depth: new GPU.Texture() }), /dispose/);
});

test("native material writes the three-attachment history/output/state struct with contract formats", () => {
  const taa = makeTaa();
  try {
    assert.equal(taa.material.isMeshBasicNodeMaterial, true);
    assert.equal(taa.material.toneMapped, false);
    assert.equal(taa.material.blending, GPU.NoBlending);
    const outputNode = taa.material.outputNode;
    assert.equal(outputNode.isOutputStructNode, true);
    assert.equal(outputNode.members.length, 3);
    assert.equal(outputNode.members[0].nodeType, "vec4");
    assert.equal(outputNode.members[1].nodeType, "vec3");
    assert.equal(outputNode.members[2].nodeType, "vec4");

    const output = taa.outputTexture;
    assert.equal(output.format, GPU.RGBFormat);
    assert.equal(output.internalFormat, "rg11b10ufloat");
    assert.equal(output.colorSpace, GPU.NoColorSpace);

    const state = taa.stateTexture;
    assert.equal(state.format, GPU.RGBAFormat);
    assert.equal(state.internalFormat, "rgba16float");
    assert.equal(state.minFilter, GPU.NearestFilter);
    assert.equal(state.magFilter, GPU.NearestFilter);
    assert.equal(state.colorSpace, GPU.NoColorSpace);
  } finally {
    taa.dispose();
  }
});

test("bounded fast-path certifies a growing footprint and falls back safely", () => {
  const camera = makeCamera();
  camera.position.set(0, 0, 3);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const scene = new Scene();
  scene.background = new Color(0);
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  scene.add(mesh);
  const taa = makeTaa({ camera, scene, trackedObject: mesh, backgroundFastPath: true });
  try {
    taa.setSize(900, 600);
    taa.beginFrame();
    taa._viewProjection.multiplyMatrices(taa._projection, camera.matrixWorldInverse);

    taa._historyValid = false;
    taa._updateBackgroundBounds();
    const first = taa.backgroundBounds.clone();
    assert.ok(first.x > 0 && first.x < 0.5);
    assert.ok(first.z > 0.5 && first.z < 1);
    assert.ok(first.y > 0 && first.w < 1);

    // The footprint only grows until reset, so a moving object keeps its history trail covered.
    mesh.position.x = 0.4;
    mesh.updateMatrixWorld();
    taa._previousBounds.copy(first);
    taa._historyValid = true;
    taa._updateBackgroundBounds();
    const grown = taa.backgroundBounds.clone();
    assert.ok(Math.abs(grown.x - first.x) < 1e-12);
    assert.ok(grown.z > first.z);

    taa.reset();
    assert.deepEqual(taa.backgroundBounds.toArray(), FULL);

    // Non-black or textured backgrounds and fog cannot certify black pixels; the fast path expands to full screen.
    scene.background = new Color(0xffffff);
    taa._historyValid = false;
    taa._updateBackgroundBounds();
    assert.deepEqual(taa.backgroundBounds.toArray(), FULL);
    scene.background = new Texture();
    taa._updateBackgroundBounds();
    assert.deepEqual(taa.backgroundBounds.toArray(), FULL);
    scene.background = new Color(0);
    scene.fog = new (class Fog {})() as never;
    taa._updateBackgroundBounds();
    assert.deepEqual(taa.backgroundBounds.toArray(), FULL);
    scene.fog = null;

    // A box crossing the near plane makes perspective division non-conservative.
    camera.position.set(0, 0, 0);
    camera.updateMatrixWorld();
    taa._viewProjection.multiplyMatrices(taa._projection, camera.matrixWorldInverse);
    taa._updateBackgroundBounds();
    assert.deepEqual(taa.backgroundBounds.toArray(), FULL);
    taa.endFrame();
  } finally {
    taa.dispose();
    mesh.geometry.dispose();
    (mesh.material as MeshBasicMaterial).dispose();
  }
});

test("generated WGSL materializes every cross-branch expression before its reads", () => {
  const { taa, target, input, source } = buildTemporalAAWGSL();
  try {
    assert.ok(source.length > 10000, `fragment WGSL unexpectedly short: ${source.length}`);
    assert.match(source, /@location\( 0 \) m0 : vec4<f32>/);
    assert.match(source, /@location\( 1 \) m1 : vec3<f32>/);
    assert.match(source, /@location\( 2 \) m2 : vec4<f32>/);

    // Explicit dummy UVs on the raw input nodes must suppress TextureNode's automatic mat3 matrix uniforms.
    for (const node of Object.values(taa._textureNodes)) assert.equal(node.updateMatrix, false);
    assert.equal(source.includes("mat3x3<f32>"), false);

    const depths = wgslVariableDepths(source);
    const names = ["taaCurrent", "taaCurrentDepth", "taaMotionData", "taaMotion", "taaHistoryUv",
      "taaVelocityPixels", "taaLockWeight", "taaTrusted", "taaStoredState", "taaGamma", "taaRawHistory",
      "taaResolvedHistory"];
    for (const name of names) {
      const { assignments, reads } = depths(name);
      assert.ok(assignments.length > 0, `${name} has no assignment in generated WGSL`);
      assert.ok(reads.length > 0, `${name} has no read in generated WGSL`);
      const firstAssignment = assignments.reduce((a, b) => a.line < b.line ? a : b);
      const firstRead = reads.reduce((a, b) => a.line < b.line ? a : b);
      // A lazy TSL expression is emitted where first built. If that is a nested conditional branch and a later outer
      // branch reads it, the variable is uninitialized on skipped paths (the constant-HDR static-convergence bug).
      assert.ok(firstAssignment.line < firstRead.line, `${name} is read before its first assignment`);
      const minimumReadDepth = Math.min(...reads.map((read) => read.depth));
      assert.ok(firstAssignment.depth <= minimumReadDepth,
        `${name} is assigned at depth ${firstAssignment.depth} but read at depth ${minimumReadDepth}`);
    }
  } finally {
    taa.dispose();
    input.dispose();
    target.dispose();
  }
});

test("jitter phase count grows with the upscale ratio squared, FSR's 8 * ratio^2", () => {
  assert.equal(jitterPhaseCount(8, 1), 8);
  assert.equal(jitterPhaseCount(8, 0.5), 32);
  assert.equal(jitterPhaseCount(8, 1 / 1.5), 18);
  assert.equal(jitterPhaseCount(16, 1), 16);
});

test("upscaling: render size, input scale, phases and jitter in render pixels", () => {
  const taa = makeTaa({ jitterScale: 1 });
  try {
    taa.setSize(200, 100);
    assert.equal(taa.upscaling, false);
    assert.equal(taa.inputScale, 1);
    assert.equal(taa.jitterPhases, 8);

    taa.setSize(200, 100, 100, 50);
    assert.equal(taa.upscaling, true);
    assert.equal(taa.renderWidth, 100);
    assert.equal(taa.renderHeight, 50);
    assert.equal(taa.inputScale, 0.5);
    assert.equal(taa.jitterPhases, 32);
    assert.equal(taa.historyValid, false);

    // The projection offset is one jitter step in render pixels, not output pixels
    const camera = taa.camera as PerspectiveCamera;
    const before = camera.projectionMatrix.elements[8];
    taa.beginFrame();
    const { x } = jitterOffsetForFrame(0, 32, 1);
    assert.ok(Math.abs(camera.projectionMatrix.elements[8] - before - (2 * x) / 100) < 1e-9);
    taa.endFrame();

    // Render sizes larger than the output clamp to it
    taa.setSize(200, 100, 400, 400);
    assert.equal(taa.upscaling, false);
    assert.equal(taa.renderWidth, 200);
  } finally {
    taa.dispose();
  }
});

test("upscaling WGSL variant materializes its cross-branch expressions and reads render-sized inputs", () => {
  const { taa, target, input, source } = buildTemporalAAWGSL({ renderWidth: 10, renderHeight: 7 });
  try {
    assert.match(source, /@location\( 2 \) m2 : vec4<f32>/);
    const depths = wgslVariableDepths(source);
    for (const name of ["taaCurrent", "taaCurrentSmooth", "taaNearestConfidence", "taaRenderBase", "taaBaseOffset",
      "taaTarget", "taaKernel", "taaMotionData", "taaHistoryUv", "taaRawHistory", "taaResolvedHistory", "taaLockWeight"]) {
      const { assignments, reads } = depths(name);
      assert.ok(assignments.length > 0, `${name} has no assignment in generated WGSL`);
      assert.ok(reads.length > 0, `${name} has no read in generated WGSL`);
      const firstAssignment = assignments.reduce((a, b) => a.line < b.line ? a : b);
      const firstRead = reads.reduce((a, b) => a.line < b.line ? a : b);
      assert.ok(firstAssignment.line < firstRead.line, `${name} is read before its first assignment`);
      assert.ok(firstAssignment.depth <= Math.min(...reads.map((read) => read.depth)),
        `${name} is assigned deeper than it is read`);
    }
  } finally {
    taa.dispose();
    input.dispose();
    target.dispose();
  }
});

const MODERN = { neighbourhood: 9, clipTowardsCurrent: true, depthRejection: true, motionRejection: true,
  thinFeatureLocks: true, edgeAdaptiveBlend: true, sampleConfidence: true, lockFrames: 4, lockMaxSpeed: 12, blend: 0.15 };

test("specialized materials are cached per setting combination and can be switched off", () => {
  const taa = makeTaa(MODERN) as any;
  try {
    taa.setSize(32, 16);
    assert.equal(taa.specializeShader, true);
    const a = taa._selectMaterial();
    assert.notEqual(a, taa.material);
    assert.equal(taa._selectMaterial(), a, "same settings reuse the compiled variant");
    taa.blend = 0.3; taa.varianceGamma = 1.5; taa.depthTolerance = 0.01;
    assert.equal(taa._selectMaterial(), a, "continuous settings stay uniforms");
    taa.boxMode = "minmax";
    const b = taa._selectMaterial();
    assert.notEqual(b, a, "a discrete setting selects another variant");
    taa.boxMode = "variance";
    assert.equal(taa._selectMaterial(), a);
    taa.setSize(32, 16, 16, 8);
    assert.notEqual(taa._selectMaterial(), a, "upscaling has its own variants");
    taa.specializeShader = false;
    assert.equal(taa._selectMaterial(), taa._upscaleMaterial);
    taa.setSize(32, 16);
    assert.equal(taa._selectMaterial(), taa.material);
  } finally {
    taa.dispose();
  }
});

test("specialized modern WGSL materializes every cross-branch expression before its reads", () => {
  for (const renderSize of [{ renderWidth: 19, renderHeight: 13 }, { renderWidth: 10, renderHeight: 7 }]) {
    const { taa, target, input, source } = buildTemporalAAWGSL({ ...renderSize, options: MODERN, specialized: true });
    try {
      const depths = wgslVariableDepths(source);
      for (const name of ["taaCurrent", "taaCurrentDepth", "taaMotionData", "taaHistoryUv", "taaVelocityPixels",
        "taaLockWeight", "taaTrusted", "taaStoredState", "taaGamma", "taaRawHistory", "taaResolvedHistory"]) {
        const { assignments, reads } = depths(name);
        assert.ok(assignments.length > 0 && reads.length > 0, `${name} missing in specialized WGSL`);
        const firstAssignment = assignments.reduce((a, b) => a.line < b.line ? a : b);
        const firstRead = reads.reduce((a, b) => a.line < b.line ? a : b);
        assert.ok(firstAssignment.line < firstRead.line, `${name} is read before its first assignment`);
        assert.ok(firstAssignment.depth <= Math.min(...reads.map((read) => read.depth)), `${name} assigned too deep`);
      }
    } finally {
      taa.dispose();
      input.dispose();
      target.dispose();
    }
  }
});
