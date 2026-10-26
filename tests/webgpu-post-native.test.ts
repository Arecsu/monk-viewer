import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DataTexture } from 'three/webgpu';
import { SMAAEdgeDetectionMaterial, SMAAWeightsMaterial } from 'postprocessing';
import {
	BLOOM_DOWNSAMPLE_PADDING,
	BLOOM_DOWNSAMPLE_WEIGHTS,
	BLOOM_UPSAMPLE_WEIGHTS,
	DitheringType,
	GT7_PARAMETERS,
	GT7_VIEWER_GRADE,
	bloomDownsampleSizes,
	bloomLevelPlan,
	bloomUpsampleSizes,
	dither,
	ditherLumaBased,
	ditherOrdered,
	ditherNoiseColor,
	gt7Constants,
	gt7GradeAndToneMap,
	gt7ToneMapping,
	normalizeGT7Parameters
} from '../src/webgpu/PostColorShaders.js';
import {
	SMAA_CONSTANTS,
	SMAA_EFFECT_DEFAULTS,
	SMAA_PRESETS,
	SMAAPredicationMode,
	SMAAPreset,
	WebGpuSMAA,
	calculatePredicatedThreshold,
	createSMAALookupTextures,
	decodeSMAALookupTextures,
	getOrthographicDepth,
	smaaAreaTextureURL,
	smaaSearchTextureURL
} from '../src/webgpu/SMAA.js';
import { WebGpuPostColor } from '../src/webgpu/PostColor.js';

const reference = JSON.parse(readFileSync(new URL('./fixtures/gt7-tone-mapping-reference.json', import.meta.url), 'utf8'));

const assertArrayClose = (actual: number[], expected: number[], epsilon = 1e-12) => {
	assert.equal(actual.length, expected.length);
	actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < epsilon, `${actual} vs ${expected}`));
};

test('GT7 constants and curve still match Polyphony\'s reference', () => {
	const constants = gt7Constants();
	for(const [key, value] of Object.entries(reference.constants)) {
		assert.ok(Math.abs(constants[key as keyof typeof constants] - (value as number)) < 1e-5, key);
	}
	for(const [input, expected] of reference.cases) {
		const output = gt7ToneMapping(input);
		output.forEach((x: number, i: number) => {
			assert.ok(Math.abs(x - expected[i]) < 1e-6, `${input} → ${output}, expected ${expected}`);
		});
	}
});

test('the viewer grade defaults to renderer.js and normalizes like the reference effect', () => {
	assert.deepEqual(GT7_VIEWER_GRADE, {
		exposure: 5.15,
		contrast: 1.0,
		blackPoint: -0.02,
		shadowToe: 1.37,
		toeLength: 0.25,
		shoulderStart: 0.37,
		highlightHardness: -0.08,
		chromaPreservation: 0.36,
		saturation: 1.0,
		vibrance: 0.1
	});
	const curve = normalizeGT7Parameters({
		...GT7_PARAMETERS,
		alpha: GT7_VIEWER_GRADE.highlightHardness,
		midPoint: GT7_VIEWER_GRADE.toeLength,
		linearSection: GT7_VIEWER_GRADE.shoulderStart,
		toeStrength: GT7_VIEWER_GRADE.shadowToe,
		blendRatio: GT7_VIEWER_GRADE.chromaPreservation
	});
	assert.equal(curve.alpha, GT7_VIEWER_GRADE.highlightHardness);
	assert.equal(curve.midPoint, GT7_VIEWER_GRADE.toeLength);
	assert.equal(curve.linearSection, GT7_VIEWER_GRADE.shoulderStart);
	assert.equal(curve.toeStrength, GT7_VIEWER_GRADE.shadowToe);
	assert.equal(curve.blendRatio, GT7_VIEWER_GRADE.chromaPreservation);
	// Reference updateCurve's clamps
	assert.equal(normalizeGT7Parameters({ ...GT7_PARAMETERS, alpha: 2 }).alpha, 0.95);
});

test('GT7 grade: black point, saturation and exposure behave like the reference shader', () => {
	const black = gt7GradeAndToneMap([0, 0, 0], { ...GT7_VIEWER_GRADE, blackPoint: 0 });
	assert.deepEqual(black, [0, 0, 0]);
	const lifted = gt7GradeAndToneMap([0, 0, 0], { ...GT7_VIEWER_GRADE, blackPoint: -0.02 });
	assert.ok(lifted.every((x) => x > 0), `${lifted}`);

	const grey = gt7GradeAndToneMap([0.2, 0.1, 0.05], { ...GT7_VIEWER_GRADE, saturation: 0 });
	assert.ok(Math.max(...grey) - Math.min(...grey) < 1e-5, `${grey}`);

	let previous = -1;
	for(const exposure of [1, 2, 4, 8]) {
		const value = gt7GradeAndToneMap([0.18, 0.18, 0.18], { ...GT7_VIEWER_GRADE, exposure })[0];
		assert.ok(value >= previous, `exposure ${exposure}: ${value}`);
		previous = value;
	}
});

