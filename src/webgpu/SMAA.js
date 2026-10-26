import * as GPU from 'three/webgpu';
import * as T from 'three/tsl';
import { FullscreenPass, createTarget, logicalUV, sampleLogical } from './Common.js';
import { srgbEncodeNode, sampleLogicalOffset } from './PostColorShaders.js';

/**
 * Worker-compatible SMAA (HIGH preset by default), ported from postprocessing v7's SMAAEffect/SMAA shaders.
 *
 * The lookup PNGs live next to the WebGL implementation. They are fetched and decoded with createImageBitmap in a
 * worker (the reference postprocessing loader uses Image, which workers lack). The search texture is decoded flipped,
 * exactly like src/postprocessing/SMAAEffect.ts, while the area texture keeps its source orientation.
 *
 * Edge detection runs on sRGB-encoded values (the reference SMAAEffect patch), blending stays in the display-linear
 * space passed in. The reference places an sRGB8 target before SMAA; the tone-mapping pass reproduces that quantization
 * (see quantizeSRGB8Node in PostColorShaders.js) before this pass when SMAA is enabled.
 */

export const SMAAPreset = Object.freeze({ LOW: 0, MEDIUM: 1, HIGH: 2, ULTRA: 3 });
export const SMAAPredicationMode = Object.freeze({ DISABLED: 0, DEPTH: 1, CUSTOM: 2 });

export const SMAA_PRESETS = Object.freeze({
	[SMAAPreset.LOW]: Object.freeze({
		edgeDetectionThreshold: 0.015, orthogonalSearchSteps: 4, diagonalSearchSteps: 0,
		diagonalDetection: false, cornerDetection: false, cornerRounding: 25
	}),
	[SMAAPreset.MEDIUM]: Object.freeze({
		edgeDetectionThreshold: 0.01, orthogonalSearchSteps: 8, diagonalSearchSteps: 0,
		diagonalDetection: false, cornerDetection: false, cornerRounding: 25
	}),
	[SMAAPreset.HIGH]: Object.freeze({
		edgeDetectionThreshold: 0.01, orthogonalSearchSteps: 16, diagonalSearchSteps: 8,
		diagonalDetection: true, cornerDetection: true, cornerRounding: 25
	}),
	[SMAAPreset.ULTRA]: Object.freeze({
		edgeDetectionThreshold: 0.005, orthogonalSearchSteps: 32, diagonalSearchSteps: 16,
		diagonalDetection: true, cornerDetection: true, cornerRounding: 25
	})
});

export const SMAA_CONSTANTS = Object.freeze({
	// SMAAWeightsMaterial defines, postprocessing 7.0.0-beta.16.
	MAX_SEARCH_STEPS: 16,
	MAX_SEARCH_STEPS_DIAG: 8,
	CORNER_ROUNDING: 25,
	CORNER_ROUNDING_NORM: 0.25,
	AREATEX_MAX_DISTANCE: 16,
	AREATEX_MAX_DISTANCE_DIAG: 20,
	AREATEX_WIDTH: 160,
	AREATEX_HEIGHT: 560,
	AREATEX_SUBTEX_SIZE: 1 / 7,
	SEARCHTEX_SIZE_X: 66,
	SEARCHTEX_SIZE_Y: 33,
	SEARCHTEX_PACKED_WIDTH: 64,
	SEARCHTEX_PACKED_HEIGHT: 16,
	LOCAL_CONTRAST_ADAPTATION_FACTOR: 2.0,
	EDGE_DETECTION_MODE: 2, // COLOR
	PREDICATION_MODE: 0, // SMAAEdgeDetectionMaterial default; SMAAEffect overrides with DEPTH
	PREDICATION_THRESHOLD: 0.0002,
	PREDICATION_SCALE: 2,
	PREDICATION_STRENGTH: 1
});

export const SMAA_EFFECT_DEFAULTS = Object.freeze({
	predicationMode: SMAAPredicationMode.DEPTH,
	predicationThreshold: 0.0002,
	predicationScale: 2,
	predicationStrength: 1
});

export const smaaSearchTextureURL = new URL('../postprocessing/smaa/search.png', import.meta.url);
export const smaaAreaTextureURL = new URL('../postprocessing/smaa/area.png', import.meta.url);

const presetAliases = new Map([
	['low', SMAAPreset.LOW],
	['medium', SMAAPreset.MEDIUM],
	['high', SMAAPreset.HIGH],
	['ultra', SMAAPreset.ULTRA]
]);

function resolvePreset(preset) {

	if(typeof preset === 'string') {
		const value = presetAliases.get(preset.toLowerCase());
		if(value === undefined) throw new Error(`Unknown SMAA preset: ${preset}`);
		return value;
	}
	if(!(preset in SMAA_PRESETS)) throw new Error(`Unknown SMAA preset: ${preset}`);
	return preset;

}

function createRGBA8Target(width, height, nearest = false) {

	const target = new GPU.RenderTarget(Math.max(1, width), Math.max(1, height), {
		depthBuffer: false, stencilBuffer: false
	});
	const texture = target.texture;
	texture.name = 'SMAA.RGBA8';
	texture.type = GPU.UnsignedByteType;
	texture.format = GPU.RGBAFormat;
	texture.internalFormat = 'rgba8unorm';
	texture.colorSpace = GPU.NoColorSpace;
	texture.minFilter = texture.magFilter = nearest ? GPU.NearestFilter : GPU.LinearFilter;
	texture.generateMipmaps = false;
	return target;

}

