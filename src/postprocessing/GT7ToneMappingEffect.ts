import { Uniform, Vector4 } from "three";
import { Effect } from "postprocessing";

/**
 * Gran Turismo 7 tone mapping (SDR), ported from Polyphony Digital's sample implementation.
 *
 * Yasutomi, Suzuki and Uchimura, "Driving Toward Reality: Physically Based Tone Mapping and Perceptual Fidelity in
 * Gran Turismo 7", SIGGRAPH 2025 Physically Based Shading course. Reference code (MIT, Copyright (c) 2025 Polyphony
 * Digital Inc.): https://blog.selfshadow.com/publications/s2025-shading-course/pdi/supplemental/gt7_tone_mapping.cpp
 *
 * The curve is applied per channel ("skewed" colour, which desaturates bright colours towards white like film), then
 * mixed with a version that keeps the luminance of the skewed colour but the hue and chroma of the input in ICtCp,
 * fading the chroma out only right below the display peak. In GT, 1.0 in the frame buffer is 100 cd/m² and SDR paper
 * white is 250 cd/m², so the curve maps to [0, 2.5] and is scaled back to [0, 1].
 *
 * The operator works in linear Rec.2020: the input (linear Rec.709/sRGB primaries) is converted there and back, and
 * colours outside sRGB are clipped at the end.
 *
 * On top of the reference, the effect exposes the curve (shadow toe and toe length, shoulder start and highlight
 * hardness), the chroma preservation, a grade applied to the scene-linear colour before the curve (contrast,
 * saturation, vibrance) and a black point after it. The defaults are GT7's.
 */

// Frame buffer 1.0 ↔ cd/m², and the SDR paper white GT tone maps to
const REFERENCE_LUMINANCE = 100;
const SDR_PAPER_WHITE = 250;

// The chroma fade
const FADE_START = 0.98;
const FADE_END = 1.16;

// SMPTE ST 2084 (PQ)
const PQ = { m1: 0.1593017578125, m2: 78.84375, c1: 0.8359375, c2: 18.8515625, c3: 18.6875, peak: 10000 };

type RGB = [number, number, number];

/**
 * The parameters of GTToneMappingCurveV2, and the blend between its per-channel and chroma-preserving results.
 */

export interface GT7Parameters {
    /** How the shoulder converges: above 0 it reaches the peak and clips, 0 approaches it, below 0 stays under it. */
    alpha: number;
    /** Where the toe blends into the linear section. */
    midPoint: number;
    /** Where the shoulder starts, as a fraction of the peak. */
    linearSection: number;
    /** The toe exponent: above 1 deepens the shadows. */
    toeStrength: number;
    /** 0: the curve per channel, bright colours burn towards white. 1: the hue and chroma of the input are kept. */
    blendRatio: number;
}

/**
 * The parameters GT7 uses (GT7ToneMapping::initializeParameters).
 */

export const GT7_PARAMETERS: Readonly<GT7Parameters> = {
    alpha: 0.25, midPoint: 0.538, linearSection: 0.444, toeStrength: 1.28, blendRatio: 0.6
};

export interface GT7Constants {
    /** The display peak in frame buffer units (2.5 for SDR). */
    peak: number;
    /** The shoulder: kA + kB * exp(x * kC). */
    kA: number;
    kB: number;
    kC: number;
    /** The ICtCp intensity of a grey at the peak, where the chroma fade is measured from. */
    targetUcs: number;
}

const smoothStep = (x: number, edge0: number, edge1: number): number => {

    if(x < edge0) return 0;
    if(x > edge1) return 1;
    const t = (x - edge0) / (edge1 - edge0);
    return t * t * (3 - 2 * t);

};

const inverseEotfSt2084 = (v: number): number => {

    const ym = Math.pow(v * REFERENCE_LUMINANCE / PQ.peak, PQ.m1);
    return Math.pow(2, PQ.m2 * (Math.log2(PQ.c1 + PQ.c2 * ym) - Math.log2(1 + PQ.c3 * ym)));

};

const eotfSt2084 = (n: number): number => {

    n = Math.min(Math.max(n, 0), 1);
    const np = Math.pow(n, 1 / PQ.m2);
    const l = Math.max(np - PQ.c1, 0) / (PQ.c2 - PQ.c3 * np);
    return Math.pow(l, 1 / PQ.m1) * PQ.peak / REFERENCE_LUMINANCE;

};