test('resolution-independent bloom level plan keeps the coarsest mip at the reference height', () => {
	const plan1800 = bloomLevelPlan(1800);
	const plan900 = bloomLevelPlan(900);
	const plan1080 = bloomLevelPlan(1080);
	assert.equal(plan1800?.levels, 8);
	assert.equal(plan1800?.scale, 1);
	assert.equal(plan1800?.luminanceHeight, 1800);
	assert.equal(plan900?.levels, 7);
	assert.equal(plan900?.scale, 1);
	assert.equal(plan900?.luminanceHeight, 900);
	assert.equal(plan1080?.levels, 7);
	assert.ok(Math.abs((plan1080?.scale ?? 0) - 900 / 1080) < 1e-12);
	assert.equal(plan1080?.luminanceHeight, 900);

	for(let height = 64; height <= 2160; height += 7) {
		const plan = bloomLevelPlan(height);
		assert.ok(plan !== null);
		assert.ok(plan.scale > 0.5 && plan.scale <= 1, `scale at ${height}: ${plan.scale}`);
		assert.ok(Math.abs(plan.coarsestHeight - plan.targetHeight) <= 1, `height ${height}: ${plan.coarsestHeight} vs ${plan.targetHeight}`);
	}
});

test('bloom mip sizing and filters follow the stock MipmapBlurPass convolution', () => {
	assert.deepEqual(bloomDownsampleSizes(5, 3, 3), [[3, 2], [2, 1], [1, 1]]);
	assert.deepEqual(bloomDownsampleSizes(1600, 900, 2), [[800, 450], [400, 225]]);
	assert.deepEqual(bloomUpsampleSizes(1600, 900, 8, false), [
		[800, 450], [400, 225], [200, 113], [100, 57], [50, 29], [25, 15], [13, 8]
	]);
	assert.deepEqual(bloomUpsampleSizes(1600, 900, 8, true), [
		[1600, 900], [800, 450], [400, 225], [200, 113], [100, 57], [50, 29], [25, 15], [13, 8]
	]);
	assert.deepEqual(bloomUpsampleSizes(100, 100, 1, false), []);
	assert.deepEqual(bloomUpsampleSizes(100, 100, 1, true), [[100, 100]]);
	assert.equal(BLOOM_DOWNSAMPLE_PADDING, 8);
	const downsampleSum = 4 * BLOOM_DOWNSAMPLE_WEIGHTS.inner + 9 * BLOOM_DOWNSAMPLE_WEIGHTS.outer;
	assert.ok(Math.abs(downsampleSum - 1) < 1e-4, `${downsampleSum}`);
	const upsampleSum = 4 * BLOOM_UPSAMPLE_WEIGHTS.corner + 4 * BLOOM_UPSAMPLE_WEIGHTS.edge +
		BLOOM_UPSAMPLE_WEIGHTS.center;
	assert.ok(Math.abs(upsampleSum - 1) < 1e-12, `${upsampleSum}`);
});

test('dithering matches the reference formulas and keeps the zero-luma pixel black', () => {
	const color = [0.5, 0.25, 0.1];
	assertArrayClose(ditherOrdered([0.5, 0.5, 0.5], [0, 0], 1), [0.495, 0.495, 0.495]);
	assertArrayClose(ditherOrdered([0.5, 0.5, 0.5], [1, 0], 1), [0.5025, 0.5025, 0.5025]);
	assertArrayClose(ditherOrdered([0.5, 0.5, 0.5], [0, 1], 1), [0.5, 0.5, 0.5]);
	assertArrayClose(ditherOrdered([0.5, 0.5, 0.5], [1, 1], 1), [0.4975, 0.4975, 0.4975]);

	assert.deepEqual(ditherLumaBased([0, 0, 0], [10, 20], 1), [0, 0, 0]);
	const luma = ditherLumaBased(color, [10, 20], 1);
	const ratio = luma[0] / color[0];
	for(let i = 1; i < 3; ++i) assert.ok(Math.abs(luma[i] - color[i] * ratio) < 1e-12);
	assert.deepEqual(ditherLumaBased(color, [10, 20], 0), color);

	const noise = ditherNoiseColor(color, [3, 4], 1);
	assert.deepEqual(noise, ditherNoiseColor(color, [3, 4], 1));
	assert.deepEqual(ditherNoiseColor(color, [3, 4], 0), color);
	assert.deepEqual(dither(color, [10, 20], { intensity: 0, ditheringType: DitheringType.LUMABASED }), color);
	assert.deepEqual(dither(color, [10, 20], { intensity: 1, ditheringType: 99 }), color);
});

