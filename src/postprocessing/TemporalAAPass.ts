import {
    Box3,
    Color,
    DataTexture,
    HalfFloatType,
    Matrix4,
    NearestFilter,
    Object3D,
    PerspectiveCamera,
    RGBAFormat,
    RGBFormat,
    Texture,
    Uniform,
    Vector2,
    Vector4,
    WebGLRenderTarget
} from "three";
import { FullscreenMaterial, GBuffer, Pass } from "postprocessing";
import { TemporalAABounds } from "./TemporalAABounds.js";
import { VELOCITY, VelocityBuffer } from "./VelocityBuffer.js";

/**
 * Temporal antialiasing.
 *
 * The camera projection is jittered by a sub-pixel Halton sequence and each frame is blended into a history buffer.
 * Combined with 4x MSAA this accumulates dozens of samples per pixel, which smooths thin sub-pixel features that MSAA
 * alone quantizes into steps.
 *
 * Reprojection doesn't need a velocity buffer: the scene is a single rigid object (see {@link trackedObject}) in front
 * of a static background. The world position of a pixel is reconstructed from depth and moved by the object's rigid
 * motion since the previous frame.
 *
 * The current frame is reconstructed with a Gaussian filter weighted by where each jittered sample landed, so the
 * history converges to a smooth filter rather than the box filter of a pixel, which leaves faint steps on thin
 * near-horizontal lines even with infinite samples.
 *
 * History is clamped to the current neighbourhood (variance clipping in YCoCg) and blended in the same
 * Reinhard-encoded space as the tonemapped MSAA resolve, so HDR highlights don't dominate the clamp.
 *
 * While nothing moves, the history is exact, so it becomes a running average over all jitter positions (down to
 * {@link staticBlend}) without clipping. Otherwise thin edges flicker with the jitter cycle in still frames: a fixed
 * blend weights the latest few jitter positions, and the clip resets the history towards the current one.
 *
 * The lookup deliberately stays on the same pixel instead of compensating the jitter offset between frames
 * ({@link jitterCompensation}): that is what averages the jitter positions, so still frames converge to the smooth
 * image. Compensating instead tracks the surface sub-pixel by sub-pixel, which leaves the jitter visible in still
 * frames and only pays off with a much lower {@link jitterScale}.
 *
 * In motion, the contrast clamp is what turns thin bright edges back into steps: a sub-pixel line is missed by some
 * jitter positions, and the clamp then erases it from the history. The opt-in options attack that from several sides:
 * a 3x3 neighbourhood, clipping towards the current colour, depth validation of the history so that only disoccluded
 * pixels get the tight clamp, thin feature locks, lower blend on edges and per-frame sample confidence. See
 * {@link TemporalAAPassOptions}.
 *
 * @see https://de45xmedrsdbp.cloudfront.net/Resources/files/TemporalAA_small-59732822.pdf
 * @see http://behindthepixels.io/assets/files/TemporalAA.pdf
 * @see https://github.com/playdeadgames/temporal
 */