async function fetchBitmap(url, flipY) {

	if(typeof createImageBitmap !== 'function') throw new Error('SMAA lookup decoding requires createImageBitmap');
	const response = await fetch(url);
	if(!response.ok) throw new Error(`Failed to load SMAA lookup texture: ${url} (${response.status})`);
	const blob = await response.blob();
	return createImageBitmap(blob, {
		imageOrientation: flipY ? 'flipY' : 'from-image',
		premultiplyAlpha: 'none',
		colorSpaceConversion: 'none'
	});

}

/**
 * Decodes the SMAA search/area PNGs without a DOM. Safe in workers.
 */
export async function decodeSMAALookupTextures({
	searchURL = smaaSearchTextureURL,
	areaURL = smaaAreaTextureURL
} = {}) {

	// allSettled is required for cleanup: Promise.all rejects early and would leak the bitmap that still resolves.
	const results = await Promise.allSettled([fetchBitmap(searchURL, true), fetchBitmap(areaURL, false)]);
	const search = results[0].status === 'fulfilled' ? results[0].value : null;
	const area = results[1].status === 'fulfilled' ? results[1].value : null;
	if(search === null || area === null) {
		search?.close?.();
		area?.close?.();
		throw results.find((result) => result.status === 'rejected').reason;
	}
	return { search, area };

}

/**
 * Wraps decoded bitmaps in lookup textures. The returned resource owns both textures and the ImageBitmaps:
 * Texture.dispose() never closes bitmaps, so callers must use resource.dispose().
 */
export function createSMAALookupTextures({ search, area }) {

	const searchTexture = new GPU.Texture(search);
	searchTexture.name = 'SMAA.Search';
	searchTexture.magFilter = GPU.NearestFilter;
	searchTexture.minFilter = GPU.NearestFilter;
	searchTexture.generateMipmaps = false;
	searchTexture.flipY = false;
	searchTexture.colorSpace = GPU.NoColorSpace;
	searchTexture.needsUpdate = true;

	const areaTexture = new GPU.Texture(area);
	areaTexture.name = 'SMAA.Area';
	areaTexture.magFilter = GPU.LinearFilter;
	areaTexture.minFilter = GPU.LinearFilter;
	areaTexture.generateMipmaps = false;
	areaTexture.flipY = false;
	areaTexture.colorSpace = GPU.NoColorSpace;
	areaTexture.needsUpdate = true;

	let disposed = false;
	return {
		searchTexture,
		areaTexture,
		searchBitmap: search,
		areaBitmap: area,
		dispose() {

			if(disposed) return;
			disposed = true;
			searchTexture.dispose();
			areaTexture.dispose();
			search?.close?.();
			area?.close?.();

		}
	};

}

const F = (value) => T.float(value);
const V2 = (x, y) => T.vec2(x, y);
const V4 = (x, y, z, w) => T.vec4(x, y, z, w);
// textureSampleLevel keeps SMAA's branch/loop sampling valid under WGSL uniform-control-flow rules.
const sampleSMAA = (source, uv) => sampleLogical(source, uv).level(0);

const decodeDiagBilinearAccess = (e) => {

	const rb = V2(e.x, e.z);
	const decoded = T.round(rb.mul(rb.mul(5).sub(3.75).abs()));
	return V4(decoded.x, e.y, decoded.y, e.w);

};

const decodeDiagBilinearAccess2 = (e) => V2(
	T.round(e.x.mul(e.x.mul(5).sub(3.75).abs())), e.y
);

/**
 * CPU port of the reference getOrthographicDepth (packing.glsl.js, no reversed/log depth).
 */
export function getOrthographicDepth(depth, near, far, isPerspectiveCamera) {

	if(!isPerspectiveCamera) return depth;
	// perspectiveDepthToViewZ: near*far / ((far-near)*depth - far)
	const viewZ = near * far / ((far - near) * depth - far);
	// viewZToOrthographicDepth: (viewZ+near)/(near-far)
	return (viewZ + near) / (near - far);

}

/**
 * CPU port of the predicated threshold in SMAAEdgeDetectionMaterial.
 */
export function calculatePredicatedThreshold({
	depth,
	left,
	top,
	edgeThreshold,
	predicationThreshold = SMAA_EFFECT_DEFAULTS.predicationThreshold,
	predicationScale = SMAA_EFFECT_DEFAULTS.predicationScale,
	predicationStrength = SMAA_EFFECT_DEFAULTS.predicationStrength
}) {

	const delta = [Math.abs(depth - left), Math.abs(depth - top)];
	return delta.map((value) => predicationScale * edgeThreshold *
		(1 - predicationStrength * (value >= predicationThreshold ? 1 : 0)));

}

export class WebGpuSMAA {

