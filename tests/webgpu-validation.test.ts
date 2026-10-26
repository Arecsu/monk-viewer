import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ValidationError,
  CAPTURE_FORMATS,
  DISPLAY_TOLERANCE,
  STILL_TOLERANCE,
  GPU_LOCK_KEY,
  acquireExclusiveGpuLock,
  assertCaptureContent,
  captureStats,
  compareCaptures,
  compareCoverage,
  convergenceStats,
  createErrorMap,
  decodeHalfFloat,
  normalizeCapture,
  reinterpretEncoding,
  roundStability,
  srgbDecode,
  srgbEncode,
  sustainedStats,
  tileSummary,
  timingStats,
  toLinearDomain,
  toSrgbCodeDomain,
  toTopLeftRows,
  unpadRows,
} from './webgpu-validation-utils.js';

const code = (value) => Math.round(value * 255) / 255;

/** Build a normalized capture directly (already display-linear or sRGB, top-left rows). */
function makeCapture(width, height, pixel, { encoding = 'display-linear', label = 'synthetic' } = {}) {
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) {
      const [r, g, b] = pixel(x, y);
      const index = (y * width + x) * 4;
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = 1;
    }
  }
  return { label, width, height, channels: 4, format: encoding === 'srgb' ? 'rgba8unorm-srgb' : 'rgba32float', encoding, data };
}

/** A flat zero background with a bright disc, so every comparison has flat surfaces and one silhouette. */
function disc(width, height, { radius = 0.25, centerX = 0.5, centerY = 0.5, brightness = 0.8, encoding = 'display-linear' } = {}) {
  return makeCapture(width, height, (x, y) => {
    const dx = (x + 0.5) / width - centerX;
    const dy = (y + 0.5) / height - centerY;
    const inside = Math.hypot(dx, dy) <= radius;
    // A vertical ramp keeps distinct-color counts realistic while staying deterministic. The ramp is
    // defined in display-linear light and only the encoding changes the stored values.
    const linear = inside ? brightness * (0.5 + 0.5 * (y / height)) : 0;
    const value = encoding === 'srgb' ? srgbEncode(linear) : linear;
    return [value, value, value];
  }, { encoding });
}

/** Soft-edged disc: silhouette differences are partial coverage differences, like MSAA/TAA edges. */
function softDisc(width, height, { radius = 24, center = 32, brightness = 0.8, shift = 0 } = {}) {
  return makeCapture(width, height, (x, y) => {
    const distance = Math.hypot(x + 0.5 - center - shift, y + 0.5 - center);
    const coverage = Math.min(1, Math.max(0, radius + 0.5 - distance));
    return [brightness * coverage, brightness * coverage, brightness * coverage];
  });
}

test('sRGB transfer functions round-trip and clamp to the standard curve', () => {
  for (const value of [0, 0.001, 0.04045, 0.2, 0.5, 0.9, 1]) {
    assert.ok(Math.abs(srgbDecode(srgbEncode(value)) - value) < 1e-9, `round trip failed for ${value}`);
  }
  assert.ok(Math.abs(srgbEncode(0) - 0) < 1e-12);
  assert.ok(Math.abs(srgbEncode(1) - 1) < 1e-12);
  assert.ok(Math.abs(srgbDecode(0.5) - 0.21404114048223255) < 1e-12);
  assert.equal(srgbDecode(-0.5), -srgbDecode(0.5));
});

