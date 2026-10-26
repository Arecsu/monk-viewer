import assert from "node:assert/strict";
import test from "node:test";
import { BoxGeometry, Color, Matrix4, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, Texture, WebGPUCoordinateSystem } from "three";
import * as GPU from "three/webgpu";
import { webglProjection } from "../src/webgpu/Common.js";
import {
  WebGpuTemporalAA,
  effectiveReactiveMask,
  halton,
  isTemporalStill,
  jitterOffsetForFrame,
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