const fragmentShader = /* glsl */ `
#include <pp_default_output_pars_fragment>
#include <pp_input_buffer_pars_fragment>

// The pass output, written along with the history. See TemporalAAPass.history.
layout(location = 1) out mediump vec4 out_Output;

// Per-pixel state carried along with the history: x is the view depth of the surface, 0 for the background, y is the
// thin feature lock, zw is the screen motion of the pixel since the previous frame in pixels, for the motion blur. See
// TemporalAAPass.history.
layout(location = 2) out highp vec4 out_State;

uniform highp sampler2D depthBuffer;
uniform highp sampler2D velocityBuffer;
uniform bool useVelocityBuffer;
uniform sampler2D historyBuffer;
uniform highp sampler2D stateBuffer;

uniform mat4 inverseViewProjectionJittered;
uniform mat4 viewProjection;
uniform mat4 previousViewProjection;
uniform mat4 objectMotion;

uniform vec2 texelSize;
uniform vec2 jitterOffset;
uniform vec2 previousJitter;
uniform vec4 backgroundBounds;
uniform float exposure;
uniform float blend;
uniform float varianceGamma;
uniform bool historyValid;
uniform bool clipHistory;
uniform bool moving;
uniform float filterSharpness;
uniform float motionFilterSharpness;
uniform float motionFilterScale;
uniform float jitterCompensation;

uniform int neighbourCount;
uniform int boxMode;
uniform bool clipTowardsCurrent;
uniform bool depthRejection;
uniform float depthTolerance;
uniform bool motionRejection;
uniform float motionTolerance;
uniform float trustedGamma;
uniform float disocclusionBlend;
uniform bool thinFeatureLocks;
uniform float lockStep;
uniform float lockMaxSpeed;
uniform float lockSimilarity;
uniform float lockStrength;
uniform bool edgeAdaptiveBlend;
uniform float edgeBlend;
uniform bool sampleConfidence;
uniform highp sampler2D reactiveMask;
uniform float reactiveStrength;
uniform int debugView;

in vec2 vUv;

vec3 encode(vec3 c) {

	c = max(c, 0.0) * exposure;
	return c / (1.0 + c);

}

vec3 decode(vec3 e) {

	e = min(e, vec3(0.9995));
	return e / (exposure * (1.0 - e));

}

vec3 RGBToYCoCg(vec3 c) {

	return vec3(
		0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
		0.5 * c.r - 0.5 * c.b,
		-0.25 * c.r + 0.5 * c.g - 0.25 * c.b
	);

}

vec3 YCoCgToRGB(vec3 c) {

	return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);

}

// Encoded YCoCg colour of the current frame at a texel offset.
vec3 sampleCurrent(ivec2 offset) {

	ivec2 maxCoord = textureSize(inputBuffer, 0) - 1;
	ivec2 coord = clamp(ivec2(gl_FragCoord.xy) + offset, ivec2(0), maxCoord);
	return RGBToYCoCg(encode(texelFetch(inputBuffer, coord, 0).rgb));

}

// 5-tap Catmull-Rom. Bilinear history blurs a little more every frame while the model rotates.
vec3 sampleHistory(vec2 uv) {

	vec2 texSize = 1.0 / texelSize;
	vec2 samplePos = uv * texSize;
	vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
	vec2 f = samplePos - texPos1;

	vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
	vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
	vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
	vec2 w3 = f * f * (-0.5 + 0.5 * f);

	vec2 w12 = w1 + w2;
	vec2 texPos0 = (texPos1 - 1.0) * texelSize;
	vec2 texPos3 = (texPos1 + 2.0) * texelSize;
	vec2 texPos12 = (texPos1 + w2 / w12) * texelSize;

	vec3 result = texture(historyBuffer, vec2(texPos12.x, texPos0.y)).rgb * w12.x * w0.y;
	result += texture(historyBuffer, vec2(texPos0.x, texPos12.y)).rgb * w0.x * w12.y;
	result += texture(historyBuffer, texPos12).rgb * w12.x * w12.y;
	result += texture(historyBuffer, vec2(texPos3.x, texPos12.y)).rgb * w3.x * w12.y;
	result += texture(historyBuffer, vec2(texPos12.x, texPos3.y)).rgb * w12.x * w3.y;

	float weight = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
	return max(result / weight, 0.0);

}

// Moves q towards the centre of the box until it lies inside.
vec3 clipToBox(vec3 boxMin, vec3 boxMax, vec3 q) {

	vec3 center = 0.5 * (boxMax + boxMin);
	vec3 extents = 0.5 * (boxMax - boxMin) + 1e-6;
	vec3 v = q - center;
	vec3 a = abs(v / extents);
	float m = max(a.x, max(a.y, a.z));
	return m > 1.0 ? center + v / m : q;

}

// Moves q along the segment towards the current colour until it lies inside the box (Pedersen 2016). Unlike the box
// centre, the current colour is what the pixel actually shows, so the clipped history keeps its hue and stays on the
// right side of an edge.
vec3 clipTowards(vec3 boxMin, vec3 boxMax, vec3 target, vec3 q) {

	target = clamp(target, boxMin, boxMax);
	vec3 r = q - target;
	vec3 rMax = boxMax - target;
	vec3 rMin = boxMin - target;
	const float EPSILON = 1e-7;

	if(r.x > rMax.x + EPSILON) r *= rMax.x / r.x;
	if(r.y > rMax.y + EPSILON) r *= rMax.y / r.y;
	if(r.z > rMax.z + EPSILON) r *= rMax.z / r.z;
	if(r.x < rMin.x - EPSILON) r *= rMin.x / r.x;
	if(r.y < rMin.y - EPSILON) r *= rMin.y / r.y;
	if(r.z < rMin.z - EPSILON) r *= rMin.z / r.z;

	return target + r;

}

// Where the surface seen at uv was on screen in the previous frame (xy), its view depth then (z) and now (w). The depths
// are 0 for the background.
vec4 reproject(vec2 uv, float depth) {

	if(depth >= 1.0) {

		// Background, static
		return vec4(uv, 0.0, 0.0);

	}

	vec4 world = inverseViewProjectionJittered * vec4(vec3(uv, depth) * 2.0 - 1.0, 1.0);
	world /= world.w;

	vec4 current = viewProjection * world;

	if(useVelocityBuffer) {

		// Per-object motion and depth change from the geometry pass, see VelocityBuffer
		vec4 velocity = texture(velocityBuffer, uv);
		return vec4(uv - velocity.xy, current.w * (1.0 + velocity.z), current.w);

	}

	vec4 previous = previousViewProjection * (objectMotion * world);
	vec2 velocity = (current.xy / current.w - previous.xy / previous.w) * 0.5;

	// For a perspective projection, clip w is the view depth
	return vec4(uv - velocity, previous.w, current.w);

}

// Ratio of two encoded lumas. Small absolute differences count as alike too, so that the faint gradients of near black
// (glass over the background, bloom-free falloff) don't lock and keep their history as trails.
bool similar(float a, float b) {

	return abs(a - b) < 0.06 || min(a, b) / max(a, b) >= lockSimilarity;

}

// Centre, the 4 direct neighbours, then the 4 diagonals. neighbourCount selects the cross (5) or the full 3x3 (9).
const ivec2 NEIGHBOURS[9] = ivec2[9](
	ivec2(0, 0), ivec2(-1, 0), ivec2(1, 0), ivec2(0, -1), ivec2(0, 1),
	ivec2(-1, -1), ivec2(1, -1), ivec2(-1, 1), ivec2(1, 1)
);

void main() {

	// The viewer is one bounded rigid object against black, before bloom. Outside its padded history footprint
	// there has never been a signal to reconstruct. Write ALL attachments so stale history cannot return later.
	if(any(lessThan(vUv, backgroundBounds.xy)) || any(greaterThan(vUv, backgroundBounds.zw))) {

		out_Color = vec4(0.0, 0.0, 0.0, 1.0);
		out_Output = out_Color;
		out_State = vec4(0.0);
		return;

	}

	// Velocity of the closest surface in the neighbourhood. The MSAA depth resolve keeps a single sample, so the depth
	// of a sub-pixel edge is often the background's: without this, thin edges would lag behind as static.
	vec2 closestUv = vUv;
	float closestDepth = 1.0;

	for(int i = 0; i < neighbourCount; ++i) {

		vec2 uv = vUv + vec2(NEIGHBOURS[i]) * texelSize;
		float d = texture(depthBuffer, uv).r;

		if(d < closestDepth) {

			closestDepth = d;
			closestUv = uv;

		}

	}

	vec4 motionData = reproject(closestUv, closestDepth);
	vec2 historyUv = vUv + (motionData.xy - closestUv);

	// The motion this pixel is reprojected with, in pixels. Stored for the motion blur and the motion validation below.
	vec2 velocity = (closestUv - motionData.xy) / texelSize;

	// The history holds a jittered image: the texel that contains this surface in the previous frame is offset by the
	// difference between the two jitter positions. Without it the lookup lands up to two pixels off and the contrast
	// clamp throws the history away, which is exactly what leaves the jitter pattern visible while the camera moves.
	historyUv += jitterCompensation * (jitterOffset - previousJitter) * texelSize;

	// Reprojection velocity in pixels, used to widen the reconstruction filter while the history is unreliable.
	float motion = length((historyUv - vUv) / texelSize);
	float sharpness = mix(filterSharpness, motionFilterSharpness, clamp(motion * motionFilterScale, 0.0, 1.0));

	vec3 samples[9];
	vec3 m1 = vec3(0.0);
	vec3 m2 = vec3(0.0);
	vec3 minColor = vec3(1e9);
	vec3 maxColor = vec3(-1e9);
	vec3 filtered = vec3(0.0);
	float filterWeight = 0.0;
	float lumaMin = 1e9;
	float lumaMax = -1e9;

	// All 9 are fetched: the thin feature test and the edge contrast always look at the full 3x3
	for(int i = 0; i < 9; ++i) {

		vec3 c = sampleCurrent(NEIGHBOURS[i]);
		samples[i] = c;
		lumaMin = min(lumaMin, c.x);
		lumaMax = max(lumaMax, c.x);

		if(i >= neighbourCount) {

			continue;

		}

		m1 += c;
		m2 += c * c;
		minColor = min(minColor, c);
		maxColor = max(maxColor, c);

		// Reconstruct the pixel from the jittered samples around it, weighted by their distance to the pixel centre.
		// Without it, the history converges to a box filter, which leaves faint steps on thin near-horizontal lines.
		// Gaussian, as in Karis 2014. See filterSharpness.
		vec2 d = vec2(NEIGHBOURS[i]) + jitterOffset;
		float w = exp(-sharpness * dot(d, d));
		filtered += c * w;
		filterWeight += w;

	}

	vec3 current = filtered / filterWeight;
	float currentDepth = motionData.w;

	// Glass and other transparent surfaces (FSR 2 "reactive mask"): their reflections and scratches move on their own,
	// and the depth behind them says nothing about them. See TonemappedResolvePass.reactiveMask.
	float reactive = 0.0;

	if(reactiveStrength > 0.0) {

		ivec2 coord = min(ivec2(gl_FragCoord.xy), textureSize(reactiveMask, 0) - 1);
		reactive = reactiveStrength * texelFetch(reactiveMask, coord, 0).r;

	}

	// Thin feature: no 2x2 quad around the pixel looks like it (FSR 2). A sub-pixel line touches every quad it crosses
	// with a different colour on at least one side, a solid area or a wide edge doesn't. The contrast floor keeps
	// gradients and noise in dark areas from locking.
	float thin = 0.0;

	if(thinFeatureLocks) {

		float y = samples[0].x;
		bool quad0 = similar(y, samples[1].x) && similar(y, samples[3].x) && similar(y, samples[5].x);
		bool quad1 = similar(y, samples[2].x) && similar(y, samples[3].x) && similar(y, samples[6].x);
		bool quad2 = similar(y, samples[1].x) && similar(y, samples[4].x) && similar(y, samples[7].x);
		bool quad3 = similar(y, samples[2].x) && similar(y, samples[4].x) && similar(y, samples[8].x);
		thin = (!(quad0 || quad1 || quad2 || quad3) && lumaMax - lumaMin > 0.05) ? 1.0 : 0.0;

	}

	bool offscreen = any(lessThan(historyUv, vec2(0.0))) || any(greaterThan(historyUv, vec2(1.0)));

	if(!historyValid || offscreen) {

		out_Color = vec4(decode(YCoCgToRGB(current)), 1.0);
		out_Output = out_Color;
		out_State = vec4(currentDepth, thin * (1.0 - reactive), velocity);
		return;

	}

	// Geometric validation (Nehab et al. 2007): the reprojection is exact, so whether the history texel held this same
	// surface is a reliable, per-pixel answer, unlike the colour clamp. Only the texel the lookup lands in counts:
	// accepting any of its neighbours lets the pixels right behind a moving part pass on the strength of print uncovered
	// a frame earlier, and the relaxed clamp then leaves a copy of the part's edge behind every frame. Silhouettes don't
	// need the leniency, the stored depth is dilated by a pixel in both frames.
	ivec2 stateSize = textureSize(stateBuffer, 0);
	vec4 state = texelFetch(stateBuffer, clamp(ivec2(historyUv * vec2(stateSize)), ivec2(0), stateSize - 1), 0);
	float match = 1.0;

	if(depthRejection) {

		float expected = motionData.z;
		bool same = expected > 0.0 ? abs(state.x - expected) <= depthTolerance * expected : state.x == 0.0;
		match = same ? 1.0 : 0.0;

	}

	// Motion validation (motion vector divergence, as in FSR 2 and TSR): a surface's own motion barely changes from one
	// frame to the next, so history that moved very differently belongs to something else. It catches what depth can't:
	// a thin part lying flush on another, e.g. a clip on the back plate, less than a millimetre apart, slides off and
	// the plate it uncovers would otherwise keep the clip's history.
	if(motionRejection) {

		float divergence = length(velocity - state.zw);
		match = divergence <= motionTolerance + 0.25 * length(velocity) ? match : 0.0;

	}

	// Locks follow the surface and fade linearly over lockFrames, so they end instead of leaving a long faint tail. A
	// disocclusion drops them: it's another surface. So does glass: whatever is thin there moves on its own.
	float lock = thin;

	if(thinFeatureLocks && match > 0.0) {

		lock = max(state.y - lockStep, thin);

	}

	lock *= 1.0 - reactive;

	// Fast motion: whatever a lock keeps is visibly out of date, and the motion blur hides the steps anyway
	float speedFade = lockMaxSpeed > 0.0 ? 1.0 - smoothstep(0.5 * lockMaxSpeed, lockMaxSpeed, motion) : 1.0;
	float lockWeight = lock * lockStrength * match * speedFade;

	// The background has no depth to validate against: the glass doesn't write depth, so a "background" pixel can be
	// covered by moving glass. Only matched surfaces get the relaxed clamp.
	bool trusted = depthRejection && currentDepth > 0.0 && match > 0.0;
	float gamma = trusted ? mix(trustedGamma, varianceGamma, reactive) : varianceGamma;

	float n = float(neighbourCount);
	vec3 mean = m1 / n;
	vec3 sigma = sqrt(max(m2 / n - mean * mean, 0.0)) * gamma;
	vec3 boxMin = mean - sigma;
	vec3 boxMax = mean + sigma;

	if(boxMode == 1) {

		// Min/max, scaled around its centre so that the trusted width still applies
		vec3 center = 0.5 * (maxColor + minColor);
		vec3 extents = 0.5 * (maxColor - minColor) * gamma;
		boxMin = center - extents;
		boxMax = center + extents;

	} else if(boxMode == 2) {

		// Variance clipping can reach past the colours actually present, the intersection can't (Salvi 2016)
		boxMin = max(boxMin, minColor);
		boxMax = min(boxMax, maxColor);

	}

	vec3 rawHistory = RGBToYCoCg(encode(sampleHistory(historyUv)));
	vec3 history = rawHistory;

	if(clipHistory) {

		history = clipTowardsCurrent ? clipTowards(boxMin, boxMax, current, rawHistory) :
			clipToBox(boxMin, boxMax, rawHistory);

		// A locked thin feature keeps its history even when this frame's samples missed it, which is what the clamp
		// would otherwise turn into a broken, stepped line (Yang et al. 2020, fig. 9).
		history = mix(history, rawHistory, lockWeight);

	}

	float alpha = blend;

	if(moving) {

		if(edgeAdaptiveBlend) {

			// High contrast neighbourhoods accumulate longer (Malan 2012): that's where the jitter shows the most, and
			// a matched surface's history there is valid
			float contrast = smoothstep(0.05, 0.35, lumaMax - lumaMin);
			alpha = mix(alpha, min(alpha, edgeBlend), contrast * match * (1.0 - reactive));

		}

		if(sampleConfidence) {

			// Frames whose sample landed far from the pixel centre count less (UE4, beta = max of the filter weights).
			// Blackman-Harris fit, so the worst jitter position still weighs about a third.
			alpha *= max(exp(-2.29 * dot(jitterOffset, jitterOffset)), 0.25);

		}

		if((depthRejection || motionRejection) && match == 0.0) {

			alpha = max(alpha, disocclusionBlend);

		}

	}

	vec3 result = mix(history, current, alpha);

	out_Color = vec4(decode(YCoCgToRGB(result)), 1.0);
	out_Output = out_Color;
	out_State = vec4(currentDepth, lock, velocity);

	if(debugView == 1) {

		// Effective locks in red. Dim: the output feeds the bloom
		out_Output.rgb = mix(out_Output.rgb, vec3(0.6, 0.0, 0.0), lockWeight * 0.8);

	} else if(debugView == 2 && (currentDepth > 0.0 || match == 0.0)) {

		// Depth validation: trusted surfaces in green, disocclusions in red
		out_Output.rgb = mix(out_Output.rgb, trusted ? vec3(0.0, 0.08, 0.0) : vec3(0.6, 0.0, 0.0), 0.5);

	} else if(debugView == 3) {

		// Reactive mask in blue
		out_Output.rgb = mix(out_Output.rgb, vec3(0.0, 0.05, 0.6), reactive * 0.7);

	} else if(debugView == 4) {

		// Own motion in pixels per frame: red right, green up (negatives as their magnitude), blue = blend
		out_Output.rgb = vec3(abs(velocity) * 0.1, alpha);

	}

}
`;