	constructor(renderer, {
		width = 1,
		height = 1,
		preset = SMAAPreset.HIGH,
		lookup = null,
		searchURL = smaaSearchTextureURL,
		areaURL = smaaAreaTextureURL,
		enabled = true,
		predicationMode = SMAA_EFFECT_DEFAULTS.predicationMode,
		predicationThreshold = SMAA_EFFECT_DEFAULTS.predicationThreshold,
		predicationScale = SMAA_EFFECT_DEFAULTS.predicationScale,
		predicationStrength = SMAA_EFFECT_DEFAULTS.predicationStrength
	} = {}) {

		if(predicationMode === SMAAPredicationMode.CUSTOM) {
			throw new Error('SMAA CUSTOM predication requires a predication buffer, which the PostColor contract does not expose');
		}
		if(predicationMode !== SMAAPredicationMode.DISABLED && predicationMode !== SMAAPredicationMode.DEPTH) {
			throw new Error(`Unknown SMAA predication mode: ${predicationMode}`);
		}

		this.renderer = renderer;
		this.enabled = enabled;
		this.disposed = false;
		this.ready = false;
		this.error = null;
		this._predicationMode = predicationMode;
		this._preset = resolvePreset(preset);
		this._settings = { ...SMAA_PRESETS[this._preset] };
		this._searchURL = searchURL;
		this._areaURL = areaURL;
		this._lookup = lookup;
		this.searchTexture = null;
		this.areaTexture = null;
		this._lookupResources = null;
		this._edgePass = null;
		this._weightsPass = null;
		this._blendPass = null;
		this._edgeSource = null;
		this._blendSource = null;

		this.edgeTarget = createRGBA8Target(1, 1);
		this.weightsTarget = createRGBA8Target(1, 1);
		this.outputTarget = createTarget(1, 1, { format: 'rgba16float' });
		this._depthPlaceholder = new GPU.DepthTexture(1, 1, GPU.FloatType);
		this._depthSource = T.texture(this._depthPlaceholder, V2(0, 0));

		this.uResolution = T.uniform(new GPU.Vector2(1, 1));
		this.uTexel = T.uniform(new GPU.Vector2(1, 1));
		this.uEdgeThreshold = T.uniform(this._settings.edgeDetectionThreshold);
		this.uLocalContrast = T.uniform(SMAA_CONSTANTS.LOCAL_CONTRAST_ADAPTATION_FACTOR);
		this.uCameraNear = T.uniform(1);
		this.uCameraFar = T.uniform(1000);
		this.uPerspective = T.uniform(1);
		this.uPredicationThreshold = T.uniform(predicationThreshold);
		this.uPredicationScale = T.uniform(predicationScale);
		this.uPredicationStrength = T.uniform(predicationStrength);

		this.setSize(width, height);

		this.readyPromise = this._initializeLookup(lookup).catch((error) => {

			this.error = error;
			console.error('Failed to initialize SMAA lookup textures:', error);
			return false;

		});

	}

	get preset() {

		return this._preset;

	}

	set preset(value) {

		const resolved = resolvePreset(value);
		if(resolved === this._preset) return;
		this._preset = resolved;
		this._settings = { ...SMAA_PRESETS[resolved] };
		this.uEdgeThreshold.value = this._settings.edgeDetectionThreshold;
		this._rebuildMaterials();

	}

	get edgeDetectionThreshold() {

		return this.uEdgeThreshold.value;

	}

	set edgeDetectionThreshold(value) {

		this.uEdgeThreshold.value = value;

	}

	get localContrastAdaptationFactor() {

		return this.uLocalContrast.value;

	}

	set localContrastAdaptationFactor(value) {

		this.uLocalContrast.value = value;

	}

	get orthogonalSearchSteps() { return this._settings.orthogonalSearchSteps; }
	set orthogonalSearchSteps(value) {

		this._settings.orthogonalSearchSteps = Math.min(Math.max(value, 0), 112);
		this._rebuildMaterials();

	}

	get diagonalSearchSteps() { return this._settings.diagonalSearchSteps; }
	set diagonalSearchSteps(value) {

		this._settings.diagonalSearchSteps = Math.min(Math.max(value, 0), 20);
		this._rebuildMaterials();

	}

	get diagonalDetection() { return this._settings.diagonalDetection; }
	set diagonalDetection(value) {

		this._settings.diagonalDetection = Boolean(value);
		this._rebuildMaterials();

	}

	get cornerDetection() { return this._settings.cornerDetection; }
	set cornerDetection(value) {

		this._settings.cornerDetection = Boolean(value);
		this._rebuildMaterials();

	}

	get cornerRounding() { return this._settings.cornerRounding; }
	set cornerRounding(value) {

		this._settings.cornerRounding = Math.min(Math.max(value, 0), 100);
		this._rebuildMaterials();

	}

	get predicationMode() { return this._predicationMode; }
	set predicationMode(value) {

		if(value === SMAAPredicationMode.CUSTOM) {
			throw new Error('SMAA CUSTOM predication requires a predication buffer, which the PostColor contract does not expose');
		}
		if(value !== SMAAPredicationMode.DISABLED && value !== SMAAPredicationMode.DEPTH) {
			throw new Error(`Unknown SMAA predication mode: ${value}`);
		}
		if(value === this._predicationMode) return;
		this._predicationMode = value;
		this._rebuildMaterials();

	}

	get predicationThreshold() { return this.uPredicationThreshold.value; }
	set predicationThreshold(value) { this.uPredicationThreshold.value = value; }

	get predicationScale() { return this.uPredicationScale.value; }
	set predicationScale(value) { this.uPredicationScale.value = value; }

	get predicationStrength() { return this.uPredicationStrength.value; }
	set predicationStrength(value) { this.uPredicationStrength.value = value; }