test('padded WebGPU readbacks are compacted and bottom-left rows are flipped to display order', () => {
  const padded = new Uint8Array(256 * 2);
  padded.set([1, 2, 3, 4, 5, 6, 7, 8], 0);
  padded.set([9, 10, 11, 12, 13, 14, 15, 16], 256);
  const packed = unpadRows(padded, 2, 2, 4);
  assert.deepEqual([...packed], Array.from({ length: 16 }, (_, i) => i + 1));
  assert.deepEqual([...toTopLeftRows(packed, 2, 2, { rowOrder: 'bottom-left' })],
    [9, 10, 11, 12, 13, 14, 15, 16, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(toTopLeftRows(packed, 2, 2)[0], 1);
  assert.throws(() => unpadRows(new Uint8Array(17), 2, 2, 4), ValidationError);
  assert.throws(() => toTopLeftRows(packed, 3, 2), ValidationError);
  assert.throws(() => toTopLeftRows(packed, 2, 2, { rowOrder: 'sideways' }), ValidationError);
  assert.throws(() => unpadRows(new Uint8Array(16), 2, 3, 4), ValidationError);
});

test('half-float readback decoding handles zero, subnormals, normals, infinity and NaN', () => {
  assert.equal(decodeHalfFloat(0x0000), 0);
  assert.equal(decodeHalfFloat(0x8000), -0);
  assert.equal(decodeHalfFloat(0x3c00), 1);
  assert.equal(decodeHalfFloat(0xc000), -2);
  assert.equal(decodeHalfFloat(0x0001), 2 ** -24);
  assert.equal(decodeHalfFloat(0x7bff), 65504);
  assert.equal(decodeHalfFloat(0x7c00), Infinity);
  assert.ok(Number.isNaN(decodeHalfFloat(0x7e00)));
  assert.throws(() => decodeHalfFloat(0x10000), ValidationError);
  assert.throws(() => decodeHalfFloat(1.5), ValidationError);
});

test('normalizeCapture converts formats to display values and rejects unknown formats or wrong array types', () => {
  const unorm = normalizeCapture({ data: new Uint8Array([0, 51, 102, 255, 255, 0, 0, 255]), width: 2, height: 1, format: 'rgba8unorm', label: 'unorm' });
  assert.equal(unorm.encoding, 'display-linear');
  assert.ok(Math.abs(unorm.data[0] - 0) < 1e-12);
  assert.ok(Math.abs(unorm.data[1] - 0.2) < 1e-6);
  const srgb = normalizeCapture({ data: new Uint8Array([128, 0, 0, 255]), width: 1, height: 1, format: 'rgba8unorm-srgb' });
  assert.equal(srgb.encoding, 'srgb');
  const half = normalizeCapture({ data: new Uint16Array([0x3c00, 0, 0, 0x3c00]), width: 1, height: 1, format: 'rgba16float' });
  assert.equal(half.data[0], 1);
  assert.throws(() => normalizeCapture({ data: new Uint8Array(4), width: 1, height: 1, format: 'bgra8unorm' }), /capture-format/);
  assert.throws(() => normalizeCapture({ data: new Float32Array(4), width: 1, height: 1, format: 'rgba8unorm' }), /capture-type/);
  assert.throws(() => normalizeCapture({ data: new Uint8Array(8), width: 1, height: 1, format: 'rgba8unorm' }), ValidationError);
  assert.deepEqual(Object.keys(CAPTURE_FORMATS).sort(), ['rgba16float', 'rgba32float', 'rgba8unorm', 'rgba8unorm-srgb']);
});

test('encoding domain conversion is explicit and reinterpretation is recorded', () => {
  const capture = makeCapture(1, 1, () => [0.5, 0.5, 0.5], { encoding: 'srgb' });
  assert.equal(toSrgbCodeDomain(capture), capture.data);
  assert.ok(Math.abs(toLinearDomain(capture)[0] - srgbDecode(0.5)) < 1e-6);
  const linear = reinterpretEncoding(capture, 'display-linear');
  assert.equal(linear.encoding, 'display-linear');
  assert.equal(linear.reinterpreted, true);
  assert.throws(() => reinterpretEncoding(capture, 'hdr'), ValidationError);
});

test('capture statistics reject blank, constant and non-finite frames', () => {
  const blank = makeCapture(16, 16, () => [0, 0, 0]);
  const blankStats = captureStats(blank);
  assert.equal(blankStats.distinctColors, 1);
  assert.equal(blankStats.litFraction, 0);
  assert.throws(() => assertCaptureContent(blankStats, { label: 'blank' }), /blank-capture/);

  const constant = makeCapture(16, 16, () => [0.5, 0.5, 0.5]);
  assert.throws(() => assertCaptureContent(captureStats(constant), { label: 'constant' }), /blank-capture/);

  const nan = makeCapture(16, 16, (x) => (x === 0 ? [NaN, 0, 0] : [0.1, 0.2, 0.3]));
  assert.throws(() => assertCaptureContent(captureStats(nan), { label: 'nan' }), /non-finite-capture/);

  const scene = disc(32, 32);
  const stats = assertCaptureContent(captureStats(scene), { label: 'scene', minimumDistinctColors: 8 });
  assert.ok(stats.litFraction > 0.1 && stats.litFraction < 0.3);
  assert.ok(stats.distinctColors >= 8, `expected a shaded disc, got ${stats.distinctColors} colors`);
  assert.throws(() => assertCaptureContent(stats, { label: 'too small', minimumDistinctColors: 8, minimumLitFraction: 0.9 }), /empty-coverage/);
  assert.throws(() => assertCaptureContent(stats, { label: 'too large', minimumDistinctColors: 8, maximumLitFraction: 0.05 }), /saturated-coverage/);
  assert.throws(() => assertCaptureContent(stats, { label: 'strict distinct', minimumDistinctColors: 64 }), /blank-capture/);
});

test('coverage parity rejects a backend that drew a different amount of the scene', () => {
  const reference = captureStats(disc(64, 64));
  const same = compareCoverage(reference, captureStats(disc(64, 64)), { maxLitFractionDelta: 0.001 });
  assert.equal(same.pass, true);
  assert.equal(same.litFractionDelta, 0);
  const smaller = compareCoverage(reference, captureStats(disc(64, 64, { radius: 0.1 })));
  assert.equal(smaller.pass, false);
  assert.ok(smaller.reasons.length === 1);
});

test('identical captures pass the display tolerance with no unexplained differences', () => {
  const reference = disc(64, 64);
  const comparison = compareCaptures(reference, reference);
  assert.equal(comparison.pass, true, comparison.reasons.join('; '));
  assert.equal(comparison.maxAbs, 0);
  assert.equal(comparison.visiblePixels, 0);
  assert.equal(comparison.flatRmse, 0);
  assert.ok(comparison.comparedFlatPixels > 0);
  assert.ok(comparison.edgeChannels > 0, 'disc silhouette must be classified as edge-adjacent');
});

test('flat-surface visible differences fail and are reported as unexplained', () => {
  const reference = disc(64, 64);
  const candidate = disc(64, 64, { brightness: 0.8 + 8 / 255 });
  const comparison = compareCaptures(reference, candidate);
  assert.equal(comparison.pass, false);
  assert.ok(comparison.visibleFlatPixels > 0);
  assert.ok(comparison.reasons.some((reason) => reason.includes('flat-surface visible')));
  const map = createErrorMap(reference, candidate);
  assert.ok(map.visiblePixels > 0);
  const tiles = tileSummary(map, { tile: 16, limit: 3 });
  assert.equal(tiles.length, 3);
  assert.ok(tiles[0].maxStep >= 3, `expected visible flat difference in the worst tile, got ${tiles[0].maxStep}`);
});

test('silhouette-adjacent shading differences are reported but do not fail as unexplained', () => {
  // A sub-pixel coverage difference on a soft silhouette, like an MSAA/TAA edge difference.
  const reference = softDisc(64, 64);
  const candidate = softDisc(64, 64, { shift: 0.35 });
  const comparison = compareCaptures(reference, candidate);
  assert.ok(comparison.visibleEdgePixels > 0, 'shifted silhouette must produce edge-adjacent visible differences');
  assert.ok(comparison.edgeOutlierChannels > 0);
  assert.equal(comparison.visibleFlatPixels, 0, 'a silhouette shift must not be classified as flat-surface');
  assert.equal(comparison.pass, true, comparison.reasons.join('; '));
  assert.ok(comparison.maxAbs > 0.1);
});

test('whole-frame gates catch a visible difference even where every pixel is edge-adjacent', () => {
  // Steep per-pixel variation classifies every pixel as edge-adjacent; only the global gates can catch it.
  const pattern = (offset) => makeCapture(32, 32, (x, y) => {
    const value = Math.min(1, ((x * 7 + y * 13) % 17) / 17);
    const shifted = Math.min(1, value + offset);
    return [shifted, shifted, shifted];
  });
  const comparison = compareCaptures(pattern(0), pattern(6 / 255));
  assert.equal(comparison.visibleFlatPixels, 0);
  assert.ok(comparison.visibleFraction > 0.9);
  assert.equal(comparison.pass, false);
  assert.ok(comparison.reasons.some((reason) => reason.includes('visible difference covers')));
});

test('non-finite pixels, missing flat surfaces and shape mismatches are rejected', () => {
  const reference = disc(32, 32);
  const broken = disc(32, 32);
  broken.data[0] = NaN;
  const comparison = compareCaptures(reference, broken);
  assert.equal(comparison.pass, false);
  assert.equal(comparison.nonFinite, 1);
  assert.ok(comparison.reasons.some((reason) => reason.includes('non-finite')));

  assert.throws(() => compareCaptures(reference, disc(16, 16)), /capture-shape/);
  assert.throws(() => compareCaptures(reference, makeCapture(32, 32, () => [0.5, 0.5, 0.5], { encoding: 'linear' })), ValidationError);
  assert.throws(() => compareCaptures(reference, makeCapture(32, 32, () => [0, 0, 0, 0], { encoding: 'hdr' })), ValidationError);
});

test('sRGB-code reference is compared in display-linear light values', () => {
  const srgb = disc(32, 32, { brightness: 0.8, encoding: 'srgb' });
  const linear = disc(32, 32, { brightness: 0.8 });
  const comparison = compareCaptures(srgb, linear);
  assert.ok(comparison.maxAbs < 1e-6, `decoded light values should match, got ${comparison.maxAbs}`);
  assert.equal(comparison.pass, true);
});

test('still convergence accepts a settled sequence and rejects flicker or missing frames', () => {
  const frames = Array.from({ length: 5 }, () => disc(32, 32));
  const converged = convergenceStats(frames, { tail: 3 });
  assert.equal(converged.converged, true, converged.reasons.join('; '));

  const flicker = Array.from({ length: 5 }, (_, index) => disc(32, 32, { brightness: index % 2 ? 0.8 : 0.9 }));
  const unstable = convergenceStats(flicker, { tail: 3 });
  assert.equal(unstable.converged, false);
  assert.ok(unstable.reasons.length > 0);

  assert.throws(() => convergenceStats([disc(8, 8)]), /convergence-input/);
  assert.throws(() => convergenceStats('frames'), /convergence-input/);
});

test('timing statistics reject empty, missing, non-finite, zero and negative samples', () => {
  const stats = timingStats([4, 1, 3, 2]);
  assert.equal(stats.samples, 4);
  assert.equal(stats.medianMs, 2.5);
  assert.equal(stats.p10Ms, 1);
  assert.equal(stats.p90Ms, 4);
  assert.equal(stats.minMs, 1);
  assert.equal(stats.maxMs, 4);
  const input = [4, 1, 3, 2];
  timingStats(input);
  assert.deepEqual(input, [4, 1, 3, 2], 'timingStats must not mutate its input');
  for (const bad of [[], [NaN], [Infinity], [-1], [0], [1, undefined], [1, '2'], null, 5, [1, 2, NaN]]) {
    assert.throws(() => timingStats(bad), ValidationError, `expected rejection for ${String(bad)}`);
  }
  assert.throws(() => timingStats([1, 2], { minimumSamples: 3 }), /timing-empty/);
});

test('repeated rounds must agree before a timing is reported', () => {
  const stable = roundStability([2.0, 2.1, 2.05]);
  assert.equal(stable.rounds, 3);
  assert.ok(stable.spread < 0.06);
  assert.throws(() => roundStability([2.0, 8.0]), /timing-disjoint/);
  assert.throws(() => roundStability([2.0]), /timing-rounds/);
  assert.throws(() => roundStability([2.0, NaN]), ValidationError);
});

test('sustained timing reports wall milliseconds per frame and rejects degenerate input', () => {
  const sustained = sustainedStats([16.6, 16.7, 16.8]);
  assert.equal(sustained.samples, 3);
  assert.ok(Math.abs(sustained.framesPerSecond - 1000 / 16.7) < 1e-9);
  assert.throws(() => sustainedStats([16.6]), /timing-empty/);
  assert.throws(() => sustainedStats([16.6, Infinity]), ValidationError);
});

test('exclusive GPU lock refuses concurrent owners and releases once', () => {
  const scope = {};
  const lock = acquireExclusiveGpuLock(scope, 'first');
  assert.equal(scope[GPU_LOCK_KEY].owner, 'first');
  assert.throws(() => acquireExclusiveGpuLock(scope, 'second'), /gpu-lock-held/);
  lock.release();
  assert.equal(scope[GPU_LOCK_KEY], undefined);
  lock.release();
  const second = acquireExclusiveGpuLock(scope, 'second');
  assert.equal(scope[GPU_LOCK_KEY].owner, 'second');
  second.release();
  assert.throws(() => acquireExclusiveGpuLock(null), /gpu-lock-sco/);
});

test('tolerances are frozen, documented profiles', () => {
  assert.ok(Object.isFrozen(DISPLAY_TOLERANCE));
  assert.ok(Object.isFrozen(STILL_TOLERANCE));
  assert.ok(DISPLAY_TOLERANCE.rmse > STILL_TOLERANCE.rmse);
  assert.ok(DISPLAY_TOLERANCE.maxFlatVisibleFraction > 0);
  for (const key of ['absTolerance', 'relTolerance', 'rmse', 'visibleCodeStep', 'edgeGradientStep', 'edgeRadius']) {
    assert.ok(Number.isFinite(DISPLAY_TOLERANCE[key]), `missing tolerance ${key}`);
  }
});

// ---------------------------------------------------------------------------------------------
// Harness contract: the browser module must be importable without a DOM and must reject incomplete or
// mislabeled managers instead of assuming a working backend.

function fakeWebGlManager(overrides = {}) {
  const renderer = {
    isWebGLRenderer: true,
    info: { render: { frame: 0, calls: 0, triangles: 0 }, autoReset: true, memory: { renderTargets: 0, textures: 0 } },
    domElement: { width: 2, height: 2, clientWidth: 2, clientHeight: 2 },
    getPixelRatio: () => 1,
    getContext: () => null,
  };
  return {
    renderer,
    pipeline: { render() {} },
    model: { traverse() {} },
    camera: {},
    taa: { reset() {} },
    isRendering: false,
    startRenderLoop() {},
    updateRendererSize() {},
    ...overrides,
  };
}

function fakeNativeManager(overrides = {}, pipelineOverrides = {}) {
  const renderer = {
    isWebGPURenderer: true,
    backend: { device: {}, trackTimestamp: true, get: () => null },
    readRenderTargetPixelsAsync: async () => new Uint8Array(0),
    info: { render: { frame: 0, calls: 0, drawCalls: 0, triangles: 0 }, autoReset: true, memory: { renderTargets: 0, textures: 0 } },
    domElement: { width: 2, height: 2, clientWidth: 2, clientHeight: 2 },
    getPixelRatio: () => 1,
    resolveTimestampsAsync: async () => 1,
  };
  return {
    renderer,
    pipeline: { render() {}, ...pipelineOverrides },
    model: { traverse() {} },
    camera: {},
    taa: { reset() {} },
    isRendering: false,
    startRenderLoop() {},
    updateRendererSize() {},
    ...overrides,
  };
}

test('harness rejects managers without the required hooks and never assumes a backend', async () => {
  const harness = await import('./webgpu-pipeline-browser.js');
  assert.ok(harness.REQUIRED_MANAGER_HOOKS.length >= 8);
  assert.throws(() => harness.createPipelineAdapter({}), /manager-hooks/);
  const webgl = harness.createPipelineAdapter(fakeWebGlManager(), { label: 'fake-webgl' });
  assert.equal(webgl.backend, 'webgl');
  assert.equal(webgl.status, null);
  const native = harness.createPipelineAdapter(fakeNativeManager(), { label: 'fake-native' });
  assert.equal(native.backend, 'webgpu');
  assert.throws(
    () => harness.createPipelineAdapter(fakeNativeManager({ backendStatus: { backend: 'webgl', reason: 'auto' } }), { label: 'mislabeled' }),
    /backend-mismatch/,
  );
  assert.throws(
    () => harness.createPipelineAdapter(fakeWebGlManager({ backendStatus: 'webgpu' }), { label: 'mislabeled' }),
    /backend-mismatch/,
  );
  assert.throws(() => harness.createPipelineAdapter(fakeWebGlManager({ taa: {} }), { label: 'no-history' }), /taa.reset\(\) or resetHistory\(\)/);
  const fallback = fakeNativeManager();
  fallback.renderer.backend = { isWebGLBackend: true, device: {}, trackTimestamp: false };
  assert.throws(() => harness.createPipelineAdapter(fallback, { label: 'webgl-fallback' }), /backend-fallback/);
});

test('harness requires an explicit presented output target on the native backend', async () => {
  const harness = await import('./webgpu-pipeline-browser.js');
  const missing = harness.createPipelineAdapter(fakeNativeManager(), { label: 'fake-native' });
  await assert.rejects(missing.capture(), /final-target/);
  const withTarget = harness.createPipelineAdapter(fakeNativeManager({}, {
    finalTarget: { textures: [{}], width: 2, height: 2 },
    latest: undefined,
  }), { label: 'fake-native' });
  assert.deepEqual(withTarget.outputSize(), { width: 2, height: 2 });
});

test('default validation cases cover still convergence, motion, odd/tiny/portrait/resize and toggles', async () => {
  const harness = await import('./webgpu-pipeline-browser.js');
  const names = harness.DEFAULT_CASES.map((entry) => entry.name).join(' | ');
  for (const required of ['still convergence', 'model rotation', 'camera orbit', 'independent clip motion', 'odd resolution', 'tiny resolution', 'portrait resolution', 'mid-sequence resize', 'TAA disabled', 'motion blur disabled', 'Reinhard', 'SMAA', 'MSAA disabled']) {
    assert.ok(names.includes(required), `missing default case: ${required}`);
  }
  for (const entry of harness.DEFAULT_CASES) {
    assert.ok(entry.frames > 0, `${entry.name} needs frames`);
    assert.ok(Object.hasOwn(harness.POSES, entry.pose), `${entry.name} uses unknown pose ${entry.pose}`);
    if (entry.condition) assert.ok(Object.hasOwn(harness.CONDITIONS, entry.condition), `${entry.name} uses unknown condition ${entry.condition}`);
    const defined = Boolean(entry.captureTail || entry.captureEvery);
    assert.ok(defined, `${entry.name} must capture frames`);
  }
  assert.ok(harness.CONDITIONS['taa-off'].required);
  assert.ok(harness.CONDITIONS['motion-blur-off'].required);
  assert.ok(harness.CONDITIONS['reinhard'].required);
  assert.equal(harness.CONDITIONS['smaa-on'].required, false);
  assert.equal(harness.CONDITIONS['msaa-off'].required, false);
});

// ---------------------------------------------------------------------------------------------
// Offline drive of the browser harness with fake WebGL2/WebGPU managers. This exercises the deterministic
// capture/comparison/restore/benchmark plumbing (not GPU behaviour) so a browser run is the only remaining
// validation step for the harness itself.

function vec3(x = 0, y = 0, z = 0) {
  return {
    x, y, z,
    set(nx, ny, nz) { this.x = nx; this.y = ny; this.z = nz; return this; },
    copy(other) { return this.set(other.x, other.y, other.z); },
    clone() { return vec3(this.x, this.y, this.z); },
    length() { return Math.hypot(this.x, this.y, this.z); },
  };
}

function quaternion() {
  return { x: 0, y: 0, z: 0, w: 1, copy() { return this; }, clone() { return quaternion(); } };
}

function fakeModel() {
  const clip = {
    name: 'CLIP_A', isMesh: true, visible: true, position: vec3(0.1, 0, 0),
    geometry: { index: { count: 3 } }, traverse(callback) { callback(this); },
  };
  const model = {
    name: 'model', isMesh: false, position: vec3(), quaternion: quaternion(), up: vec3(0, 1, 0), children: [clip],
    rotateOnAxis() { this.rotations = (this.rotations ?? 0) + 1; return this; },
    traverse(callback) { callback(this); for (const child of this.children) child.traverse(callback); },
  };
  return model;
}

function fakeCamera() {
  return {
    aspect: 1.5, position: vec3(0, 0, 1), quaternion: quaternion(),
    lookAt() {}, updateProjectionMatrix() {},
  };
}

function fakeInfo() {
  return {
    render: { frame: 0, calls: 0, drawCalls: 0, triangles: 0 },
    autoReset: true,
    memory: { renderTargets: 0, textures: 0 },
    reset() { this.render.calls = 0; this.render.drawCalls = 0; this.render.triangles = 0; },
  };
}

/** sRGB-code image used by both fakes; `offset` simulates a native shading difference. */
function sceneCode(x, y, width, height, offset = 0) {
  const dx = (x + 0.5) / width - 0.5, dy = (y + 0.5) / height - 0.5;
  const radius = Math.hypot(dx, dy);
  const base = radius < 0.3 ? Math.round(40 + 200 * (1 - radius / 0.3)) : 0;
  const value = Math.min(255, Math.max(0, base + offset));
  return [value, value, value];
}

function createFakeWorld({ offsetGl = 0, offsetNative = 0, nativeFormat = 'rgba8unorm-srgb', trackTimestamp = true, loopIgnoresPause = false } = {}) {
  const canvas = { width: 2, height: 2, clientWidth: 2, clientHeight: 2, addEventListener() {}, removeEventListener() {} };
  const info = fakeInfo();
  const events = { error: [], lost: [] };
  const timerExtension = {
    TIME_ELAPSED_EXT: 1, GPU_DISJOINT_EXT: 2,
    queryResults: [],
  };
  let queryIndex = 0;
  const gl = {
    FRAMEBUFFER: 0, RGBA: 0, UNSIGNED_BYTE: 0, NO_ERROR: 0,
    SYNC_GPU_COMMANDS_COMPLETE: 0, ALREADY_SIGNALED: 1, CONDITION_SATISFIED: 1, WAIT_FAILED: 2,
    QUERY_RESULT_AVAILABLE: 0, QUERY_RESULT: 1,
    getExtension: (name) => (name === 'EXT_disjoint_timer_query_webgl2' ? timerExtension : null),
    fenceSync: () => ({}), flush() {}, deleteSync() {},
    clientWaitSync: () => 1, isContextLost: () => false,
    bindFramebuffer() {},
    getError: () => 0,
    readPixels(_x, _y, width, height, _format, _type, data) {
      for (let y = 0; y < height; ++y) {
        const source = height - y - 1;
        for (let x = 0; x < width; ++x) {
          const [r, g, b] = sceneCode(x, source, width, height, offsetGl);
          const index = (y * width + x) * 4;
          data[index] = r; data[index + 1] = g; data[index + 2] = b; data[index + 3] = 255;
        }
      }
    },
    createQuery() { return { id: queryIndex++ }; },
    beginQuery() {}, endQuery() {},
    getQueryParameter(query, parameter) { return parameter === 0 ? true : 2e6; },
    deleteQuery() {},
    getParameter(parameter) { return parameter === 2 ? false : 'fake-renderer'; },
    drawingBufferWidth: 2, drawingBufferHeight: 2,
    getContextAttributes: () => ({ antialias: false, alpha: false }),
    canvas,
  };
  const nativeInfo = { format: nativeFormat, sampleCount: 1, mipLevelCount: 1, width: 2, height: 2, usage: 0 };
  let finalTarget = { textures: [{ internalFormat: nativeFormat, colorSpace: 'srgb-linear', image: { width: 2, height: 2 } }], width: 2, height: 2 };
  const device = {
    queue: { onSubmittedWorkDone: async () => {} },
    features: { has: () => true },
    addEventListener(type, listener) { if (type === 'uncapturederror') events.error.push(listener); },
    removeEventListener(type, listener) { events.error = events.error.filter((entry) => entry !== listener); },
  };
  const webglRenderer = {
    isWebGLRenderer: true, info, domElement: canvas, getPixelRatio: () => 1,
    getContext: () => gl, getRenderTarget: () => null, outputColorSpace: 'srgb',
  };
  const nativeRenderer = {
    isWebGPURenderer: true, info, domElement: canvas, getPixelRatio: () => 1,
    backend: { device, trackTimestamp, get: () => ({ texture: nativeInfo }), isWebGPUBackend: true },
    async readRenderTargetPixelsAsync(target, x, y, width, height) {
      const stride = Math.ceil((width * 4) / 256) * 256;
      const data = new Uint8Array((height - 1) * stride + width * 4);
      for (let row = 0; row < height; ++row) {
        for (let column = 0; column < width; ++column) {
          const [r, g, b] = sceneCode(column, row, width, height, offsetNative);
          const index = row * stride + column * 4;
          data[index] = r; data[index + 1] = g; data[index + 2] = b; data[index + 3] = 255;
        }
      }
      return data;
    },
    async resolveTimestampsAsync() { return 2; },
  };
  const makeManager = (renderer, isNative) => {
    const manager = {
      renderer,
      pipeline: {
        render() {
          renderer.info.render.calls += 3;
          renderer.info.render.drawCalls += 3;
          renderer.info.render.triangles = 12;
          if (!isNative) renderer.info.render.frame += 1;
        },
        ...(isNative ? { finalTarget } : {}),
      },
      model: fakeModel(),
      camera: fakeCamera(),
      taa: { enabled: true, reset() { this.resets = (this.resets ?? 0) + 1; } },
      isRendering: false,
      startRenderLoop() { this.loopStarts = (this.loopStarts ?? 0) + 1; },
      updateRendererSize(width, height, pixelRatio) {
        const w = Math.floor(width * pixelRatio), h = Math.floor(height * pixelRatio);
        canvas.width = w; canvas.height = h;
        if (isNative) {
          finalTarget.width = w; finalTarget.height = h;
          finalTarget.textures[0].image = { width: w, height: h };
          nativeInfo.width = w; nativeInfo.height = h;
        }
      },
    };
    manager.pipeline.finalTarget = isNative ? finalTarget : undefined;
    return manager;
  };
  const webgl = makeManager(webglRenderer, false);
  // Optional misbehaving loop: it renders regardless of isRendering a few times.
  if (loopIgnoresPause) {
    webgl.isRendering = true;
    let remaining = 4;
    const tick = () => { if (remaining-- <= 0) return; webgl.pipeline.render(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
  const native = makeManager(nativeRenderer, true);
  return { webgl, native, events };
}

async function withFakeBrowser(run) {
  const previous = { raf: globalThis.requestAnimationFrame, document: globalThis.document };
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0);
  globalThis.document = { visibilityState: 'visible' };
  try {
    return await run();
  } finally {
    if (previous.raf === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = previous.raf;
    if (previous.document === undefined) delete globalThis.document; else globalThis.document = previous.document;
  }
}

const offlineCases = [
  { name: 'still convergence', pose: 'still', frames: 6, captureTail: 4, convergence: true },
  { name: 'model rotation', pose: 'rotation', frames: 4, captureEvery: 2 },
  { name: 'toggle: TAA disabled', pose: 'rotation', frames: 4, captureEvery: 2, condition: 'taa-off' },
];

test('offline comparePipeline passes matching backends and restores manager state', async () => {
  const harness = await import('./webgpu-pipeline-browser.js');
  const world = createFakeWorld();
  const before = { width: world.webgl.renderer.domElement.width, aspect: world.webgl.camera.aspect };
  const results = await withFakeBrowser(() => harness.comparePipeline(world.webgl, world.native, {
    cases: offlineCases, resolution: [64, 48], onProgress: () => {},
  }));
  assert.equal(results.validation.pass, true, JSON.stringify(results.validation.failures));
  assert.equal(results.validation.complete, true);
  assert.equal(results.validation.cases.length, 3);
  const still = results.validation.cases[0];
  assert.equal(still.status, 'validated');
  assert.equal(still.convergence.backends.every((entry) => entry.converged), true);
  assert.ok(still.captures[0].comparison.comparedFlatPixels > 0);
  assert.equal(still.errorMap.maxStep, 0);
  assert.deepEqual(results.backends.map((entry) => entry.backend), ['webgl', 'webgpu']);
  assert.equal(world.webgl.renderer.domElement.width, before.width);
  assert.equal(world.webgl.camera.aspect, before.aspect);
  assert.equal(world.webgl.isRendering, false);
});

test('offline comparePipeline reports unexplained flat differences and can throw with results', async () => {
  const harness = await import('./webgpu-pipeline-browser.js');
  const world = createFakeWorld({ offsetNative: 6 });
  const results = await withFakeBrowser(() => harness.comparePipeline(world.webgl, world.native, {
    cases: offlineCases.slice(1), resolution: [64, 48], onProgress: () => {}, throwOnFailure: false,
  }));
  assert.equal(results.validation.pass, false);
  assert.ok(results.validation.failures.some((failure) => failure.code === 'display-difference'));
  const first = results.validation.cases[0].captures[0].comparison;
  assert.ok(first.visibleFlatPixels > 0);
  assert.ok(first.reasons.some((reason) => reason.includes('flat-surface visible')));

  const mismatch = createFakeWorld({ nativeFormat: 'rgba8unorm' });
  await assert.rejects(
    withFakeBrowser(() => harness.comparePipeline(mismatch.webgl, mismatch.native, {
      cases: offlineCases.slice(1), resolution: [32, 24], onProgress: () => {},
    })),
    (error) => {
      assert.equal(error.code, 'rejected');
      assert.ok(error.results.validation.cases[0].captures[0].comparison.encodingHint.includes('reinterpreted as srgb'));
      return true;
    },
  );
});

test('offline comparePipeline refuses a production loop it cannot pause', async () => {
  const harness = await import('./webgpu-pipeline-browser.js');
  await withFakeBrowser(async () => {
    const world = createFakeWorld({ loopIgnoresPause: true });
    await assert.rejects(
      harness.comparePipeline(world.webgl, world.native, { cases: offlineCases.slice(1), resolution: [16, 16], onProgress: () => {} }),
      /loop-active/,
    );
  });
});

test('offline benchmarkPipeline reports GPU and sustained timings per backend and rejects missing timestamps', async () => {
  const harness = await import('./webgpu-pipeline-browser.js');
  const world = createFakeWorld();
  const results = await withFakeBrowser(() => harness.benchmarkPipeline([world.webgl, world.native], {
    samples: 4, rounds: 2, warmupFrames: 2, sustainedFrames: 4, resolutions: [[32, 24]],
    maxGpuRoundSpread: 5, maxSustainedRoundSpread: 10, onProgress: () => {},
  }));
  assert.equal(results.runs.length, 2);
  for (const run of results.runs) {
    assert.equal(run.gpu.samples, 8);
    assert.ok(run.gpu.medianMs > 0);
    assert.equal(run.gpuRoundMediansMs.length, 2);
    assert.ok(run.sustained.framesPerSecond > 0);
    assert.ok(run.sustainedMethod.includes('back-to-back'));
    assert.ok(run.output.distinctColors >= 32);
    assert.ok(run.draws.triangles >= run.draws.sceneTriangles);
  }
  assert.ok(results.runs.some((run) => run.backendKind === 'webgl' && run.sustainedGpuMsPerFrame !== null));
  assert.ok(results.runs.some((run) => run.backendKind === 'webgpu' && run.sustainedGpuMsPerFrame === null));
  assert.equal(results.restoreFailures.length, 0);

  const untimed = createFakeWorld({ trackTimestamp: false });
  await assert.rejects(
    withFakeBrowser(() => harness.benchmarkPipeline([untimed.native], { samples: 2, rounds: 2, warmupFrames: 1, sustainedFrames: 2, resolutions: [[16, 16]], onProgress: () => {} })),
    /timestamp tracking is disabled/,
  );
});