class TemporalAAMaterial extends FullscreenMaterial {

    constructor(exposure: Uniform<number>) {

        super({
            name: "TemporalAAMaterial",
            fragmentShader,
            uniforms: {
                depthBuffer: new Uniform(null),
                velocityBuffer: new Uniform(BLACK),
                useVelocityBuffer: new Uniform(false),
                historyBuffer: new Uniform(null),
                inverseViewProjectionJittered: new Uniform(new Matrix4()),
                viewProjection: new Uniform(new Matrix4()),
                previousViewProjection: new Uniform(new Matrix4()),
                objectMotion: new Uniform(new Matrix4()),
                texelSize: new Uniform(new Vector2()),
                jitterOffset: new Uniform(new Vector2()),
                previousJitter: new Uniform(new Vector2()),
                backgroundBounds: new Uniform(new Vector4(0, 0, 1, 1)),
                exposure,
                blend: new Uniform(0.2),
                varianceGamma: new Uniform(1.0),
                historyValid: new Uniform(false),
                clipHistory: new Uniform(true),
                filterSharpness: new Uniform(5.0),
                motionFilterSharpness: new Uniform(5.0),
                motionFilterScale: new Uniform(1.0),
                jitterCompensation: new Uniform(0.0),
                stateBuffer: new Uniform(null),
                moving: new Uniform(true),
                neighbourCount: new Uniform(5),
                boxMode: new Uniform(0),
                clipTowardsCurrent: new Uniform(false),
                depthRejection: new Uniform(false),
                depthTolerance: new Uniform(0.0015),
                motionRejection: new Uniform(false),
                motionTolerance: new Uniform(1.0),
                trustedGamma: new Uniform(2.0),
                disocclusionBlend: new Uniform(0.35),
                thinFeatureLocks: new Uniform(false),
                lockStep: new Uniform(0.125),
                lockMaxSpeed: new Uniform(0.0),
                reactiveMask: new Uniform(BLACK),
                reactiveStrength: new Uniform(0.0),
                lockSimilarity: new Uniform(0.75),
                lockStrength: new Uniform(1.0),
                edgeAdaptiveBlend: new Uniform(false),
                edgeBlend: new Uniform(0.08),
                sampleConfidence: new Uniform(false),
                debugView: new Uniform(0)
            }
        });

        // Writes HDR to a half float buffer, see TonemappedResolveMaterial
        this.outputPrecision = "mediump";
        this.onBeforeCompile = () => {};

    }

}