// ITU-T T.302, linear Rec.2020 input
const rgbToICtCp = ([r, g, b]: RGB): RGB => {

    const l = inverseEotfSt2084((r * 1688 + g * 2146 + b * 262) / 4096);
    const m = inverseEotfSt2084((r * 683 + g * 2951 + b * 462) / 4096);
    const s = inverseEotfSt2084((r * 99 + g * 309 + b * 3688) / 4096);
    return [(2048 * l + 2048 * m) / 4096, (6610 * l - 13613 * m + 7003 * s) / 4096, (17933 * l - 17390 * m - 543 * s) / 4096];

};

const iCtCpToRgb = ([i, ct, cp]: RGB): RGB => {

    const l = eotfSt2084(i + 0.00860904 * ct + 0.11103 * cp);
    const m = eotfSt2084(i - 0.00860904 * ct - 0.11103 * cp);
    const s = eotfSt2084(i + 0.560031 * ct - 0.320627 * cp);
    return [
        Math.max(3.43661 * l - 2.50645 * m + 0.0698454 * s, 0),
        Math.max(-0.79133 * l + 1.9836 * m - 0.192271 * s, 0),
        Math.max(-0.0259499 * l - 0.0989137 * m + 1.12486 * s, 0)
    ];

};

/**
 * The constants of GT7's SDR initialization (GT7ToneMapping::initializeAsSDR) for a curve.
 */