test('SMAA presets and lookup constants match postprocessing v7', () => {
	const weights = new SMAAWeightsMaterial();
	const edges = new SMAAEdgeDetectionMaterial();
	assert.equal(weights.defines.MAX_SEARCH_STEPS, SMAA_CONSTANTS.MAX_SEARCH_STEPS);
	assert.equal(weights.defines.MAX_SEARCH_STEPS_DIAG, SMAA_CONSTANTS.MAX_SEARCH_STEPS_DIAG);
	assert.equal(weights.defines.AREATEX_MAX_DISTANCE, SMAA_CONSTANTS.AREATEX_MAX_DISTANCE);
	assert.equal(weights.defines.AREATEX_MAX_DISTANCE_DIAG, SMAA_CONSTANTS.AREATEX_MAX_DISTANCE_DIAG);
	assert.equal(weights.defines.AREATEX_PIXEL_SIZE, '(1.0 / vec2(160.0, 560.0))');
	assert.equal(weights.defines.AREATEX_SUBTEX_SIZE, '(1.0 / 7.0)');
	assert.equal(weights.defines.SEARCHTEX_SIZE, 'vec2(66.0, 33.0)');
	assert.equal(weights.defines.SEARCHTEX_PACKED_SIZE, 'vec2(64.0, 16.0)');
	assert.equal(Number(edges.defines.LOCAL_CONTRAST_ADAPTATION_FACTOR), SMAA_CONSTANTS.LOCAL_CONTRAST_ADAPTATION_FACTOR);
	assert.equal(edges.defines.EDGE_DETECTION_MODE, SMAA_CONSTANTS.EDGE_DETECTION_MODE);
	assert.equal(edges.defines.PREDICATION_MODE, SMAA_CONSTANTS.PREDICATION_MODE);
	assert.equal(Number(edges.defines.PREDICATION_THRESHOLD), SMAA_EFFECT_DEFAULTS.predicationThreshold);
	assert.equal(Number(edges.defines.PREDICATION_SCALE), SMAA_EFFECT_DEFAULTS.predicationScale);
	assert.equal(Number(edges.defines.PREDICATION_STRENGTH), SMAA_EFFECT_DEFAULTS.predicationStrength);
	assert.equal(SMAA_EFFECT_DEFAULTS.predicationMode, SMAAPredicationMode.DEPTH);
	assert.deepEqual(SMAA_PRESETS[SMAAPreset.HIGH], {
		edgeDetectionThreshold: 0.01,
		orthogonalSearchSteps: 16,
		diagonalSearchSteps: 8,
		diagonalDetection: true,
		cornerDetection: true,
		cornerRounding: 25
	});
});

test('SMAA depth predication matches getOrthographicDepth and the reference threshold', () => {
	const near = 0.1, far = 100, depth = 0.5;
	const viewZ = near * far / ((far - near) * depth - far);
	const expected = (viewZ + near) / (near - far);
	assert.ok(Math.abs(getOrthographicDepth(depth, near, far, true) - expected) < 1e-12);
	assert.equal(getOrthographicDepth(0.37, near, far, false), 0.37);

	// delta .0001 is below PREDICATION_THRESHOLD .0002; delta .0002 reaches it.
	assertArrayClose(calculatePredicatedThreshold({
		depth: 0.5, left: 0.5001, top: 0.5003, edgeThreshold: 0.01
	}), [0.02, 0]);
	assertArrayClose(calculatePredicatedThreshold({
		depth: 0.5, left: 0.4999, top: 0.5003, edgeThreshold: 0.01,
		predicationScale: 3, predicationStrength: 0.5
	}), [0.03, 0.015]);
});

test('SMAA lookup assets exist and are reachable from the worker module', () => {
	for(const url of [smaaSearchTextureURL, smaaAreaTextureURL]) {
		const path = fileURLToPath(url);
		assert.ok(existsSync(path), path);
		assert.ok(statSync(path).size > 0, path);
	}
});