/**
 * Radical inverse in the given base, used for the Halton sequence.
 */

function halton(index: number, base: number): number {

    let result = 0;
    let f = 1;

    for(let i = index; i > 0; i = Math.floor(i / base)) {

        f /= base;
        result += f * (i % base);

    }

    return result;

}

/**
 * Compares matrices with a tolerance far below a pixel of motion, so camera damping that has visually settled counts
 * as still.
 */

function matricesEqual(a: Matrix4, b: Matrix4): boolean {

    for(let i = 0; i < 16; ++i) {

        if(Math.abs(a.elements[i] - b.elements[i]) > 1e-6) {

            return false;

        }

    }

    return true;

}

/**
 * Jitters the camera projection. Must be the first pass of the pipeline.
 */

class TemporalJitterPass extends Pass {

    constructor(private readonly taa: TemporalAAPass) {

        super("TemporalJitterPass");

    }

    render(): void {

        this.taa.applyJitter();

    }

}

/**
 * TemporalAAPass options.
 */

export interface TemporalAAPassOptions {

    /**
     * The tone mapping exposure, matches the encoding of {@link TonemappedResolvePass}.
     *
     * @defaultValue 1.0
     */

    exposure?: number;

    /**
     * The weight of the current frame. Lower is smoother but slower to converge and softer in motion.
     *
     * @defaultValue 0.2
     */

    blend?: number;

    /**
     * The jitter amplitude in pixels. With the reconstruction filter, the jitter should span the whole pixel: the
     * filter weights depend on where each sample landed, which carries no information when the jitter is small.
     *
     * @defaultValue 1.0
     */

    jitterScale?: number;

    /**
     * The number of jitter positions.
     *
     * @defaultValue 8
     */

    jitterSamples?: number;

    /**
     * The falloff of the Gaussian reconstruction filter, `exp(-k * d²)` with `d` in pixels. 2.29 fits a
     * Blackman-Harris window (Karis 2014). Higher is sharper but leaves more of the box filter steps.
     *
     * @defaultValue 5.0
     */

    filterSharpness?: number;

    /**
     * The lowest weight of the current frame while nothing moves. Lower converges to a smoother, steadier still image
     * but takes longer: the weight ramps down as a running average, 1 / (1 / blend + still frames).
     *
     * @defaultValue 0.02
     */

    staticBlend?: number;

    /**
     * Controls whether the history converges while nothing moves. See {@link staticBlend}.
     *
     * @defaultValue true
     */

    staticConvergence?: boolean;

    /**
     * The width of the contrast clamp, in standard deviations of the current neighbourhood. Higher keeps more history
     * while the camera or the object moves (smoother edges, more ghosting), lower rejects more (sharper, more jitter
     * noise).
     *
     * @defaultValue 1.0
     */

    varianceGamma?: number;

    /**
     * Controls whether the history lookup compensates for the change in jitter offset between frames. The history is a
     * jittered image, so a surface lands on a different texel every frame: without the compensation the history lands
     * up to two pixels away from the surface it belongs to and the contrast clamp throws it away while moving. With it,
     * the lookup follows the surface instead of averaging the jitter positions, which leaves the jitter visible in still
     * frames and needs a lower {@link jitterScale} to hide it.
     *
     * @defaultValue false
     */

    jitterCompensation?: boolean;

    /**
     * The reconstruction filter falloff while the history is rejected, e.g. `exp(-k * d²)` with `k` around 2. Lower is
     * wider: the current frame alone is smoothed, which hides the jitter pattern in motion at the cost of sharpness.
     * Defaults to {@link filterSharpness}, which disables the adaptive widening.
     */

    motionFilterSharpness?: number;

    /**
     * How quickly the reconstruction filter widens with reprojection velocity, in 1 / pixels. At 1.0 a pixel of motion
     * per frame uses {@link motionFilterSharpness} fully. 0 disables the adaptive widening.
     *
     * @defaultValue 1.0
     */

    motionFilterScale?: number;

    /**
     * Controls whether the history is clamped to the current neighbourhood. Disabling it lets the history accumulate
     * across motion (less jitter, more ghosting). Always disabled while nothing moves.
     *
     * @defaultValue true
     */

    clampHistory?: boolean;

    /**
     * Skip reconstruction outside the tracked object's accumulated screen bounds, including transparent children.
     * The footprint only grows until reset(), preserving even faint history trails after motion.
     * Opt in only when ALL rendered geometry belongs to that rigid object, with no vertex displacement.
     * Automatically falls back for non-black/textured backgrounds, fog, unsafe projection or unclamped history.
     *
     * @defaultValue false
     */

    backgroundFastPath?: boolean;

    /**
     * The neighbourhood of the contrast clamp and the reconstruction filter: the 5-tap cross or the full 3x3. The
     * cross misses diagonal neighbours, so on the steps of a thin diagonal line the box collapses and clips the history
     * of the line away.
     *
     * @defaultValue 5
     */

    neighbourhood?: 5 | 9;

    /**
     * The shape of the clamp box: mean ± Γσ (Salvi 2016), the min/max of the neighbourhood scaled by Γ around its
     * centre, or the intersection of both.
     *
     * @defaultValue "variance"
     */