	_initializeLookup(lookup) {

		return (async () => {

			let searchTexture = null;
			let areaTexture = null;
			let resources = null;

			if(lookup !== null && typeof lookup === 'object') {
				const search = lookup.searchTexture ?? lookup.search;
				const area = lookup.areaTexture ?? lookup.area;
				if(search?.isTexture === true && area?.isTexture === true) {
					searchTexture = search;
					areaTexture = area;
				} else if(search !== undefined && area !== undefined) {
					resources = createSMAALookupTextures({ search, area });
					searchTexture = resources.searchTexture;
					areaTexture = resources.areaTexture;
				}
			}

			if(searchTexture === null || areaTexture === null) {
				const bitmaps = await decodeSMAALookupTextures({
					searchURL: this._searchURL, areaURL: this._areaURL
				});
				resources = createSMAALookupTextures(bitmaps);
				searchTexture = resources.searchTexture;
				areaTexture = resources.areaTexture;
			}

			if(this.disposed) {
				resources?.dispose();
				return false;
			}
			this._lookupResources = resources;
			this.searchTexture = searchTexture;
			this.areaTexture = areaTexture;
			this._buildMaterials();
			this.ready = true;
			return true;

		})();

	}

	_rebuildMaterials() {

		if(this.ready) this._buildMaterials();

	}

	setSize(width, height) {

		if(this.disposed) return;
		const w = Math.max(1, Math.floor(width));
		const h = Math.max(1, Math.floor(height));
		this.width = w;
		this.height = h;
		this.edgeTarget.setSize(w, h);
		this.weightsTarget.setSize(w, h);
		this.outputTarget.setSize(w, h);
		this.uResolution.value.set(w, h);
		this.uTexel.value.set(1 / w, 1 / h);

	}