test('tone mapping fuses the HDR bloom add and leaves no composite target', () => {
	const post = new WebGpuPostColor({}, { width: 8, height: 8 });
	const source = new DataTexture(new Uint8Array(8 * 8 * 4), 8, 8);
	source.needsUpdate = true;
	try {
		assert.equal(post.bloomCompositeTarget, undefined);
		assert.equal(post._compositePass, undefined);
		const noop = () => {};
		post._luminancePass.render = noop;
		for(const entry of post._downPasses) entry.pass.render = noop;
		for(const entry of post._upPasses) entry.pass.render = noop;
		const originalBloom = post._renderBloom.bind(post);
		let bloomTexture;
		post._renderBloom = (src) => {

			bloomTexture = originalBloom(src);
			return bloomTexture;

		};
		let tone;
		post._tonePass.render = (target) => {

			tone = {
				source: post._toneSource.value,
				bloom: post._toneBloom.value,
				intensity: post.uBloomIntensity.value,
				target
			};

		};

		const result = post.render({ color: source });
		assert.equal(tone.source, source);
		assert.equal(tone.bloom, bloomTexture);
		assert.notEqual(tone.bloom, source);
		assert.equal(tone.intensity, post.bloom.intensity);
		assert.equal(tone.target, post.outputTarget);
		assert.equal(result.target, post.outputTarget);

		post.bloom.enabled = false;
		tone = null;
		bloomTexture = null;
		post.render({ color: source });
		assert.equal(tone.bloom, source);
		assert.equal(tone.intensity, 0);
		assert.equal(bloomTexture, null);
	} finally {
		post.dispose();
		source.dispose();
	}
});

test('PostColor constructs the complete reference chain and is idempotently disposable', async () => {
	const post = new WebGpuPostColor({}, { width: 1600, height: 900 });
	try {
		assert.equal(await post.ready, true);
		assert.equal(post.smaaPass, null);
		assert.equal(post.bloom.luminanceThreshold, 0.1);
		assert.equal(post.bloom.luminanceSmoothing, 0.4);
		assert.equal(post.bloom.intensity, 0.3);
		assert.equal(post.bloom.radius, 1);
		assert.equal(post.bloom.levels, 8);
		assert.equal(post.bloom.referenceHeight, 1800);
		assert.equal(post.bloom.activeLevels, 7);
		assert.equal(post.gt7ToneMapping.enabled, true);
		assert.equal(post.gt7ToneMapping.exposure, GT7_VIEWER_GRADE.exposure);
		assert.equal(post.gt7ToneMapping.blackPoint, GT7_VIEWER_GRADE.blackPoint);
		assert.equal(post.gt7ToneMapping.highlightHardness, GT7_VIEWER_GRADE.highlightHardness);
		assert.equal(post.reinhardToneMapping.enabled, false);
		assert.equal(post.dithering.enabled, true);
		assert.equal(post.dithering.ditheringType, DitheringType.LUMABASED);

		post.gt7ToneMapping.enabled = false;
		assert.equal(post.gt7ToneMapping.enabledUniform.value, 0);
		post.reinhardToneMapping.enabled = true;
		assert.equal(post.reinhardToneMapping.enabledUniform.value, 1);
		post.dithering.intensity = 0.5;
		assert.equal(post.dithering.intensityUniform.value, 0.5);
		post.gt7ToneMapping.highlightHardness = 0;
		assert.equal(post.gt7ToneMapping.curve.alpha, 0);

		post.setSize(1080, 1080);
		assert.equal(post.width, 1080);
		assert.equal(post.bloom.luminanceHeight, 900);
	} finally {
		post.dispose();
		post.dispose();
	}
});

test('SMAA is a real optional pass with worker-ready lookup textures', async () => {
	const search = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
	const area = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
	search.needsUpdate = true;
	area.needsUpdate = true;
	const post = new WebGpuPostColor({}, {
		width: 64, height: 64, smaa: true, smaaLookup: { search, area }
	});
	try {
		assert.ok(post.smaaPass !== null);
		const ready = await post.ready;
		assert.equal(typeof ready, 'boolean');
		assert.equal(ready, true);
		assert.equal(post.smaaPass.ready, true);
		assert.equal(post.smaaPass.preset, SMAAPreset.HIGH);
		assert.equal(post.smaaPass.orthogonalSearchSteps, 16);
		assert.equal(post.smaaPass.diagonalSearchSteps, 8);
		assert.equal(post.smaaPass.cornerDetection, true);
		assert.equal(post.smaaPass.predicationMode, SMAAPredicationMode.DEPTH);
		assert.equal(post.smaaPass.predicationThreshold, SMAA_EFFECT_DEFAULTS.predicationThreshold);
		assert.equal(post.smaaPass.predicationScale, SMAA_EFFECT_DEFAULTS.predicationScale);
		assert.equal(post.smaaPass.predicationStrength, SMAA_EFFECT_DEFAULTS.predicationStrength);
		post.smaaPass.enabled = false;
		assert.equal(post.smaaPass.enabled, false);
	} finally {
		post.dispose();
		search.dispose();
		area.dispose();
	}
});

