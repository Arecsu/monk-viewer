import * as T from 'three/tsl';
import { logicalUV, sampleLogical } from './Common.js';

/**
 * CPU and TSL ports of the post-color reference chain: bounded bloom, GT7 (plus grade), Reinhard, and the custom
 * dithering. The shader functions intentionally use logical (bottom-left) UVs through Common.js so the ports keep
 * the WebGL reference's pixel coordinates; only texture storage is top-left.
 */

// DitheringType in src/postprocessing/enums/DitheringType.ts.
export const DitheringType = Object.freeze({ NOISECOLOR: 0, ORDERED: 1, LUMABASED: 2 });

export const GT7_PARAMETERS = Object.freeze({
	alpha: 0.25, midPoint: 0.538, linearSection: 0.444, toeStrength: 1.28, blendRatio: 0.6
});

// src/renderer.js GT7ToneMappingEffect constructor.
export const GT7_VIEWER_GRADE = Object.freeze({
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

// Gran Turismo 7 reference constants (GT7ToneMappingEffect.ts).
const REFERENCE_LUMINANCE = 100;
const SDR_PAPER_WHITE = 250;
const FADE_START = 0.98;
const FADE_END = 1.16;
const PQ = Object.freeze({ m1: 0.1593017578125, m2: 78.84375, c1: 0.8359375, c2: 18.8515625, c3: 18.6875, peak: 10000 });

const REC2020_LUMINANCE = [0.2627, 0.6780, 0.0593];
const MIDDLE_GREY = 0.18;

// Row-major matrices from the reference GLSL. The helper functions below apply them row by row, i.e. v * M.
const REC709_TO_REC2020 = [
	[0.6274040, 0.3292820, 0.0433136],
	[0.0690970, 0.9195400, 0.0113612],
	[0.0163916, 0.0880132, 0.8955950]
];
const REC2020_TO_REC709 = [
	[1.6604910, -0.5876411, -0.0728499],
	[-0.1245505, 1.1328999, -0.0083494],
	[-0.0181508, -0.1005789, 1.1187297]
];
const RGB_TO_LMS = [
	[1688 / 4096, 2146 / 4096, 262 / 4096],
	[683 / 4096, 2951 / 4096, 462 / 4096],
	[99 / 4096, 309 / 4096, 3688 / 4096]
];
const LMS_TO_ICTCP = [
	[2048 / 4096, 2048 / 4096, 0],
	[6610 / 4096, -13613 / 4096, 7003 / 4096],
	[17933 / 4096, -17390 / 4096, -543 / 4096]
];
const ICTCP_TO_LMS = [
	[1, 0.00860904, 0.11103],
	[1, -0.00860904, -0.11103],
	[1, 0.560031, -0.320627]
];
const LMS_TO_RGB = [
	[3.43661, -2.50645, 0.0698454],
	[-0.79133, 1.9836, -0.192271],
	[-0.0259499, -0.0989137, 1.12486]
];

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const applyMatrix = (rgb, matrix) => matrix.map((row) => dot3(row, rgb));

const smoothStep = (x, edge0, edge1) => {

	if(x < edge0) return 0;
	if(x > edge1) return 1;
	const t = (x - edge0) / (edge1 - edge0);
	return t * t * (3 - 2 * t);

};

const inverseEotfSt2084 = (v) => {

	const ym = Math.pow(v * REFERENCE_LUMINANCE / PQ.peak, PQ.m1);
	return Math.pow(2, PQ.m2 * (Math.log2(PQ.c1 + PQ.c2 * ym) - Math.log2(1 + PQ.c3 * ym)));

};

const eotfSt2084 = (n) => {

	n = clamp(n, 0, 1);
	const np = Math.pow(n, 1 / PQ.m2);
	const l = Math.max(np - PQ.c1, 0) / (PQ.c2 - PQ.c3 * np);
	return Math.pow(l, 1 / PQ.m1) * PQ.peak / REFERENCE_LUMINANCE;

};

const rgbToICtCp = ([r, g, b]) => {

	const l = inverseEotfSt2084(dot3([r, g, b], RGB_TO_LMS[0]));
	const m = inverseEotfSt2084(dot3([r, g, b], RGB_TO_LMS[1]));
	const s = inverseEotfSt2084(dot3([r, g, b], RGB_TO_LMS[2]));
	return [dot3([l, m, s], LMS_TO_ICTCP[0]),
		dot3([l, m, s], LMS_TO_ICTCP[1]),
		dot3([l, m, s], LMS_TO_ICTCP[2])];

};

const iCtCpToRgb = ([i, ct, cp]) => {

	const l = eotfSt2084(dot3([i, ct, cp], ICTCP_TO_LMS[0]));
	const m = eotfSt2084(dot3([i, ct, cp], ICTCP_TO_LMS[1]));
	const s = eotfSt2084(dot3([i, ct, cp], ICTCP_TO_LMS[2]));
	return [
		Math.max(dot3([l, m, s], LMS_TO_RGB[0]), 0),
		Math.max(dot3([l, m, s], LMS_TO_RGB[1]), 0),
		Math.max(dot3([l, m, s], LMS_TO_RGB[2]), 0)
	];

};

export function gt7Constants({ alpha, linearSection } = GT7_PARAMETERS) {

	const peak = SDR_PAPER_WHITE / REFERENCE_LUMINANCE;
	const k = (linearSection - 1) / (alpha - 1);
	return {
		peak,
		kA: peak * linearSection + peak * k,
		kB: -peak * k * Math.exp(linearSection / k),
		kC: -1 / (k * peak),
		targetUcs: rgbToICtCp([peak, peak, peak])[0]
	};

}

export function normalizeGT7Parameters(parameters = GT7_PARAMETERS) {

	const curve = { ...GT7_PARAMETERS, ...parameters };
	// The reference clamps these in GT7ToneMappingEffect.updateCurve; the shader receives the clamped values.
	curve.alpha = Math.min(curve.alpha, 0.95);
	curve.linearSection = Math.min(Math.max(curve.linearSection, 0.05), 0.95);
	const { peak } = gt7Constants(curve);
	curve.midPoint = Math.min(Math.max(curve.midPoint, 0.01), curve.linearSection * peak);
	curve.blendRatio = clamp(curve.blendRatio, 0, 1);
	return curve;

}

/**
 * CPU reference of GT7ToneMappingEffect.applyToneMapping: linear Rec.2020 in, linear Rec.2020 in [0, 1] out.
 */
export function gt7ToneMapping(rgb, parameters = GT7_PARAMETERS) {

	const { peak, kA, kB, kC, targetUcs } = gt7Constants(parameters);
	const { midPoint, linearSection, toeStrength, blendRatio } = parameters;
	const curve = (x) => {

		if(x < 0) return 0;
		const weightLinear = smoothStep(x, 0, midPoint);
		if(x < linearSection * peak) {
			return (1 - weightLinear) * midPoint * Math.pow(x / midPoint, toeStrength) + weightLinear * x;
		}
		return kA + kB * Math.exp(x * kC);

	};

	const ucs = rgbToICtCp(rgb);
	const skewed = rgb.map(curve);
	const skewedUcs = rgbToICtCp(skewed);
	const chromaScale = 1 - smoothStep(ucs[0] / targetUcs, FADE_START, FADE_END);
	const scaled = iCtCpToRgb([skewedUcs[0], ucs[1] * chromaScale, ucs[2] * chromaScale]);
	const sdrCorrection = REFERENCE_LUMINANCE / SDR_PAPER_WHITE;
	return skewed.map((x, i) => sdrCorrection * Math.min((1 - blendRatio) * x + blendRatio * scaled[i], peak));

}

/**
 * CPU reference of the complete GT7 effect (grade, curve, Rec.709 conversion and black point). The shader below
 * mirrors this function node by node.
 */
export function gt7GradeAndToneMap(rgb709, options = GT7_VIEWER_GRADE) {

	const grade = { ...GT7_VIEWER_GRADE, ...options };
	const parameters = normalizeGT7Parameters({
		alpha: grade.highlightHardness,
		midPoint: grade.toeLength,
		linearSection: grade.shoulderStart,
		toeStrength: grade.shadowToe,
		blendRatio: grade.chromaPreservation
	});

	let rgb = applyMatrix(rgb709, REC709_TO_REC2020);
	let luminance = dot3(rgb, REC2020_LUMINANCE);
	if(luminance > 0) {
		const factor = Math.pow(luminance / MIDDLE_GREY, grade.contrast - 1);
		rgb = rgb.map((x) => x * factor);
	}
	rgb = rgb.map((x) => x * grade.exposure);

	luminance = dot3(rgb, REC2020_LUMINANCE);
	const brightest = Math.max(rgb[0], rgb[1], rgb[2]);
	const saturation = brightest > 0 ? 1 - Math.min(rgb[0], Math.min(rgb[1], rgb[2])) / brightest : 0;
	const saturationScale = grade.saturation * (1 + grade.vibrance * (1 - saturation));
	rgb = rgb.map((x) => Math.max(luminance + (x - luminance) * saturationScale, 0));

	rgb = gt7ToneMapping(rgb, parameters);
	rgb = applyMatrix(rgb, REC2020_TO_REC709).map((x) => clamp(x, 0, 1));

	if(grade.blackPoint !== 0) {
		let v = rgb.map((x) => Math.pow(x, 1 / 2.2));
		v = grade.blackPoint > 0 ? v.map((x) => Math.max(x - grade.blackPoint, 0) / (1 - grade.blackPoint)) :
			v.map((x) => -grade.blackPoint + (1 + grade.blackPoint) * x);
		rgb = v.map((x) => Math.pow(x, 2.2));
	}

	return rgb;

}

export function reinhardToneMapping(rgb, exposure = 1) {

	return rgb.map((x) => clamp(x * exposure / (1 + x * exposure), 0, 1));

}

// ---------------------------------------------------------------------------------------------------------------------
// Dithering CPU references (src/postprocessing/dithering.frag)
// ---------------------------------------------------------------------------------------------------------------------

const BAYER_MATRIX = [
	0 / 16, 8 / 16, 2 / 16, 10 / 16,
	12 / 16, 4 / 16, 14 / 16, 6 / 16,
	3 / 16, 11 / 16, 1 / 16, 9 / 16,
	15 / 16, 7 / 16, 13 / 16, 5 / 16
];

export const rand = ([x, y]) => {

	const value = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
	return value - Math.floor(value);

};

export function ditherNoiseColor(color, fragCoord, intensity = 1) {

	// mix(2 * shift, -2 * shift, noise) from dithering.frag.
	const gridPosition = rand(fragCoord);
	const shift = [0.25 / 255, -0.25 / 255, 0.25 / 255];
	return color.map((x, i) => x + 2 * shift[i] * (1 - 2 * gridPosition) * intensity);

}

export function ditherOrdered(color, fragCoord, intensity = 1) {

	const x = Math.trunc(fragCoord[0]) % 4;
	const y = Math.trunc(fragCoord[1]) % 4;
	// GLSL mat4 arguments are column-major: bayerMatrix[x][y] is BAYER_MATRIX[x * 4 + y].
	const bayerValue = BAYER_MATRIX[x * 4 + y];
	return color.map((x) => x + (bayerValue - 0.5) * intensity * 0.01);

}

export function ditherLumaBased(color, fragCoord, intensity = 1) {

	const luma = dot3(color, [0.2126, 0.7152, 0.0722]);
	// The reference divides by luma. For pure black this is undefined (0/0 in GLSL); keep the pixel black instead of
	// letting a NaN reach the display. This is the only numerical-safety difference from the reference shader.
	if(luma === 0) return [0, 0, 0];
	const noise = rand(fragCoord) - 0.5;
	const ditheredLuma = luma + noise * intensity * 0.0015;
	return color.map((x) => x * (ditheredLuma / luma));

}

export function dither(color, fragCoord, { intensity = 1, ditheringType = DitheringType.LUMABASED } = {}) {

	if(ditheringType === DitheringType.NOISECOLOR) return ditherNoiseColor(color, fragCoord, intensity);
	if(ditheringType === DitheringType.ORDERED) return ditherOrdered(color, fragCoord, intensity);
	if(ditheringType === DitheringType.LUMABASED) return ditherLumaBased(color, fragCoord, intensity);
	return color.slice();

}

// ---------------------------------------------------------------------------------------------------------------------
// Bloom filter and resolution planning (BoundedBloomEffect.ts / postprocessing MipmapBlurPass.ts)
// ---------------------------------------------------------------------------------------------------------------------

export const BLOOM_DOWNSAMPLE_PADDING = 8;
export const BLOOM_DOWNSAMPLE_WEIGHTS = Object.freeze({ inner: 0.125, outer: 0.05556 });
export const BLOOM_UPSAMPLE_WEIGHTS = Object.freeze({ corner: 0.0625, edge: 0.125, center: 0.25 });

const halve = (value) => Math.max(1, Math.round(value / 2));

export function bloomDownsampleSizes(width, height, levels) {

	const sizes = [];
	let w = Math.max(1, width), h = Math.max(1, height);
	for(let i = 0; i < levels; ++i) {
		w = halve(w);
		h = halve(h);
		sizes.push([w, h]);
	}
	return sizes;

}

export function bloomUpsampleSizes(width, height, levels, fullResolutionUpsampling = false) {

	if(levels === 1 && !fullResolutionUpsampling) return [];
	const count = fullResolutionUpsampling ? levels : levels - 1;
	let w = fullResolutionUpsampling ? Math.max(1, width) : halve(width);
	let h = fullResolutionUpsampling ? Math.max(1, height) : halve(height);
	const sizes = [];
	for(let i = 0; i < count; ++i) {
		sizes.push([w, h]);
		w = halve(w);
		h = halve(h);
	}
	return sizes;

}

/**
 * Resolution-independent level count/resampling from BoundedBloomEffect.updateScale. The coarsest mip stays at
 * referenceHeight / 2^referenceLevels pixels, so the bloom reach is relative to the screen at any render scale.
 */
export function bloomLevelPlan(height, {
	referenceHeight = 1800,
	referenceLevels = 8,
	luminanceEnabled = true
} = {}) {

	if(!(height > 0)) return null;
	const safeReferenceHeight = referenceHeight > 0 ? referenceHeight : 1800;
	const safeReferenceLevels = referenceLevels >= 0 ? referenceLevels : 8;
	const targetHeight = safeReferenceHeight / 2 ** safeReferenceLevels;
	const ratio = Math.log2(height / targetHeight);
	const levels = Math.max(luminanceEnabled ? Math.floor(ratio) : Math.round(ratio), 1);
	const scale = luminanceEnabled ? Math.min(targetHeight * 2 ** levels / height, 1) : 1;
	const luminanceHeight = Math.max(1, Math.floor(height * scale));
	const sizes = bloomDownsampleSizes(1, luminanceHeight, levels);
	return {
		levels,
		scale,
		targetHeight,
		luminanceHeight,
		coarsestHeight: sizes.length > 0 ? sizes[sizes.length - 1][1] : luminanceHeight
	};

}

// ---------------------------------------------------------------------------------------------------------------------
// TSL helpers
// ---------------------------------------------------------------------------------------------------------------------

const F = (value) => T.float(value);
const V2 = (x, y) => T.vec2(x, y);
const V3 = (x, y, z) => T.vec3(x, y, z);
const V4 = (x, y, z, w) => T.vec4(x, y, z, w);
const REC709_LUMA = V3(0.2126, 0.7152, 0.0722);
const REC2020_LUMA = V3(REC2020_LUMINANCE[0], REC2020_LUMINANCE[1], REC2020_LUMINANCE[2]);

const vec3Dot = (value, row) => T.dot(value, V3(row[0], row[1], row[2]));

/** Samples a logical UV and applies an integer texel offset in logical coordinates. */
export const sampleLogicalOffset = (source, uv, x, y) =>
	T.texture(source, V2(uv.x, F(1).sub(uv.y))).offset(T.ivec2(T.int(x), T.int(-y))).level(F(0));

export const srgbEncodeNode = (value) => T.mix(
	value.mul(12.92),
	value.max(0).pow(F(1 / 2.4)).mul(1.055).sub(0.055),
	T.step(V3(0.0031308, 0.0031308, 0.0031308), value)
);

export const srgbDecodeNode = (value) => T.mix(
	value.div(12.92),
	value.add(0.055).div(1.055).max(0).pow(F(2.4)),
	T.step(V3(0.04045, 0.04045, 0.04045), value)
);

/** Internal sRGB8 round-trip used only on the SMAA path, matching the reference's intermediate sRGB target. */
export const quantizeSRGB8Node = (value) => srgbDecodeNode(
	srgbEncodeNode(value.clamp(0, 1)).mul(255).add(0.5).floor().div(255)
);

// ---------------------------------------------------------------------------------------------------------------------
// Bloom shaders
// ---------------------------------------------------------------------------------------------------------------------

const boundsMask = (bounds, uv, padding) => {

	const outside = T.or(
		T.any(uv.lessThan(V2(bounds.x, bounds.y).sub(padding))),
		T.any(uv.greaterThan(V2(bounds.z, bounds.w).add(padding)))
	);
	return T.select(outside, F(0), F(1));

};

export const createLuminanceNode = ({
	source, threshold, smoothing, bounds, padding = null
}) => T.Fn(() => {

	const uv = logicalUV;
	const texel = sampleLogical(source, uv);
	const luma = T.dot(texel.rgb, REC709_LUMA);
	const mask = T.smoothstep(threshold, threshold.add(smoothing), luma);
	const color = texel.mul(mask);
	if(padding === null) return color;
	const inside = boundsMask(bounds, uv, padding);
	return color.mul(inside);

})();

export const createDownsampleNode = ({
	source, sourceTexel, bounds, padding = null, clampToBorder = null
}) => T.Fn(() => {

	const uv = logicalUV;
	const sample = (dx, dy) => {

		const sampleUV = uv.add(sourceTexel.mul(V2(dx, dy)));
		const sampled = sampleLogical(source, sampleUV);
		if(clampToBorder === null) return sampled;
		const inside = T.and(
			sampleUV.x.greaterThanEqual(0), sampleUV.x.lessThanEqual(1),
			sampleUV.y.greaterThanEqual(0), sampleUV.y.lessThanEqual(1)
		);
		const bordered = T.select(inside, sampled, V4(0, 0, 0, 0));
		return T.select(clampToBorder.greaterThan(0.5), bordered, sampled);

	};

	let color = sample(0, 0).mul(BLOOM_DOWNSAMPLE_WEIGHTS.outer);
	color = color.add(sample(-1, 1).mul(BLOOM_DOWNSAMPLE_WEIGHTS.inner));
	color = color.add(sample(1, 1).mul(BLOOM_DOWNSAMPLE_WEIGHTS.inner));
	color = color.add(sample(-1, -1).mul(BLOOM_DOWNSAMPLE_WEIGHTS.inner));
	color = color.add(sample(1, -1).mul(BLOOM_DOWNSAMPLE_WEIGHTS.inner));
	color = color.add(sample(-2, 2).mul(BLOOM_DOWNSAMPLE_WEIGHTS.outer));
	color = color.add(sample(0, 2).mul(BLOOM_DOWNSAMPLE_WEIGHTS.outer));
	color = color.add(sample(2, 2).mul(BLOOM_DOWNSAMPLE_WEIGHTS.outer));
	color = color.add(sample(-2, 0).mul(BLOOM_DOWNSAMPLE_WEIGHTS.outer));
	color = color.add(sample(2, 0).mul(BLOOM_DOWNSAMPLE_WEIGHTS.outer));
	color = color.add(sample(-2, -2).mul(BLOOM_DOWNSAMPLE_WEIGHTS.outer));
	color = color.add(sample(0, -2).mul(BLOOM_DOWNSAMPLE_WEIGHTS.outer));
	color = color.add(sample(2, -2).mul(BLOOM_DOWNSAMPLE_WEIGHTS.outer));
	if(padding === null) return color;
	return color.mul(boundsMask(bounds, uv, padding));

})();

export const createUpsampleNode = ({
	source, support, radius, sourceTexel
}) => T.Fn(() => {

	const uv = logicalUV;
	const sample = (dx, dy) => sampleLogical(source, uv.add(sourceTexel.mul(V2(dx, dy))));
	let color = sample(0, 0).mul(BLOOM_UPSAMPLE_WEIGHTS.center);
	color = color.add(sample(-1, 1).mul(BLOOM_UPSAMPLE_WEIGHTS.corner));
	color = color.add(sample(0, 1).mul(BLOOM_UPSAMPLE_WEIGHTS.edge));
	color = color.add(sample(1, 1).mul(BLOOM_UPSAMPLE_WEIGHTS.corner));
	color = color.add(sample(-1, 0).mul(BLOOM_UPSAMPLE_WEIGHTS.edge));
	color = color.add(sample(1, 0).mul(BLOOM_UPSAMPLE_WEIGHTS.edge));
	color = color.add(sample(-1, -1).mul(BLOOM_UPSAMPLE_WEIGHTS.corner));
	color = color.add(sample(0, -1).mul(BLOOM_UPSAMPLE_WEIGHTS.edge));
	color = color.add(sample(1, -1).mul(BLOOM_UPSAMPLE_WEIGHTS.corner));
	const base = sampleLogical(support, uv);
	return T.mix(base, color, radius);

})();

// ---------------------------------------------------------------------------------------------------------------------
// GT7 / Reinhard / dithering shaders
// ---------------------------------------------------------------------------------------------------------------------

const gt7InverseEotfNode = T.Fn(([value]) => {

	const ym = value.max(0).mul(F(REFERENCE_LUMINANCE / PQ.peak)).pow(V3(PQ.m1, PQ.m1, PQ.m1));
	return T.exp2(F(PQ.m2).mul(
		T.log2(F(PQ.c1).add(F(PQ.c2).mul(ym))).sub(T.log2(F(1).add(F(PQ.c3).mul(ym))))
	));

});

const gt7EotfNode = T.Fn(([value]) => {

	const np = value.clamp(0, 1).pow(V3(1 / PQ.m2, 1 / PQ.m2, 1 / PQ.m2));
	const l = np.sub(PQ.c1).max(0).div(F(PQ.c2).sub(F(PQ.c3).mul(np)));
	return l.pow(V3(1 / PQ.m1, 1 / PQ.m1, 1 / PQ.m1)).mul(F(PQ.peak / REFERENCE_LUMINANCE));

});

const gt7RgbToICtCpNode = T.Fn(([rgb]) => {

	const lms = V3(
		vec3Dot(rgb, RGB_TO_LMS[0]),
		vec3Dot(rgb, RGB_TO_LMS[1]),
		vec3Dot(rgb, RGB_TO_LMS[2])
	);
	const l = gt7InverseEotfNode(lms);
	return V3(
		vec3Dot(l, LMS_TO_ICTCP[0]),
		vec3Dot(l, LMS_TO_ICTCP[1]),
		vec3Dot(l, LMS_TO_ICTCP[2])
	);

});

const gt7ICtCpToRgbNode = T.Fn(([ictcp]) => {

	const lms = V3(
		vec3Dot(ictcp, ICTCP_TO_LMS[0]),
		vec3Dot(ictcp, ICTCP_TO_LMS[1]),
		vec3Dot(ictcp, ICTCP_TO_LMS[2])
	);
	const eotf = gt7EotfNode(lms);
	const rgb = V3(
		vec3Dot(eotf, LMS_TO_RGB[0]),
		vec3Dot(eotf, LMS_TO_RGB[1]),
		vec3Dot(eotf, LMS_TO_RGB[2])
	);
	return rgb.max(0);

});

const gt7ToneMappingNode = T.Fn(({ rgb, curve, shoulder, blendRatio }) => {

	const midPoint = curve.y;
	const linearSection = curve.z;
	const peak = curve.x;
	const toe = midPoint.mul(rgb.max(0).div(midPoint).pow(V3(curve.w, curve.w, curve.w)));
	const linear = T.mix(toe, rgb, T.smoothstep(F(0), midPoint, rgb));
	const shoulderValue = F(shoulder.x).add(F(shoulder.y).mul(T.exp(rgb.mul(shoulder.z))));
	const skewed = T.mix(linear, shoulderValue, T.step(V3(linearSection, linearSection, linearSection).mul(peak), rgb));

	const ucs = gt7RgbToICtCpNode(rgb);
	const skewedUcs = gt7RgbToICtCpNode(skewed);
	const chromaScale = F(1).sub(T.smoothstep(F(FADE_START), F(FADE_END), ucs.x.div(shoulder.w)));
	const scaled = gt7ICtCpToRgbNode(V3(skewedUcs.x, ucs.y.mul(chromaScale), ucs.z.mul(chromaScale)));
	const sdrCorrection = F(REFERENCE_LUMINANCE / SDR_PAPER_WHITE);
	return T.min(T.mix(skewed, scaled, blendRatio), V3(peak, peak, peak)).mul(sdrCorrection);

});

const gt7GradeNode = T.Fn(({ rgb, exposure, grade, curve, shoulder, blendRatio }) => {

	const rec2020 = V3(
		vec3Dot(rgb, REC709_TO_REC2020[0]),
		vec3Dot(rgb, REC709_TO_REC2020[1]),
		vec3Dot(rgb, REC709_TO_REC2020[2])
	);
	const firstLuminance = T.dot(rec2020, REC2020_LUMA);
	const contrastFactor = T.select(firstLuminance.greaterThan(0),
		firstLuminance.div(MIDDLE_GREY).pow(grade.x.sub(1)), F(1));
	let graded = rec2020.mul(contrastFactor).mul(exposure);

	const luminance = T.dot(graded, REC2020_LUMA);
	const brightest = T.max(graded.x, T.max(graded.y, graded.z));
	const saturation = T.select(brightest.greaterThan(0),
		F(1).sub(T.min(graded.x, T.min(graded.y, graded.z)).div(brightest)), F(0));
	const saturationScale = grade.y.mul(F(1).add(grade.z.mul(F(1).sub(saturation))));
	graded = T.mix(V3(luminance, luminance, luminance), graded, saturationScale).max(0);

	const mapped = gt7ToneMappingNode({ rgb: graded, curve, shoulder, blendRatio });
	const rec709 = V3(
		vec3Dot(mapped, REC2020_TO_REC709[0]),
		vec3Dot(mapped, REC2020_TO_REC709[1]),
		vec3Dot(mapped, REC2020_TO_REC709[2])
	).clamp(0, 1).toVar();

	T.If(grade.w.notEqual(0), () => {

		const v = rec709.pow(V3(1 / 2.2, 1 / 2.2, 1 / 2.2));
		const crushed = T.select(grade.w.greaterThan(0),
			v.sub(grade.w).max(0).div(F(1).sub(grade.w)),
			v.mul(F(1).add(grade.w)).sub(grade.w));
		rec709.assign(crushed.pow(V3(2.2, 2.2, 2.2)));

	});

	return rec709;

});

const reinhardNode = T.Fn(({ rgb, exposure }) => {

	const exposed = rgb.mul(exposure);
	return T.min(exposed.div(V3(1, 1, 1).add(exposed)), V3(1, 1, 1)).max(0);

});

// A 16-way select avoids WGSL's restrictions on indexing a const array with a runtime coordinate.
const bayerValueNode = (pixelX, pixelY) => {

	let value = F(BAYER_MATRIX[0]).toVar();
	for(let i = 0; i < BAYER_MATRIX.length; ++i) {
		const x = i % 4;
		const y = Math.floor(i / 4);
		value.assign(T.select(T.and(pixelX.equal(x), pixelY.equal(y)), F(BAYER_MATRIX[i]), value));
	}
	return value;

};

const ditherNode = T.Fn(({ rgb, resolution, intensity, ditheringType }) => {

	const fragCoord = logicalUV.mul(resolution);
	const noise = randNode(fragCoord);
	const noiseColorShift = V3(0.5 / 255, -0.5 / 255, 0.5 / 255).mul(
		T.mix(F(1), F(-1), noise)
	);
	const noiseColor = rgb.add(noiseColorShift.mul(intensity));

	const pixelX = T.int(fragCoord.x).mod(4);
	const pixelY = T.int(fragCoord.y).mod(4);
	const bayerValue = bayerValueNode(pixelX, pixelY);
	const ordered = rgb.add(bayerValue.sub(0.5).mul(intensity).mul(0.01));

	const luma = T.dot(rgb, REC709_LUMA);
	const lumaNoise = noise.sub(0.5);
	const ditheredLuma = luma.add(lumaNoise.mul(intensity).mul(0.0015));
	// The reference divides by luma, which is undefined at pure black. Keep black defined instead of producing NaN.
	const lumaBased = T.select(luma.greaterThan(0), rgb.mul(ditheredLuma.div(luma)), rgb);

	return T.select(ditheringType.equal(T.int(DitheringType.NOISECOLOR)), noiseColor,
		T.select(ditheringType.equal(T.int(DitheringType.ORDERED)), ordered,
			T.select(ditheringType.equal(T.int(DitheringType.LUMABASED)), lumaBased, rgb)));

});

function randNode(co) {

	return T.fract(T.sin(T.dot(co, V2(12.9898, 78.233))).mul(43758.5453));

}

export const createToneMappingNode = ({
	source,
	bloom,
	bloomIntensity,
	resolution,
	gt7Enabled,
	gt7Exposure,
	gt7Grade,
	gt7Curve,
	gt7Shoulder,
	gt7BlendRatio,
	reinhardEnabled,
	reinhardExposure,
	ditheringEnabled,
	ditheringIntensity,
	ditheringType,
	quantize
}) => T.Fn(() => {

	const uv = logicalUV;
	const inputColor = sampleLogical(source, uv);
	const bloomSample = sampleLogical(bloom, uv);
	// Fused EffectPass bloom + tone mapping: add in HDR before GT7, with AddBlendFunction alpha semantics.
	// TSL's vec4() accepts four components or one vector, never (vec3, float): build all four explicitly.
	const baseRgb = inputColor.rgb.add(bloomSample.rgb.mul(bloomIntensity));
	const base = V4(baseRgb.x, baseRgb.y, baseRgb.z,
		T.max(inputColor.a, bloomSample.a.mul(bloomIntensity))).toVar();
	const color = base.rgb.toVar();

	T.If(gt7Enabled.greaterThan(0.5), () => {

		color.assign(gt7GradeNode({
			rgb: color,
			exposure: gt7Exposure,
			grade: gt7Grade,
			curve: gt7Curve,
			shoulder: gt7Shoulder,
			blendRatio: gt7BlendRatio
		}));

	});

	T.If(reinhardEnabled.greaterThan(0.5), () => {

		color.assign(reinhardNode({ rgb: color, exposure: reinhardExposure }));

	});

	T.If(ditheringEnabled.greaterThan(0.5), () => {

		color.assign(ditherNode({
			rgb: color,
			resolution,
			intensity: ditheringIntensity,
			ditheringType
		}));

	});

	color.assign(T.select(quantize.greaterThan(0.5), quantizeSRGB8Node(color), color));
	return V4(color.x, color.y, color.z, base.a);

})();