	_buildMaterials() {

		if(this.disposed) return;
		this._edgePass?.dispose();
		this._weightsPass?.dispose();
		this._blendPass?.dispose();

		const settings = this._settings;
		const searchTextureNode = T.texture(this.searchTexture, V2(0, 0));
		const areaTextureNode = T.texture(this.areaTexture, V2(0, 0));
		const edgeNode = T.texture(this.edgeTarget.texture, V2(0, 0));
		const weightsNode = T.texture(this.weightsTarget.texture, V2(0, 0));
		this._edgeSource = T.texture(this.edgeTarget.texture, V2(0, 0));
		this._blendSource = T.texture(this.edgeTarget.texture, V2(0, 0));

		const edgeFragment = T.Fn(() => {

			const uv = logicalUV;
			const texel = this.uTexel;
			const sample = (dx, dy) => srgbEncodeNode(sampleSMAA(this._edgeSource,
				uv.add(texel.mul(V2(dx, dy)))).rgb);
			const center = sample(0, 0);
			const left = sample(-1, 0);
			const top = sample(0, -1);
			const right = sample(1, 0);
			const bottom = sample(0, 1);
			const leftLeft = sample(-2, 0);
			const topTop = sample(0, -2);

			const deltaLeft = center.sub(left).abs();
			const deltaTop = center.sub(top).abs();
			const deltaX = T.max(deltaLeft.r, T.max(deltaLeft.g, deltaLeft.b));
			const deltaY = T.max(deltaTop.r, T.max(deltaTop.g, deltaTop.b));

			let threshold;
			if(this._predicationMode === SMAAPredicationMode.DEPTH) {
				// SMAAEdgeDetectionMaterial getOrthographicDepth + calculatePredicatedThreshold.
				const depthAt = (sampleUV) => {

					const depth = sampleSMAA(this._depthSource, sampleUV).r;
					// perspectiveDepthToViewZ then viewZToOrthographicDepth (packing.glsl.js, no reversed depth).
					const viewZ = this.uCameraNear.mul(this.uCameraFar).div(
						this.uCameraFar.sub(this.uCameraNear).mul(depth).sub(this.uCameraFar)
					);
					const orthographic = viewZ.add(this.uCameraNear)
						.div(this.uCameraNear.sub(this.uCameraFar));
					return T.select(this.uPerspective.greaterThan(0.5), orthographic, depth);

				};
				const depth = depthAt(uv);
				const depthLeft = depthAt(uv.add(texel.mul(V2(-1, 0))));
				const depthTop = depthAt(uv.add(texel.mul(V2(0, -1))));
				const depthDelta = V2(
					T.abs(depth.sub(depthLeft)),
					T.abs(depth.sub(depthTop))
				);
				const depthEdges = V2(
					T.step(this.uPredicationThreshold, depthDelta.x),
					T.step(this.uPredicationThreshold, depthDelta.y)
				);
				threshold = V2(
					this.uPredicationScale.mul(this.uEdgeThreshold)
						.mul(F(1).sub(this.uPredicationStrength.mul(depthEdges.x))),
					this.uPredicationScale.mul(this.uEdgeThreshold)
						.mul(F(1).sub(this.uPredicationStrength.mul(depthEdges.y)))
				);
			} else {
				threshold = V2(this.uEdgeThreshold, this.uEdgeThreshold);
			}
			const edgesX = T.step(threshold.x, deltaX);
			const edgesY = T.step(threshold.y, deltaY);

			const deltaRight = center.sub(right).abs();
			const deltaBottom = center.sub(bottom).abs();
			const maxDeltaX = T.max(deltaX, T.max(deltaRight.r, T.max(deltaRight.g, deltaRight.b)));
			const maxDeltaY = T.max(deltaY, T.max(deltaBottom.r, T.max(deltaBottom.g, deltaBottom.b)));
			const deltaLeftLeft = center.sub(leftLeft).abs();
			const deltaTopTop = center.sub(topTop).abs();
			const finalDeltaX = T.max(maxDeltaX,
				T.max(T.max(deltaLeftLeft.r, deltaLeftLeft.g), deltaLeftLeft.b));
			const finalDeltaY = T.max(maxDeltaY,
				T.max(T.max(deltaTopTop.r, deltaTopTop.g), deltaTopTop.b));
			const finalDelta = T.max(finalDeltaX, finalDeltaY);

			const edges = V2(edgesX, edgesY).mul(V2(
				T.step(finalDelta, this.uLocalContrast.mul(deltaX)),
				T.step(finalDelta, this.uLocalContrast.mul(deltaY))
			));
			return V4(edges.x, edges.y, 0, 1);

		})();

		const weightsFragment = T.Fn(() => {

			const uv = logicalUV;
			const texel = this.uTexel;
			const resolution = this.uResolution;
			const MAX_SEARCH_STEPS = settings.orthogonalSearchSteps;
			const MAX_SEARCH_STEPS_DIAG = settings.diagonalSearchSteps;
			const CORNER_ROUNDING_NORM = settings.cornerRounding / 100;
			const EDGE = (value) => sampleSMAA(edgeNode, value);
			const EDGE_OFFSET = (value, x, y) => sampleLogicalOffset(edgeNode, value, x, y);

			const searchLength = (e, offset) => {

				const scaleX = (SMAA_CONSTANTS.SEARCHTEX_SIZE_X * 0.5 - 1) /
					SMAA_CONSTANTS.SEARCHTEX_PACKED_WIDTH;
				const scaleY = (-SMAA_CONSTANTS.SEARCHTEX_SIZE_Y + 1) /
					SMAA_CONSTANTS.SEARCHTEX_PACKED_HEIGHT;
				const biasX = (SMAA_CONSTANTS.SEARCHTEX_SIZE_X * offset + 0.5) /
					SMAA_CONSTANTS.SEARCHTEX_PACKED_WIDTH;
				const biasY = (SMAA_CONSTANTS.SEARCHTEX_SIZE_Y - 0.5) /
					SMAA_CONSTANTS.SEARCHTEX_PACKED_HEIGHT;
				return T.texture(searchTextureNode, V2(
					scaleX * e.x + biasX, scaleY * e.y + biasY
				)).level(0).r;

			};

			const searchDiag1 = (texCoord, dirX, dirY) => {

				const x = texCoord.x.toVar();
				const y = texCoord.y.toVar();
				const z = F(-1).toVar();
				const w = F(1).toVar();
				const e = V2(0, 1).toVar();
				T.Loop(MAX_SEARCH_STEPS, () => {

					T.If(T.not(T.and(z.lessThan(MAX_SEARCH_STEPS_DIAG - 1), w.greaterThan(0.9))), () => {
						T.Break();
					});
					x.addAssign(texel.x.mul(dirX));
					y.addAssign(texel.y.mul(dirY));
					z.addAssign(1);
					e.assign(EDGE(V2(x, y)).rg);
					w.assign(T.dot(e, V2(0.5, 0.5)));

				});
				return { x: z, y: w };

			};

			const searchDiag2 = (texCoord, dirX, dirY) => {

				const x = texCoord.x.add(texel.x.mul(0.25)).toVar();
				const y = texCoord.y.toVar();
				const z = F(-1).toVar();
				const w = F(1).toVar();
				const e = V2(0, 1).toVar();
				T.Loop(MAX_SEARCH_STEPS, () => {

					T.If(T.not(T.and(z.lessThan(MAX_SEARCH_STEPS_DIAG - 1), w.greaterThan(0.9))), () => {
						T.Break();
					});
					x.addAssign(texel.x.mul(dirX));
					y.addAssign(texel.y.mul(dirY));
					z.addAssign(1);
					e.assign(decodeDiagBilinearAccess2(EDGE(V2(x, y)).rg));
					w.assign(T.dot(e, V2(0.5, 0.5)));

				});
				return { x: z, y: w };

			};

			const areaLookup = (dist, e1, e2, offset) => {

				const pixelSizeX = 1 / SMAA_CONSTANTS.AREATEX_WIDTH;
				const pixelSizeY = 1 / SMAA_CONSTANTS.AREATEX_HEIGHT;
				const texCoord = V2(
					F(SMAA_CONSTANTS.AREATEX_MAX_DISTANCE).mul(T.round(e1.mul(4))).add(dist.x)
						.mul(pixelSizeX).add(0.5 * pixelSizeX),
					F(SMAA_CONSTANTS.AREATEX_MAX_DISTANCE).mul(T.round(e2.mul(4))).add(dist.y)
						.mul(pixelSizeY).add(0.5 * pixelSizeY)
						.add(SMAA_CONSTANTS.AREATEX_SUBTEX_SIZE * offset)
				);
				return T.texture(areaTextureNode, texCoord).level(0).rg;

			};

			const areaDiagLookup = (dist, e, offset) => {

				const pixelSizeX = 1 / SMAA_CONSTANTS.AREATEX_WIDTH;
				const pixelSizeY = 1 / SMAA_CONSTANTS.AREATEX_HEIGHT;
				const texCoord = V2(
					F(SMAA_CONSTANTS.AREATEX_MAX_DISTANCE_DIAG).mul(e.x).add(dist.x)
						.mul(pixelSizeX).add(0.5 * pixelSizeX).add(0.5),
					F(SMAA_CONSTANTS.AREATEX_MAX_DISTANCE_DIAG).mul(e.y).add(dist.y)
						.mul(pixelSizeY).add(0.5 * pixelSizeY)
						.add(SMAA_CONSTANTS.AREATEX_SUBTEX_SIZE * offset)
				);
				return T.texture(areaTextureNode, texCoord).level(0).rg;

			};

			const calculateDiagWeights = (texCoord, e) => {

				const weights = V2(0, 0).toVar();
				const dX = F(0).toVar();
				const dY = F(0).toVar();
				const dZ = F(0).toVar();
				const dW = F(0).toVar();

				T.If(e.r.greaterThan(0), () => {

					const first = searchDiag1(texCoord, -1, 1);
					dX.assign(first.x);
					dZ.assign(first.y);
					T.If(first.y.greaterThan(0.9), () => dX.addAssign(1));

				});
				const second = searchDiag1(texCoord, 1, -1);
				dY.assign(second.x);
				dW.assign(second.y);

				T.If(dX.add(dY).greaterThan(2), () => {

					const coords0 = V2(dX.negate().add(0.25), dX).mul(texel).add(texCoord);
					const coords1 = V2(dY, dY.negate().sub(0.25)).mul(texel).add(texCoord);
					const c01 = EDGE_OFFSET(coords0, -1, 0).rg;
					const c23 = EDGE_OFFSET(coords1, 1, 0).rg;
					const decoded = decodeDiagBilinearAccess(V4(c01.x, c01.y, c23.x, c23.y));
					const ccX = decoded.y.mul(2).add(decoded.x);
					const ccY = decoded.w.mul(2).add(decoded.z);
					const cc = V2(
						T.select(dZ.greaterThanEqual(0.9), F(0), ccX),
						T.select(dW.greaterThanEqual(0.9), F(0), ccY)
					);
					weights.addAssign(areaDiagLookup(V2(dX, dY), cc, 0));

				});

				const third = searchDiag2(texCoord, -1, -1);
				dX.assign(third.x);
				dZ.assign(third.y);
				T.If(EDGE_OFFSET(texCoord, 1, 0).r.greaterThan(0), () => {

					const fourth = searchDiag2(texCoord, 1, 1);
					dY.assign(fourth.x);
					dW.assign(fourth.y);
					T.If(fourth.y.greaterThan(0.9), () => dY.addAssign(1));

				}).Else(() => {

					dY.assign(0);
					dW.assign(0);

				});

				T.If(dX.add(dY).greaterThan(2), () => {

					const coords0 = V2(dX.negate(), dX.negate()).mul(texel).add(texCoord);
					const coords1 = V2(dY, dY).mul(texel).add(texCoord);
					const c0 = EDGE_OFFSET(coords0, -1, 0).g;
					const c1 = EDGE_OFFSET(coords0, 0, -1).r;
					const c2 = EDGE_OFFSET(coords1, 1, 0).g;
					const c3 = EDGE_OFFSET(coords1, 1, 0).r;
					const ccX = c0.mul(2).add(c2);
					const ccY = c1.mul(2).add(c3);
					const cc = V2(
						T.select(dZ.greaterThanEqual(0.9), F(0), ccX),
						T.select(dW.greaterThanEqual(0.9), F(0), ccY)
					);
					const area = areaDiagLookup(V2(dX, dY), cc, 0);
					weights.addAssign(V2(area.y, area.x));

				});

				return weights;

			};

			const searchXLeft = (texCoord, end) => {

				const x = texCoord.x.toVar();
				const y = texCoord.y;
				const e = V2(0, 1).toVar();
				T.Loop(MAX_SEARCH_STEPS, () => {

					T.If(T.not(T.and(x.greaterThan(end), e.y.greaterThan(0.8281), e.x.equal(0))), () => {
						T.Break();
					});
					e.assign(EDGE(V2(x, y)).rg);
					x.subAssign(texel.x.mul(2));

				});
				const offset = searchLength(e, 0).mul(-255 / 127).add(3.25);
				return texel.x.mul(offset).add(x);

			};

			const searchXRight = (texCoord, end) => {

				const x = texCoord.x.toVar();
				const y = texCoord.y;
				const e = V2(0, 1).toVar();
				T.Loop(MAX_SEARCH_STEPS, () => {

					T.If(T.not(T.and(x.lessThan(end), e.y.greaterThan(0.8281), e.x.equal(0))), () => {
						T.Break();
					});
					e.assign(EDGE(V2(x, y)).rg);
					x.addAssign(texel.x.mul(2));

				});
				const offset = searchLength(e, 0.5).mul(-255 / 127).add(3.25);
				return texel.x.mul(offset).negate().add(x);

			};

			const searchYUp = (texCoord, end) => {

				const x = texCoord.x;
				const y = texCoord.y.toVar();
				const e = V2(1, 0).toVar();
				T.Loop(MAX_SEARCH_STEPS, () => {

					T.If(T.not(T.and(y.greaterThan(end), e.x.greaterThan(0.8281), e.y.equal(0))), () => {
						T.Break();
					});
					e.assign(EDGE(V2(x, y)).rg);
					y.subAssign(texel.y.mul(2));

				});
				const offset = searchLength(V2(e.y, e.x), 0).mul(-255 / 127).add(3.25);
				return texel.y.mul(offset).add(y);

			};

			const searchYDown = (texCoord, end) => {

				const x = texCoord.x;
				const y = texCoord.y.toVar();
				const e = V2(1, 0).toVar();
				T.Loop(MAX_SEARCH_STEPS, () => {

					T.If(T.not(T.and(y.lessThan(end), e.x.greaterThan(0.8281), e.y.equal(0))), () => {
						T.Break();
					});
					e.assign(EDGE(V2(x, y)).rg);
					y.addAssign(texel.y.mul(2));

				});
				const offset = searchLength(V2(e.y, e.x), 0.5).mul(-255 / 127).add(3.25);
				return texel.y.mul(offset).negate().add(y);

			};

			const cornerFactorHorizontal = (texCoord, d) => {

				const leftRight = V2(T.step(d.x, d.y), T.step(d.y, d.x));
				const rounding = leftRight.mul(1 - CORNER_ROUNDING_NORM)
					.div(leftRight.x.add(leftRight.y));
				const fx = F(1)
					.sub(rounding.x.mul(EDGE_OFFSET(texCoord.xy, 0, 1).r))
					.sub(rounding.y.mul(EDGE_OFFSET(texCoord.zw, 1, 1).r));
				const fy = F(1)
					.sub(rounding.x.mul(EDGE_OFFSET(texCoord.xy, 0, -2).r))
					.sub(rounding.y.mul(EDGE_OFFSET(texCoord.zw, 1, -2).r));
				return T.clamp(V2(fx, fy), 0, 1);

			};

			const cornerFactorVertical = (texCoord, d) => {

				const leftRight = V2(T.step(d.x, d.y), T.step(d.y, d.x));
				const rounding = leftRight.mul(1 - CORNER_ROUNDING_NORM)
					.div(leftRight.x.add(leftRight.y));
				const fx = F(1)
					.sub(rounding.x.mul(EDGE_OFFSET(texCoord.xy, 1, 0).g))
					.sub(rounding.y.mul(EDGE_OFFSET(texCoord.zw, 1, 1).g));
				const fy = F(1)
					.sub(rounding.x.mul(EDGE_OFFSET(texCoord.xy, -2, 0).g))
					.sub(rounding.y.mul(EDGE_OFFSET(texCoord.zw, -2, 1).g));
				return T.clamp(V2(fx, fy), 0, 1);

			};

			const weights = V4(0, 0, 0, 0).toVar();
			const e = EDGE(uv).rg.toVar();

			const vOffset0 = V4(
				uv.x.sub(texel.x.mul(0.25)), uv.y.sub(texel.y.mul(0.125)),
				uv.x.add(texel.x.mul(1.25)), uv.y.sub(texel.y.mul(0.125))
			);
			const vOffset1 = V4(
				uv.x.sub(texel.x.mul(0.125)), uv.y.sub(texel.y.mul(0.25)),
				uv.x.sub(texel.x.mul(0.125)), uv.y.add(texel.y.mul(1.25))
			);
			const vOffset2 = V4(
				uv.x.sub(texel.x.mul(2 * MAX_SEARCH_STEPS + 0.25)),
				uv.x.add(texel.x.mul(2 * MAX_SEARCH_STEPS + 1.25)),
				uv.y.sub(texel.y.mul(2 * MAX_SEARCH_STEPS + 0.25)),
				uv.y.add(texel.y.mul(2 * MAX_SEARCH_STEPS + 1.25))
			);
			const vPixCoord = uv.mul(resolution);

			const horizontal = () => {

				const leftEnd = searchXLeft(V2(vOffset0.x, vOffset0.y), vOffset2.x);
				const rightEnd = searchXRight(V2(vOffset0.z, vOffset0.w), vOffset2.y);
				const e1 = EDGE(V2(leftEnd, vOffset1.y)).r;
				const e2 = EDGE_OFFSET(V2(rightEnd, vOffset1.y), 1, 0).r;
				const d = V2(
					T.round(resolution.x.mul(leftEnd).sub(vPixCoord.x)),
					T.round(resolution.x.mul(rightEnd).sub(vPixCoord.x))
				);
				const area = areaLookup(T.sqrt(d.abs()), e1, e2, 0);
				weights.x.assign(area.x);
				weights.y.assign(area.y);
				if(settings.cornerDetection) {
					const factor = cornerFactorHorizontal(
						V4(leftEnd, uv.y, rightEnd, uv.y), d
					);
					weights.x.assign(weights.x.mul(factor.x));
					weights.y.assign(weights.y.mul(factor.y));
				}

			};

			const vertical = () => {

				const upEnd = searchYUp(V2(vOffset1.x, vOffset1.y), vOffset2.z);
				const downEnd = searchYDown(V2(vOffset1.z, vOffset1.w), vOffset2.w);
				const e1 = EDGE(V2(vOffset0.x, upEnd)).g;
				const e2 = EDGE_OFFSET(V2(vOffset0.x, downEnd), 0, 1).g;
				const d = V2(
					T.round(resolution.y.mul(upEnd).sub(vPixCoord.y)),
					T.round(resolution.y.mul(downEnd).sub(vPixCoord.y))
				);
				const area = areaLookup(T.sqrt(d.abs()), e1, e2, 0);
				weights.z.assign(area.x);
				weights.w.assign(area.y);
				if(settings.cornerDetection) {
					const factor = cornerFactorVertical(
						V4(uv.x, upEnd, uv.x, downEnd), d
					);
					weights.z.assign(weights.z.mul(factor.x));
					weights.w.assign(weights.w.mul(factor.y));
				}

			};

			T.If(e.g.greaterThan(0), () => {

				if(settings.diagonalDetection) {
					const diag = calculateDiagWeights(uv, e);
					weights.x.assign(diag.x);
					weights.y.assign(diag.y);
					T.If(weights.x.equal(weights.y.negate()), () => {

						horizontal();

					}).Else(() => {

						e.assign(V2(0, e.y));

					});
				} else {

					horizontal();

				}

			});

			T.If(e.r.greaterThan(0), () => vertical());

			return weights;

		})();

		const blendFragment = T.Fn(() => {

			const uv = logicalUV;
			const texel = this.uTexel;
			const aX = sampleLogicalOffset(weightsNode, uv, 1, 0).a;
			const aY = sampleLogicalOffset(weightsNode, uv, 0, 1).g;
			const center = sampleSMAA(weightsNode, uv);
			const aZ = center.b;
			const aW = center.r;
			const a = V4(aX, aY, aZ, aW);
			const inputColor = sampleSMAA(this._blendSource, uv);
			const color = inputColor.toVar();

			T.If(T.dot(a, V4(1, 1, 1, 1)).greaterThanEqual(1e-5), () => {

				const horizontalBlend = T.max(aX, aZ).greaterThan(T.max(aY, aW));
				const offset = V4(F(0), aY, F(0), aW).toVar();
				const weight = V2(aY, aW).toVar();
				T.If(horizontalBlend, () => {

					offset.assign(V4(aX, F(0), aZ, F(0)));
					weight.assign(V2(aX, aZ));

				});
				weight.assign(weight.div(T.dot(weight, V2(1, 1))));
				const coord = offset.mul(V4(
					texel.x, texel.y, texel.x.negate(), texel.y.negate()
				)).add(V4(uv.x, uv.y, uv.x, uv.y));
				color.assign(
					sampleSMAA(this._blendSource, V2(coord.x, coord.y)).mul(weight.x)
						.add(sampleSMAA(this._blendSource, V2(coord.z, coord.w)).mul(weight.y))
				);

			});

			return color;

		})();

		this._edgePass = new FullscreenPass(this.renderer, edgeFragment, {
			target: this.edgeTarget, name: 'SMAAEdgeDetection'
		});
		this._weightsPass = new FullscreenPass(this.renderer, weightsFragment, {
			target: this.weightsTarget, name: 'SMAAWeights'
		});
		this._blendPass = new FullscreenPass(this.renderer, blendFragment, {
			target: this.outputTarget, name: 'SMAABlend'
		});
		this._edgeSource.value = this.edgeTarget.texture;
		this._blendSource.value = this.edgeTarget.texture;

	}