    boxMode?: TemporalAABoxMode;

    /**
     * Controls whether the history is clipped towards the current colour instead of the box centre (Pedersen 2016).
     *
     * @defaultValue false
     */

    clipTowardsCurrent?: boolean;

    /**
     * Validate the history with the depth of the reprojected surface (Nehab et al. 2007), stored with the history.
     * Disoccluded pixels refresh faster ({@link disocclusionBlend}), pixels on the same surface use the wider
     * {@link trustedGamma}: the reprojection of the rigid object is exact, so only shading changes are left to clamp.
     *
     * @defaultValue false
     */

    depthRejection?: boolean;

    /**
     * The relative view depth difference below which the history holds the same surface. Must be smaller than the
     * gap between overlapping parts: 0.0015 is 1.2 mm at 0.8 m, and the clips stand 2.7 mm above the print. The
     * expected depth is exact (rigid reprojection, or the depth change of the velocity buffer), and the stored depth is
     * a half float, about 0.06% precise.
     *
     * @defaultValue 0.0015
     */

    depthTolerance?: number;

    /**
     * Also reject history whose motion differs from the current one by more than {@link motionTolerance} (motion
     * vector divergence, FSR 2 / TSR). Depth can't separate a thin part lying flush on another: when it slides off, the
     * surface it uncovers would keep its history. Their motions differ, though.
     *
     * @defaultValue false
     */

    motionRejection?: boolean;

    /**
     * The motion difference, in pixels per frame, still treated as the same surface. A quarter of the current motion
     * is added for acceleration.
     *
     * @defaultValue 1.0
     */

    motionTolerance?: number;

    /**
     * The clamp width on surfaces that passed the depth validation. See {@link depthRejection}.
     *
     * @defaultValue 2.0
     */

    trustedGamma?: number;

    /**
     * The lowest weight of the current frame on disoccluded pixels. See {@link depthRejection}.
     *
     * @defaultValue 0.35
     */

    disocclusionBlend?: number;

    /**
     * Lock the history of thin features against the clamp (FSR 2). A pixel that no 2x2 quad around it resembles is
     * a sub-pixel line, which some jitter positions miss entirely; the clamp then erases it from the history in those
     * frames, which is what breaks the line into steps in motion. Locks follow the surface and fade over
     * {@link lockFrames}; a disocclusion drops them when {@link depthRejection} is on.
     *
     * @defaultValue false
     */

    thinFeatureLocks?: boolean;

    /**
     * How many frames a lock lasts after the feature was last detected. It fades linearly.
     *
     * @defaultValue 8
     */

    lockFrames?: number;

    /**
     * The luma ratio above which two pixels look alike for the thin feature test. Higher locks more.
     *
     * @defaultValue 0.75
     */

    lockSimilarity?: number;

    /**
     * How much a full lock bypasses the clamp.
     *
     * @defaultValue 1.0
     */

    lockStrength?: number;

    /**
     * Lower the weight of the current frame towards {@link edgeBlend} in high-contrast neighbourhoods while moving
     * (Malan 2012). That's where the jitter shows the most.
     *
     * @defaultValue false
     */

    edgeAdaptiveBlend?: boolean;

    /**
     * The weight of the current frame on high-contrast edges while moving. See {@link edgeAdaptiveBlend}.
     *
     * @defaultValue 0.08
     */

    edgeBlend?: number;

    /**
     * Weight each frame by how close its jittered sample landed to the pixel centre while moving (UE4).
     *
     * @defaultValue false
     */

    sampleConfidence?: boolean;

    /**
     * The reprojection speed, in pixels per frame, at which locks are fully faded out. They start fading at half of it.
     * Whatever a lock keeps is visibly out of date in fast motion, and motion blur hides the steps there anyway. 0 keeps
     * locks at any speed.
     *
     * @defaultValue 0
     */

    lockMaxSpeed?: number;

    /**
     * Where transparent surfaces cover the image, 0 to 1, e.g. {@link TonemappedResolvePass.reactiveMask}. Their
     * reflections and scratches move on their own and the depth behind them doesn't describe them, so they get no
     * locks, no relaxed clamp and no edge blend (FSR 2 "reactive mask"). Must match the output resolution.
     *
     * @defaultValue null
     */

    reactiveMask?: Texture | null;

    /**
     * How much the {@link reactiveMask} applies.
     *
     * @defaultValue 1.0
     */

    reactiveStrength?: number;

    /**
     * Per-object velocity from the geometry pass. Without it, motion is reprojected analytically for the camera and the
     * {@link TemporalAAPass.trackedObject} only, which moves as one rigid body.
     *
     * @defaultValue null
     */

    velocityBuffer?: VelocityBuffer | null;

}

/**
 * The shape of the clamp box. See {@link TemporalAAPassOptions.boxMode}.
 */

export type TemporalAABoxMode = "variance" | "minmax" | "intersection";

const BOX_MODES: TemporalAABoxMode[] = ["variance", "minmax", "intersection"];

// Stands in for a missing reactive mask, never read: the shader skips the lookup when the strength is 0
const BLACK = new DataTexture(new Uint8Array(4), 1, 1);
BLACK.needsUpdate = true;

/**
 * Temporal antialiasing for a single rigid object in front of a static background.
 *
 * Add {@link jitterPass} as the first pass of the pipeline and this pass right after {@link TonemappedResolvePass}.
 */

export class TemporalAAPass extends Pass<TemporalAAMaterial> {

    /**
     * Jitters the camera. Must be the first pass of the pipeline.
     */

    readonly jitterPass: Pass;

    /**
     * The object whose motion is reprojected. Everything else is assumed to be static.
     */

    trackedObject: Object3D | null;

    /**
     * The jitter amplitude in pixels.
     */

    jitterScale: number;

    /**
     * The number of jitter positions.
     */

    jitterSamples: number;

    /**
     * The lowest weight of the current frame while nothing moves.
     */

    staticBlend: number;

    /**
     * Controls whether the history converges while nothing moves.
     */

    staticConvergence: boolean;

    /**
     * Controls whether the history is clamped to the current neighbourhood while moving.
     */

    clampHistory: boolean;

    /** @see {@link TemporalAAPassOptions.backgroundFastPath} */
    backgroundFastPath: boolean;

    /** @see {@link TemporalAAPassOptions.velocityBuffer} */
    private _velocityBuffer: VelocityBuffer | null = null;

    /**
     * Ping-pong history: one is read while the other is written. Both also have the output texture as a second
     * attachment, so a single draw writes the history and the output.
     */

    private readonly history: [WebGLRenderTarget, WebGLRenderTarget];
    private frame: number;
    private stillFrames: number;

    /**
     * Whether the latest frame had no motion at all: valid history, unchanged camera and tracked object, and no mesh
     * moved on its own. Its motion state is zero everywhere, so {@link MotionBlurPass} would be an exact copy.
     */
    motionless = false;
    private _blend: number;
    private _reactiveMask: Texture | null = null;
    private _reactiveStrength = 1.0;

    private readonly projection: Matrix4;
    private readonly viewProjection: Matrix4;
    private readonly previousViewProjection: Matrix4;
    private readonly objectMatrix: Matrix4;
    private readonly previousObjectMatrix: Matrix4;
    private readonly jitter: Vector2;
    private jittered: boolean;
    private readonly boundsProjector = new TemporalAABounds();
    private readonly worldBounds = new Box3();
    private readonly currentBounds = new Vector4(0, 0, 1, 1);
    private readonly previousBounds = new Vector4(0, 0, 1, 1);