test('SMAA depth predication fails without depth and does not require depth when disabled', async () => {
	const search = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
	const area = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
	search.needsUpdate = true;
	area.needsUpdate = true;
	const source = new DataTexture(new Uint8Array(8 * 8 * 4), 8, 8);
	source.needsUpdate = true;
	const post = new WebGpuPostColor({}, {
		width: 8, height: 8, smaa: true, smaaLookup: { search, area }
	});
	try {
		assert.equal(await post.ready, true);
		post.bloom.enabled = false;
		assert.throws(() => post.render({ color: source }), /depth/);
		assert.throws(() => post.render({ color: source, depth: new DataTexture(new Uint8Array(4), 1, 1) }), /camera/);

		post.smaaPass.predicationMode = SMAAPredicationMode.DISABLED;
		const noop = () => {};
		post.smaaPass._edgePass.render = noop;
		post.smaaPass._weightsPass.render = noop;
		post.smaaPass._blendPass.render = noop;
		post._tonePass.render = noop;
		const result = post.render({ color: source });
		assert.equal(result.target, post.outputTarget);
	} finally {
		post.dispose();
		source.dispose();
		search.dispose();
		area.dispose();
	}
});

test('SMAA closes owned bitmaps on dispose and on partial lookup failure', async () => {
	let closed = 0;
	const searchBitmap = { close() { closed += 1; } };
	const areaBitmap = { close() { closed += 1; } };
	const resources = createSMAALookupTextures({ search: searchBitmap, area: areaBitmap });
	resources.dispose();
	resources.dispose();
	assert.equal(closed, 2);

	const originalFetch = globalThis.fetch;
	const originalCreateImageBitmap = globalThis.createImageBitmap;
	const originalSearchClose = searchBitmap.close;
	let partialClosed = 0;
	searchBitmap.close = () => { partialClosed += 1; };
	try {
		globalThis.fetch = async (url) => ({
			ok: true,
			blob: async () => ({ tag: String(url).includes('area') ? 'area' : 'search' })
		});
		globalThis.createImageBitmap = async (blob) => {

			if(blob.tag === 'area') throw new Error('area decode failed');
			return searchBitmap;

		};
		await assert.rejects(decodeSMAALookupTextures({
			searchURL: 'search.png', areaURL: 'area.png'
		}), /area decode failed/);
		assert.equal(partialClosed, 1);
	} finally {
		searchBitmap.close = originalSearchClose;
		globalThis.fetch = originalFetch;
		if(originalCreateImageBitmap === undefined) delete globalThis.createImageBitmap;
		else globalThis.createImageBitmap = originalCreateImageBitmap;
	}
});

test('SMAA closes decoded bitmaps when disposed before lookup completes', async () => {
	const originalFetch = globalThis.fetch;
	const originalCreateImageBitmap = globalThis.createImageBitmap;
	let closed = 0;
	const pending = [];
	try {
		globalThis.fetch = async () => ({ ok: true, blob: async () => ({}) });
		globalThis.createImageBitmap = () => new Promise((resolve) => {

			pending.push(() => resolve({ close() { closed += 1; } }));

		});
		const smaa = new WebGpuSMAA({}, { width: 4, height: 4 });
		while(pending.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
		smaa.dispose();
		for(const resolve of pending) resolve();
		assert.equal(await smaa.readyPromise, false);
		assert.equal(closed, 2);
	} finally {
		globalThis.fetch = originalFetch;
		if(originalCreateImageBitmap === undefined) delete globalThis.createImageBitmap;
		else globalThis.createImageBitmap = originalCreateImageBitmap;
	}
});

test('WebGpuPostColor exposes the contract control objects without leaking renderer state', () => {
	const post = new WebGpuPostColor({}, { width: 32, height: 32 });
	try {
		assert.ok(post.bloom && post.gt7ToneMapping && post.reinhardToneMapping && post.dithering);
		assert.ok(post.bloom instanceof Object);
		// The control objects are independent of the uniforms they drive.
		post.reinhardToneMapping.exposure = 2.5;
		assert.equal(post.reinhardToneMapping.exposureUniform.value, 2.5);
		post.bloom.luminanceThreshold = 0.25;
		post.setSize(32, 32);
		assert.equal(post.bloom.luminanceThreshold, 0.25);
	} finally {
		post.dispose();
	}
});