	validatePredication(depth, camera) {

		if(this._predicationMode !== SMAAPredicationMode.DEPTH) return null;
		if(depth === null || depth === undefined) {
			throw new Error('SMAA depth predication is enabled but PostColor.render received no depth');
		}
		const depthTexture = depth.isTexture === true ? depth :
			(depth.depthTexture?.isTexture === true ? depth.depthTexture : depth.texture);
		if(depthTexture?.isTexture !== true) {
			throw new TypeError('SMAA depth predication expects a depth texture or render target');
		}
		if(camera === null || camera === undefined) {
			throw new Error('SMAA depth predication is enabled but PostColor.render received no camera');
		}
		const { near, far, isPerspectiveCamera } = camera;
		if(typeof near !== 'number' || !Number.isFinite(near) ||
			typeof far !== 'number' || !Number.isFinite(far) || near === far) {
			throw new RangeError('SMAA depth predication requires a camera with finite near/far and near != far');
		}
		if(typeof isPerspectiveCamera !== 'boolean') {
			throw new TypeError('SMAA depth predication requires camera.isPerspectiveCamera');
		}
		this.uCameraNear.value = near;
		this.uCameraFar.value = far;
		this.uPerspective.value = isPerspectiveCamera ? 1 : 0;
		this._depthSource.value = depthTexture;
		return depthTexture;

	}

	render(sourceTexture, target = this.outputTarget, { depth, camera } = {}) {

		if(this.disposed || !this.enabled || !this.ready || this._edgePass === null) return null;
		this.validatePredication(depth, camera);
		this._edgeSource.value = sourceTexture;
		this._edgePass.render(this.edgeTarget);
		this._weightsPass.render(this.weightsTarget);
		this._blendSource.value = sourceTexture;
		this._blendPass.render(target);
		return target;

	}

	dispose() {

		if(this.disposed) return;
		this.disposed = true;
		this.ready = false;
		this._edgePass?.dispose();
		this._weightsPass?.dispose();
		this._blendPass?.dispose();
		this.edgeTarget.dispose();
		this.weightsTarget.dispose();
		this.outputTarget.dispose();
		this._depthPlaceholder.dispose();
		this._lookupResources?.dispose();
		this._lookupResources = null;

	}

}