    /**
     * Constructs a new temporal antialiasing pass.
     *
     * @param options - The options.
     */

    constructor({
        exposure = 1.0,
        blend = 0.2,
        jitterScale = 1.0,
        jitterSamples = 8,
        filterSharpness = 5.0,
        motionFilterSharpness,
        motionFilterScale = 1.0,
        jitterCompensation = false,
        staticBlend = 0.02,
        staticConvergence = true,
        varianceGamma = 1.0,
        clampHistory = true,
        backgroundFastPath = false,
        neighbourhood = 5,
        boxMode = "variance",
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
        velocityBuffer = null
    }: TemporalAAPassOptions = {}) {

        super("TemporalAAPass");

        this.fullscreenMaterial = new TemporalAAMaterial(new Uniform(exposure));
        this._blend = blend;
        this.staticBlend = staticBlend;
        this.staticConvergence = staticConvergence;
        this.clampHistory = clampHistory;
        this.backgroundFastPath = backgroundFastPath;
        this.stillFrames = 0;

        const uniforms = this.fullscreenMaterial.uniforms;
        uniforms.filterSharpness.value = filterSharpness;
        uniforms.motionFilterSharpness.value = motionFilterSharpness ?? filterSharpness;
        uniforms.motionFilterScale.value = motionFilterScale;
        uniforms.jitterCompensation.value = jitterCompensation ? 1.0 : 0.0;
        uniforms.varianceGamma.value = varianceGamma;
        uniforms.neighbourCount.value = neighbourhood;
        uniforms.clipTowardsCurrent.value = clipTowardsCurrent;
        uniforms.depthRejection.value = depthRejection;
        uniforms.depthTolerance.value = depthTolerance;
        uniforms.motionRejection.value = motionRejection;
        uniforms.motionTolerance.value = motionTolerance;
        uniforms.trustedGamma.value = trustedGamma;
        uniforms.disocclusionBlend.value = disocclusionBlend;
        uniforms.thinFeatureLocks.value = thinFeatureLocks;
        uniforms.lockSimilarity.value = lockSimilarity;
        uniforms.lockStrength.value = lockStrength;
        uniforms.edgeAdaptiveBlend.value = edgeAdaptiveBlend;
        uniforms.edgeBlend.value = edgeBlend;
        uniforms.sampleConfidence.value = sampleConfidence;
        uniforms.lockMaxSpeed.value = lockMaxSpeed;
        this._reactiveStrength = reactiveStrength;
        this.reactiveMask = reactiveMask;
        this.boxMode = boxMode;
        this.lockFrames = lockFrames;

        this.input.gBuffer.add(GBuffer.COLOR);
        this.input.gBuffer.add(GBuffer.DEPTH);

        // The output stays in the 32-bit format of the rest of the pipeline. Passes downstream adopt the format of
        // their input, so RGBA16F here would double the bandwidth of bloom. It's only ever written as an attachment of
        // the history targets.
        const outputBuffer = new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBFormat, depthBuffer: false });
        outputBuffer.texture.internalFormat = "R11F_G11F_B10F";
        this.output.defaultBuffer = outputBuffer;

        // The history accumulates over many frames, R11G11B10 measurably loses edge quality there. Linear filtering:
        // the 5-tap Catmull-Rom relies on it. Writing the output as a second attachment saves a copy pass, which
        // costs ~1.3 ms at 3070x2050 on an M1: copyTexSubImage2D can't convert RGBA16F to R11G11B10.
        // The third attachment is the per-pixel state (surface depth, thin feature lock), ping-ponged with the history.
        // It isn't filterable, the shader fetches texels.
        const historyOptions = { type: HalfFloatType, format: RGBAFormat, depthBuffer: false, count: 3 };
        this.history = [new WebGLRenderTarget(1, 1, historyOptions), new WebGLRenderTarget(1, 1, historyOptions)];
        this.history.forEach((buffer) => {

            buffer.textures[1] = outputBuffer.texture;
            buffer.textures[2].minFilter = NearestFilter;
            buffer.textures[2].magFilter = NearestFilter;
            this.disposables.add(buffer);

        });

        this.jitterPass = new TemporalJitterPass(this);
        this.trackedObject = null;
        this.jitterScale = jitterScale;
        this.jitterSamples = jitterSamples;
        this.frame = 0;

        this.projection = new Matrix4();
        this.viewProjection = new Matrix4();
        this.previousViewProjection = new Matrix4();
        this.objectMatrix = new Matrix4();
        this.previousObjectMatrix = new Matrix4();
        this.jitter = new Vector2();
        this.jittered = false;
        // Last: it resets the history, which needs the jitter state
        this.velocityBuffer = velocityBuffer;

    }

    /**
     * The exposure of the tonemapped space the history is filtered and clamped in, see {@link TemporalAAPassOptions.exposure}.
     */

    get exposure(): number {

        return this.fullscreenMaterial.uniforms.exposure.value;

    }

    set exposure(value: number) {

        this.fullscreenMaterial.uniforms.exposure.value = value;

    }

    /**
     * The falloff of the Gaussian reconstruction filter, `exp(-k * d²)` with `d` in pixels.
     */

    get filterSharpness(): number {

        return this.fullscreenMaterial.uniforms.filterSharpness.value;

    }

    set filterSharpness(value: number) {

        this.fullscreenMaterial.uniforms.filterSharpness.value = value;

    }

    /**
     * The falloff of the Gaussian reconstruction filter while moving. See {@link motionFilterSharpness}.
     */

    get motionFilterSharpness(): number {

        return this.fullscreenMaterial.uniforms.motionFilterSharpness.value;

    }

    set motionFilterSharpness(value: number) {

        this.fullscreenMaterial.uniforms.motionFilterSharpness.value = value;

    }

    /**
     * How quickly the reconstruction filter widens with reprojection velocity, in 1 / pixels.
     */

    get motionFilterScale(): number {

        return this.fullscreenMaterial.uniforms.motionFilterScale.value;

    }

    set motionFilterScale(value: number) {

        this.fullscreenMaterial.uniforms.motionFilterScale.value = value;

    }

    /**
     * The width of the contrast clamp, in standard deviations of the current neighbourhood.
     */

    get varianceGamma(): number {

        return this.fullscreenMaterial.uniforms.varianceGamma.value;

    }

    set varianceGamma(value: number) {

        this.fullscreenMaterial.uniforms.varianceGamma.value = value;

    }

    /**
     * Controls whether the history lookup compensates for the change in jitter offset between frames.
     */

    get jitterCompensation(): boolean {

        return this.fullscreenMaterial.uniforms.jitterCompensation.value !== 0.0;

    }

    set jitterCompensation(value: boolean) {

        this.fullscreenMaterial.uniforms.jitterCompensation.value = value ? 1.0 : 0.0;

    }

    /** @see {@link TemporalAAPassOptions.neighbourhood} */
    get neighbourhood(): 5 | 9 {

        return this.fullscreenMaterial.uniforms.neighbourCount.value;

    }

    set neighbourhood(value: 5 | 9) {

        this.fullscreenMaterial.uniforms.neighbourCount.value = value;

    }

    /** @see {@link TemporalAAPassOptions.boxMode} */
    get boxMode(): TemporalAABoxMode {

        return BOX_MODES[this.fullscreenMaterial.uniforms.boxMode.value];

    }

    set boxMode(value: TemporalAABoxMode) {

        this.fullscreenMaterial.uniforms.boxMode.value = Math.max(BOX_MODES.indexOf(value), 0);

    }

    /** @see {@link TemporalAAPassOptions.clipTowardsCurrent} */
    get clipTowardsCurrent(): boolean {

        return this.fullscreenMaterial.uniforms.clipTowardsCurrent.value;

    }

    set clipTowardsCurrent(value: boolean) {

        this.fullscreenMaterial.uniforms.clipTowardsCurrent.value = value;

    }

    /** @see {@link TemporalAAPassOptions.depthRejection} */
    get depthRejection(): boolean {

        return this.fullscreenMaterial.uniforms.depthRejection.value;

    }

    set depthRejection(value: boolean) {

        this.fullscreenMaterial.uniforms.depthRejection.value = value;

    }

    /** @see {@link TemporalAAPassOptions.depthTolerance} */
    get depthTolerance(): number {

        return this.fullscreenMaterial.uniforms.depthTolerance.value;

    }

    set depthTolerance(value: number) {

        this.fullscreenMaterial.uniforms.depthTolerance.value = value;

    }

    /** @see {@link TemporalAAPassOptions.motionRejection} */
    get motionRejection(): boolean {

        return this.fullscreenMaterial.uniforms.motionRejection.value;

    }

    set motionRejection(value: boolean) {

        this.fullscreenMaterial.uniforms.motionRejection.value = value;

    }

    /** @see {@link TemporalAAPassOptions.motionTolerance} */
    get motionTolerance(): number {

        return this.fullscreenMaterial.uniforms.motionTolerance.value;

    }

    set motionTolerance(value: number) {

        this.fullscreenMaterial.uniforms.motionTolerance.value = value;

    }

    /** @see {@link TemporalAAPassOptions.trustedGamma} */
    get trustedGamma(): number {

        return this.fullscreenMaterial.uniforms.trustedGamma.value;

    }

    set trustedGamma(value: number) {

        this.fullscreenMaterial.uniforms.trustedGamma.value = value;

    }

    /** @see {@link TemporalAAPassOptions.disocclusionBlend} */
    get disocclusionBlend(): number {

        return this.fullscreenMaterial.uniforms.disocclusionBlend.value;

    }

    set disocclusionBlend(value: number) {

        this.fullscreenMaterial.uniforms.disocclusionBlend.value = value;

    }

    /** @see {@link TemporalAAPassOptions.thinFeatureLocks} */
    get thinFeatureLocks(): boolean {

        return this.fullscreenMaterial.uniforms.thinFeatureLocks.value;

    }

    set thinFeatureLocks(value: boolean) {

        this.fullscreenMaterial.uniforms.thinFeatureLocks.value = value;

    }

    /** @see {@link TemporalAAPassOptions.lockFrames} */
    get lockFrames(): number {

        return 1.0 / this.fullscreenMaterial.uniforms.lockStep.value;

    }

    set lockFrames(value: number) {

        this.fullscreenMaterial.uniforms.lockStep.value = 1.0 / Math.max(value, 1.0);

    }

    /** @see {@link TemporalAAPassOptions.lockSimilarity} */
    get lockSimilarity(): number {

        return this.fullscreenMaterial.uniforms.lockSimilarity.value;

    }

    set lockSimilarity(value: number) {

        this.fullscreenMaterial.uniforms.lockSimilarity.value = value;

    }

    /** @see {@link TemporalAAPassOptions.lockStrength} */
    get lockStrength(): number {

        return this.fullscreenMaterial.uniforms.lockStrength.value;

    }

    set lockStrength(value: number) {

        this.fullscreenMaterial.uniforms.lockStrength.value = value;

    }

    /** @see {@link TemporalAAPassOptions.edgeAdaptiveBlend} */
    get edgeAdaptiveBlend(): boolean {

        return this.fullscreenMaterial.uniforms.edgeAdaptiveBlend.value;

    }

    set edgeAdaptiveBlend(value: boolean) {

        this.fullscreenMaterial.uniforms.edgeAdaptiveBlend.value = value;

    }

    /** @see {@link TemporalAAPassOptions.edgeBlend} */
    get edgeBlend(): number {

        return this.fullscreenMaterial.uniforms.edgeBlend.value;

    }

    set edgeBlend(value: number) {

        this.fullscreenMaterial.uniforms.edgeBlend.value = value;

    }

    /** @see {@link TemporalAAPassOptions.sampleConfidence} */
    get sampleConfidence(): boolean {

        return this.fullscreenMaterial.uniforms.sampleConfidence.value;

    }

    set sampleConfidence(value: boolean) {

        this.fullscreenMaterial.uniforms.sampleConfidence.value = value;

    }

    /** @see {@link TemporalAAPassOptions.velocityBuffer} */
    get velocityBuffer(): VelocityBuffer | null {

        return this._velocityBuffer;

    }

    set velocityBuffer(value: VelocityBuffer | null) {

        // Requesting the component makes the pipeline add it to the geometry pass, which recompiles the materials
        this._velocityBuffer = value;

        if(value !== null) {

            this.input.gBuffer.add(VELOCITY);

        } else {

            this.input.gBuffer.delete(VELOCITY);

        }

        this.onInputChange();
        this.reset();

    }

    /** @see {@link TemporalAAPassOptions.lockMaxSpeed} */
    get lockMaxSpeed(): number {

        return this.fullscreenMaterial.uniforms.lockMaxSpeed.value;

    }

    set lockMaxSpeed(value: number) {

        this.fullscreenMaterial.uniforms.lockMaxSpeed.value = value;

    }

    /** @see {@link TemporalAAPassOptions.reactiveMask} */
    get reactiveMask(): Texture | null {

        return this._reactiveMask;

    }

    set reactiveMask(value: Texture | null) {

        this._reactiveMask = value;
        this.updateReactive();

    }

    /** @see {@link TemporalAAPassOptions.reactiveStrength} */
    get reactiveStrength(): number {

        return this._reactiveStrength;

    }

    set reactiveStrength(value: number) {

        this._reactiveStrength = value;
        this.updateReactive();

    }

    private updateReactive(): void {

        // Without a mask the shader skips the lookup entirely
        const uniforms = this.fullscreenMaterial.uniforms;
        uniforms.reactiveMask.value = this._reactiveMask ?? BLACK;
        uniforms.reactiveStrength.value = this._reactiveMask !== null ? this._reactiveStrength : 0.0;

    }

    /**
     * The per-pixel state written by the latest frame: x the view depth of the surface (0 for the background), y the
     * thin feature lock, zw the screen motion since the previous frame in pixels. Depth and motion are those of the
     * closest surface in the 3x3 neighbourhood, which the pixel is reprojected with. Valid after this pass has rendered.
     */

    get stateTexture(): Texture {

        return this.history[this.frame % 2].textures[2];

    }

    /**
     * Overlays per-pixel state on the output, for tuning: 0 none, 1 effective thin feature locks (red), 2 depth
     * validation (green trusted, red disoccluded), 3 reactive mask (blue). The history isn't affected.
     */

    get debugView(): number {

        return this.fullscreenMaterial.uniforms.debugView.value;

    }

    set debugView(value: number) {

        this.fullscreenMaterial.uniforms.debugView.value = value;

    }

    get enabled(): boolean {

        return super.enabled;

    }

    set enabled(value: boolean) {

        super.enabled = value;

        if(this.jitterPass !== undefined) {

            this.jitterPass.enabled = value;

        }

        this.reset();

    }

    /**
     * The weight of the current frame.
     */

    get blend(): number {

        return this._blend;

    }

    set blend(value: number) {

        this._blend = value;

    }

    /**
     * Discards the history, e.g. after a cut.
     */

    reset(): void {

        if(this.fullscreenMaterial !== undefined) {

            this.fullscreenMaterial.uniforms.historyValid.value = false;
            // The history is discarded, so the next frame has no previous jitter to compensate for
            this.fullscreenMaterial.uniforms.previousJitter.value.copy(this.jitter);

        }

        // Restart the jitter sequence so that convergence after a reset is deterministic
        this.frame = 0;
        this.stillFrames = 0;
        this.motionless = false;

    }

    /**
     * Offsets the camera projection by the next sub-pixel jitter. Called by {@link jitterPass}.
     */

    applyJitter(): void {

        const camera = this.camera;

        if(!(camera instanceof PerspectiveCamera)) {

            return;

        }

        // Keep the unjittered projection for reprojection and to restore it afterwards
        this.projection.copy(camera.projectionMatrix);
        this._velocityBuffer?.update(camera, this.projection);

        const index = (this.frame % this.jitterSamples) + 1;
        const x = (halton(index, 2) - 0.5) * this.jitterScale;
        const y = (halton(index, 3) - 0.5) * this.jitterScale;
        const { width, height } = this.resolution;

        const elements = camera.projectionMatrix.elements;
        elements[8] += (2.0 * x) / width;
        elements[9] += (2.0 * y) / height;
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

        // Adding to elements 8 and 9 moves the image by (-x, -y) pixels: a pixel sees what is (x, y) pixels away from
        // its centre in the unjittered image
        const uniforms = this.fullscreenMaterial.uniforms;
        uniforms.previousJitter.value.copy(this.jitter);
        this.jitter.set(x, y);
        uniforms.jitterOffset.value.copy(this.jitter);

        this.jittered = true;

    }

    private restoreProjection(camera: PerspectiveCamera): void {

        if(this.jittered) {

            camera.projectionMatrix.copy(this.projection);
            camera.projectionMatrixInverse.copy(this.projection).invert();
            this.jittered = false;

        }

    }

    protected override onInputChange(): void {

        const uniforms = this.fullscreenMaterial.uniforms;
        const velocity = this._velocityBuffer !== null ? this.input.getBuffer(VELOCITY) : null;
        uniforms.depthBuffer.value = this.input.getBuffer(GBuffer.DEPTH);
        uniforms.velocityBuffer.value = velocity ?? BLACK;
        uniforms.useVelocityBuffer.value = velocity !== null;

    }

    protected override onResolutionChange(): void {

        const { width, height } = this.resolution;
        this.history.forEach((buffer) => buffer.setSize(width, height));
        this.fullscreenMaterial.uniforms.texelSize.value.set(1.0 / width, 1.0 / height);
        this.reset();

    }

    private updateBackgroundBounds(): void {

        const bounds = this.currentBounds.set(0, 0, 1, 1);
        const scene = this.scene;
        const object = this.trackedObject;
        const background = scene?.background;

        if(this.backgroundFastPath && this.clampHistory && object !== null && scene?.fog === null &&
            background instanceof Color && background.r === 0 && background.g === 0 && background.b === 0) {

            // Geometry rendering has already updated world matrices. Box3 includes the glass, even though it doesn't
            // write depth. Recompute from cached geometry boxes so child transforms and camera motion stay covered.
            this.worldBounds.setFromObject(object);
            const { width, height } = this.resolution;
            this.boundsProjector.project(this.worldBounds, this.viewProjection, width, height,
                3 + Math.abs(this.jitterScale), bounds);

        }

        const uniforms = this.fullscreenMaterial.uniforms;
        const output = uniforms.backgroundBounds.value as Vector4;
        output.copy(bounds);

        if(uniforms.historyValid.value) {

            // Keep the entire history footprint, not just last frame's silhouette: even clamped history can leave a
            // faint tail after motion. An unsafe projection expands this to full screen until the next reset().
            output.set(Math.min(bounds.x, this.previousBounds.x), Math.min(bounds.y, this.previousBounds.y),
                Math.max(bounds.z, this.previousBounds.z), Math.max(bounds.w, this.previousBounds.w));

        }

    }

    render(): void {

        const renderer = this.renderer;
        const camera = this.camera;
        const outputBuffer = (this.output.defaultBuffer?.value ?? null) as WebGLRenderTarget | null;

        if(renderer === null || !(camera instanceof PerspectiveCamera) || this.input.defaultBuffer?.value == null) {

            return;

        }

        const uniforms = this.fullscreenMaterial.uniforms;

        // The output is attached to the history targets, see history
        if(outputBuffer === null) {

            return;

        }

        // camera.matrixWorldInverse and the object matrix were updated while rendering the geometry
        uniforms.inverseViewProjectionJittered.value
            .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
        this.viewProjection.multiplyMatrices(this.projection, camera.matrixWorldInverse);
        uniforms.viewProjection.value.copy(this.viewProjection);
        uniforms.previousViewProjection.value.copy(this.previousViewProjection);
        this.updateBackgroundBounds();

        if(this.trackedObject !== null) {

            this.objectMatrix.copy(this.trackedObject.matrixWorld);
            uniforms.objectMotion.value.copy(this.objectMatrix).invert().premultiply(this.previousObjectMatrix);

        } else {

            uniforms.objectMotion.value.identity();

        }

        // With per-object velocity, a part can move on its own while the camera and the tracked object rest
        this.motionless = uniforms.historyValid.value &&
            matricesEqual(this.viewProjection, this.previousViewProjection) &&
            matricesEqual(this.objectMatrix, this.previousObjectMatrix) &&
            !(this._velocityBuffer !== null && uniforms.useVelocityBuffer.value && this._velocityBuffer.meshesMoved);
        const still = this.staticConvergence && this.motionless;

        this.stillFrames = still ? this.stillFrames + 1 : 0;
        uniforms.blend.value = still ? Math.max(1.0 / (1.0 / this._blend + this.stillFrames), this.staticBlend) : this._blend;
        uniforms.clipHistory.value = this.clampHistory && !still;
        uniforms.moving.value = !still;

        const historyRead = this.history[this.frame % 2];
        const historyWrite = this.history[(this.frame + 1) % 2];
        uniforms.historyBuffer.value = historyRead.texture;
        uniforms.stateBuffer.value = historyRead.textures[2];

        this.setRenderTarget(historyWrite);
        this.renderFullscreen();

        uniforms.historyValid.value = true;
        this.previousViewProjection.copy(this.viewProjection);
        this.previousObjectMatrix.copy(this.objectMatrix);
        this.previousBounds.copy(uniforms.backgroundBounds.value);
        this.restoreProjection(camera);
        ++this.frame;

    }

}