export function gt7Constants({ alpha, linearSection }: GT7Parameters = GT7_PARAMETERS): GT7Constants {

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

/**
 * CPU reference of {@link GT7ToneMappingEffect}: tone maps linear Rec.2020 frame buffer values to [0, 1], ready for
 * the sRGB transfer function (GT7ToneMapping::applyToneMapping).
 */

export function gt7ToneMapping(rgb: RGB, parameters: GT7Parameters = GT7_PARAMETERS): RGB {

    const { peak, kA, kB, kC, targetUcs } = gt7Constants(parameters);
    const { midPoint, linearSection, toeStrength, blendRatio } = parameters;
    const curve = (x: number): number => {

        if(x < 0) return 0;
        const weightLinear = smoothStep(x, 0, midPoint);
        if(x < linearSection * peak) {

            return (1 - weightLinear) * midPoint * Math.pow(x / midPoint, toeStrength) + weightLinear * x;

        }

        return kA + kB * Math.exp(x * kC);

    };

    const ucs = rgbToICtCp(rgb);
    const skewed = rgb.map(curve) as RGB;
    const skewedUcs = rgbToICtCp(skewed);
    const chromaScale = 1 - smoothStep(ucs[0] / targetUcs, FADE_START, FADE_END);
    const scaled = iCtCpToRgb([skewedUcs[0], ucs[1] * chromaScale, ucs[2] * chromaScale]);
    const sdrCorrection = REFERENCE_LUMINANCE / SDR_PAPER_WHITE;
    return skewed.map((x, i) => sdrCorrection * Math.min((1 - blendRatio) * x + blendRatio * scaled[i], peak)) as RGB;

}

/**
 * The GLSL operator: `vec3 gt7ToneMapping(vec3 rgb)` on linear Rec.2020, plus the Rec.709 ↔ Rec.2020 matrices.
 * Matrices are written row by row, so they apply as `v * M`.
 */

export const gt7ToneMappingShader = /* glsl */ `
uniform vec4 gt7Curve; // peak, midPoint, linearSection, toeStrength
uniform vec4 gt7Shoulder; // kA, kB, kC, targetUcs
uniform float gt7BlendRatio;

const float GT7_REFERENCE_LUMINANCE = ${REFERENCE_LUMINANCE.toFixed(1)};
const float GT7_SDR_CORRECTION = ${(REFERENCE_LUMINANCE / SDR_PAPER_WHITE).toFixed(1)};
const float GT7_FADE_START = ${FADE_START};
const float GT7_FADE_END = ${FADE_END};

const float PQ_M1 = ${PQ.m1};
const float PQ_M2 = ${PQ.m2};
const float PQ_C1 = ${PQ.c1};
const float PQ_C2 = ${PQ.c2};
const float PQ_C3 = ${PQ.c3};
const float PQ_PEAK = ${PQ.peak.toFixed(1)};

const mat3 REC709_TO_REC2020 = mat3(
	0.6274040, 0.3292820, 0.0433136,
	0.0690970, 0.9195400, 0.0113612,
	0.0163916, 0.0880132, 0.8955950
);

const mat3 REC2020_TO_REC709 = mat3(
	1.6604910, -0.5876411, -0.0728499,
	-0.1245505, 1.1328999, -0.0083494,
	-0.0181508, -0.1005789, 1.1187297
);

const mat3 GT7_RGB_TO_LMS = mat3(
	1688.0, 2146.0, 262.0,
	683.0, 2951.0, 462.0,
	99.0, 309.0, 3688.0
) / 4096.0;

const mat3 GT7_LMS_TO_ICTCP = mat3(
	2048.0, 2048.0, 0.0,
	6610.0, -13613.0, 7003.0,
	17933.0, -17390.0, -543.0
) / 4096.0;

const mat3 GT7_ICTCP_TO_LMS = mat3(
	1.0, 0.00860904, 0.11103,
	1.0, -0.00860904, -0.11103,
	1.0, 0.560031, -0.320627
);

const mat3 GT7_LMS_TO_RGB = mat3(
	3.43661, -2.50645, 0.0698454,
	-0.79133, 1.9836, -0.192271,
	-0.0259499, -0.0989137, 1.12486
);

vec3 gt7InverseEotf(vec3 v) {

	vec3 ym = pow(max(v, 0.0) * (GT7_REFERENCE_LUMINANCE / PQ_PEAK), vec3(PQ_M1));
	return exp2(PQ_M2 * (log2(PQ_C1 + PQ_C2 * ym) - log2(1.0 + PQ_C3 * ym)));

}

vec3 gt7Eotf(vec3 n) {

	vec3 np = pow(clamp(n, 0.0, 1.0), vec3(1.0 / PQ_M2));
	vec3 l = max(np - PQ_C1, 0.0) / (PQ_C2 - PQ_C3 * np);
	return pow(l, vec3(1.0 / PQ_M1)) * (PQ_PEAK / GT7_REFERENCE_LUMINANCE);

}

vec3 gt7RgbToICtCp(vec3 rgb) {

	return gt7InverseEotf(rgb * GT7_RGB_TO_LMS) * GT7_LMS_TO_ICTCP;

}

vec3 gt7ICtCpToRgb(vec3 ictcp) {

	return max(gt7Eotf(ictcp * GT7_ICTCP_TO_LMS) * GT7_LMS_TO_RGB, 0.0);

}

// GTToneMappingCurveV2: toe blending into a linear section, then a shoulder converging to the peak
vec3 gt7ApplyCurve(vec3 x) {

	float peak = gt7Curve.x, midPoint = gt7Curve.y;
	x = max(x, 0.0);
	vec3 toe = midPoint * pow(x / midPoint, vec3(gt7Curve.w));
	vec3 linear = mix(toe, x, smoothstep(0.0, midPoint, x));
	vec3 shoulder = gt7Shoulder.x + gt7Shoulder.y * exp(x * gt7Shoulder.z);
	return mix(linear, shoulder, step(gt7Curve.z * peak, x));

}

vec3 gt7ToneMapping(vec3 rgb) {

	vec3 ucs = gt7RgbToICtCp(rgb);
	vec3 skewed = gt7ApplyCurve(rgb);
	vec3 skewedUcs = gt7RgbToICtCp(skewed);
	float chromaScale = 1.0 - smoothstep(GT7_FADE_START, GT7_FADE_END, ucs.x / gt7Shoulder.w);
	vec3 scaled = gt7ICtCpToRgb(vec3(skewedUcs.x, ucs.yz * chromaScale));
	return GT7_SDR_CORRECTION * min(mix(skewed, scaled, gt7BlendRatio), gt7Curve.x);

}
`;

const fragmentShader = /* glsl */ `
${gt7ToneMappingShader}

uniform float exposure;
uniform vec4 grade; // contrast, saturation, vibrance, black point

const vec3 REC2020_LUMINANCE = vec3(0.2627, 0.6780, 0.0593);
const float MIDDLE_GREY = 0.18;

vec4 mainImage(const in vec4 inputColor, const in vec2 uv, const in GData gData) {

	vec3 rgb = inputColor.rgb * REC709_TO_REC2020;

	// Contrast: a power curve on the luminance around the scene's middle grey, before the exposure moves it. The hue
	// and saturation stay.
	float luminance = dot(rgb, REC2020_LUMINANCE);
	rgb *= luminance > 0.0 ? pow(luminance / MIDDLE_GREY, grade.x - 1.0) : 1.0;
	rgb *= exposure;

	// Saturation, and vibrance: extra saturation that fades out as the colour gets saturated already
	luminance = dot(rgb, REC2020_LUMINANCE);
	float brightest = max(rgb.r, max(rgb.g, rgb.b));
	float saturation = brightest > 0.0 ? 1.0 - min(rgb.r, min(rgb.g, rgb.b)) / brightest : 0.0;
	rgb = max(mix(vec3(luminance), rgb, grade.y * (1.0 + grade.z * (1.0 - saturation))), 0.0);

	rgb = clamp(gt7ToneMapping(rgb) * REC2020_TO_REC709, 0.0, 1.0);

	// Black point, on a gamma 2.2 scale so that it acts evenly on what the eye sees as shadows: above 0 crushes the
	// darkest values to black, below 0 lifts black to a grey like faded film
	if(grade.w != 0.0) {

		vec3 v = pow(rgb, vec3(1.0 / 2.2));
		v = grade.w > 0.0 ? max(v - grade.w, 0.0) / (1.0 - grade.w) : mix(vec3(-grade.w), vec3(1.0), v);
		rgb = pow(v, vec3(2.2));

	}

	return vec4(rgb, inputColor.a);

}
`;

/**
 * GT7ToneMappingEffect options.
 */

export interface GT7ToneMappingEffectOptions {

    /**
     * Scales the linear input before the curve. In GT's convention 1.0 is 100 cd/m² and SDR white 250 cd/m².
     *
     * @defaultValue 1.0
     */

    exposure?: number;

    /**
     * Contrast around middle grey, applied to the scene-linear luminance before the curve. Pushes highlights up and
     * shadows down above 1.
     *
     * @defaultValue 1.0
     */

    contrast?: number;

    /**
     * Saturation before the curve: 0 is greyscale.
     *
     * @defaultValue 1.0
     */

    saturation?: number;

    /**
     * Saturation added to muted colours only, fading out as they get saturated. Negative mutes them.
     *
     * @defaultValue 0.0
     */

    vibrance?: number;

    /**
     * The black point, on a gamma 2.2 scale of the output: above 0 crushes everything darker than it to black and
     * stretches the rest, below 0 lifts black to that grey.
     *
     * @defaultValue 0.0
     */

    blackPoint?: number;

    /**
     * How far up the shadows the toe reaches, in the curve's linear units (its mid point). Higher spreads the shadow
     * curve over more of the darks and midtones.
     *
     * @defaultValue 0.538
     */

    toeLength?: number;

    /**
     * How much bright colours keep their hue and saturation (the blend ratio): 0 runs the curve per channel, so they
     * burn towards white like film; 1 keeps them saturated until right below white.
     *
     * @defaultValue 0.6
     */

    chromaPreservation?: number;

    /**
     * How the highlights reach white (the curve's alpha). GT7's 0.25 reaches white at about 3.3× the brightness where
     * the shoulder starts and clips everything brighter; 0 rolls off towards white without ever clipping, keeping
     * highlight detail like Reinhard; below 0 stays further under white. Must stay below 1.
     *
     * @defaultValue 0.25
     */

    highlightHardness?: number;

    /**
     * Where the highlight roll-off starts, as a fraction of white (the curve's linear section). Lower starts
     * compressing earlier, leaving more room for highlight detail but flattening the bright midtones.
     *
     * @defaultValue 0.444
     */

    shoulderStart?: number;

    /**
     * The toe exponent: above 1 deepens the shadows, 1 leaves them linear.
     *
     * @defaultValue 1.28
     */

    shadowToe?: number;

}

/**
 * Gran Turismo 7 tone mapping, see the module comment. Outputs linear sRGB in [0, 1], like `ToneMappingEffect`.
 */

export class GT7ToneMappingEffect extends Effect {

    private readonly parameters: GT7Parameters = { ...GT7_PARAMETERS };
    private readonly curveUniform = new Uniform(new Vector4());
    private readonly shoulderUniform = new Uniform(new Vector4());
    private readonly blendRatioUniform = new Uniform(0);
    private readonly gradeUniform = new Uniform(new Vector4());

    constructor({
        exposure = 1,
        contrast = 1,
        saturation = 1,
        vibrance = 0,
        blackPoint = 0,
        shadowToe = GT7_PARAMETERS.toeStrength,
        toeLength = GT7_PARAMETERS.midPoint,
        shoulderStart = GT7_PARAMETERS.linearSection,
        highlightHardness = GT7_PARAMETERS.alpha,
        chromaPreservation = GT7_PARAMETERS.blendRatio
    }: GT7ToneMappingEffectOptions = {}) {

        super("GT7ToneMappingEffect");

        this.fragmentShader = fragmentShader;

        const uniforms = this.input.uniforms;
        uniforms.set("exposure", new Uniform(exposure));
        uniforms.set("grade", this.gradeUniform);
        uniforms.set("gt7Curve", this.curveUniform);
        uniforms.set("gt7Shoulder", this.shoulderUniform);
        uniforms.set("gt7BlendRatio", this.blendRatioUniform);

        this.gradeUniform.value.set(contrast, saturation, vibrance, blackPoint);
        Object.assign(this.parameters, {
            alpha: highlightHardness, midPoint: toeLength, linearSection: shoulderStart, toeStrength: shadowToe,
            blendRatio: chromaPreservation
        });
        this.updateCurve();

    }

    /**
     * The operator's parameters, see {@link GT7Parameters}.
     */

    get curve(): Readonly<GT7Parameters> {

        return this.parameters;

    }

    private updateCurve(): void {

        const curve = this.parameters;
        // alpha = 1 and linearSection = 1 divide by zero. The toe must end before the shoulder starts, or the curve jumps.
        curve.alpha = Math.min(curve.alpha, 0.95);
        curve.linearSection = Math.min(Math.max(curve.linearSection, 0.05), 0.95);
        const { peak, kA, kB, kC, targetUcs } = gt7Constants(curve);
        curve.midPoint = Math.min(Math.max(curve.midPoint, 0.01), curve.linearSection * peak);
        curve.blendRatio = Math.min(Math.max(curve.blendRatio, 0), 1);
        this.curveUniform.value.set(peak, curve.midPoint, curve.linearSection, curve.toeStrength);
        this.shoulderUniform.value.set(kA, kB, kC, targetUcs);
        this.blendRatioUniform.value = curve.blendRatio;

    }

    /** @see {@link GT7ToneMappingEffectOptions.exposure} */
    get exposure(): number {

        return this.input.uniforms.get("exposure")!.value as number;

    }

    set exposure(value: number) {

        this.input.uniforms.get("exposure")!.value = value;

    }

    /** @see {@link GT7ToneMappingEffectOptions.contrast} */
    get contrast(): number {

        return this.gradeUniform.value.x;

    }

    set contrast(value: number) {

        this.gradeUniform.value.x = value;

    }

    /** @see {@link GT7ToneMappingEffectOptions.saturation} */
    get saturation(): number {

        return this.gradeUniform.value.y;

    }

    set saturation(value: number) {

        this.gradeUniform.value.y = value;

    }

    /** @see {@link GT7ToneMappingEffectOptions.vibrance} */
    get vibrance(): number {

        return this.gradeUniform.value.z;

    }

    set vibrance(value: number) {

        this.gradeUniform.value.z = value;

    }

    /** @see {@link GT7ToneMappingEffectOptions.highlightHardness} */
    get highlightHardness(): number {

        return this.parameters.alpha;

    }

    set highlightHardness(value: number) {

        this.parameters.alpha = value;
        this.updateCurve();

    }

    /** @see {@link GT7ToneMappingEffectOptions.shoulderStart} */
    get shoulderStart(): number {

        return this.parameters.linearSection;

    }

    set shoulderStart(value: number) {

        this.parameters.linearSection = value;
        this.updateCurve();

    }

    /** @see {@link GT7ToneMappingEffectOptions.shadowToe} */
    get shadowToe(): number {

        return this.parameters.toeStrength;

    }

    set shadowToe(value: number) {

        this.parameters.toeStrength = value;
        this.updateCurve();

    }

    /** @see {@link GT7ToneMappingEffectOptions.blackPoint} */
    get blackPoint(): number {

        return this.gradeUniform.value.w;

    }

    set blackPoint(value: number) {

        this.gradeUniform.value.w = value;

    }

    /** @see {@link GT7ToneMappingEffectOptions.toeLength} */
    get toeLength(): number {

        return this.parameters.midPoint;

    }

    set toeLength(value: number) {

        this.parameters.midPoint = value;
        this.updateCurve();

    }

    /** @see {@link GT7ToneMappingEffectOptions.chromaPreservation} */
    get chromaPreservation(): number {

        return this.parameters.blendRatio;

    }

    set chromaPreservation(value: number) {

        this.parameters.blendRatio = value;
        this.updateCurve();

    }

}
