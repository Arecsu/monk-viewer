import { HalfFloatType, NearestFilter, RGBAFormat, RGBFormat, Uniform, Vector4, WebGLRenderTarget } from "three";
import { FullscreenMaterial, Pass } from "postprocessing";
import type { TemporalAAPass } from "./TemporalAAPass.js";

/**
 * Per-object and camera motion blur, reconstructed from the motion that {@link TemporalAAPass} computes per pixel.
 *
 * McGuire et al. 2012, "A Reconstruction Filter for Plausible Motion Blur", with the improvements of Jimenez 2014,
 * "Next Generation Post Processing in Call of Duty: Advanced Warfare" (the approach of id Tech 6/7 and most current
 * engines):
 *
 * 1. Tile max: the largest motion in each tile of {@link maxBlur} pixels, reduced along rows then columns.
 * 2. Neighbour max: the largest motion in the 3x3 tiles around, so that a moving object can smear over the static
 *    background next to it. Blurring each pixel along its own motion only can't do that: the silhouette stays sharp.
 * 3. Gather: samples along the neighbourhood's motion and along the pixel's own, weighted by depth so that the
 *    foreground streaks over the background but the background doesn't bleed into a sharp foreground.
 *
 * Runs after TAA on its output and never feeds back into the history, so the antialiasing still converges. Blurs linear
 * HDR before bloom, so highlights streak with their energy. The depth is the view depth stored by TAA; the background
 * counts as infinitely far and static.
 */

// The tile max is separable: the largest of the largest per row is the largest of the tile. Two passes of tileSize
// fetches per fragment instead of one of tileSize², which leaves only a few hundred fragments, each looping over tens of
// thousands of texels: at 4K the single pass took longer than the rest of the frame.
const tileMaxXShader = /* glsl */ `
#include <pp_default_output_pars_fragment>

uniform highp sampler2D stateBuffer;
uniform int tileSize;
uniform float shutter;
uniform float maxBlur;

// Half the blur streak, as in McGuire et al.: a pixel blurs over [-v, v]. Clamped to the tile size.
vec2 blurVector(vec2 motion) {

	vec2 v = motion * (0.5 * shutter);
	float l = length(v);
	return l > maxBlur ? v * (maxBlur / l) : v;

}

void main() {

	ivec2 size = textureSize(stateBuffer, 0);
	ivec2 base = ivec2(int(gl_FragCoord.x) * tileSize, int(gl_FragCoord.y));
	int end = min(tileSize, size.x - base.x);
	vec2 largest = vec2(0.0);
	float largestLength = 0.0;

	for(int x = 0; x < end; ++x) {

		vec2 v = blurVector(texelFetch(stateBuffer, base + ivec2(x, 0), 0).zw);
		float l = dot(v, v);

		if(l > largestLength) {

			largestLength = l;
			largest = v;

		}

	}

	out_Color = vec4(largest, 0.0, 1.0);

}
`;

const tileMaxYShader = /* glsl */ `
#include <pp_default_output_pars_fragment>

uniform highp sampler2D rowBuffer;
uniform int tileSize;

void main() {

	ivec2 size = textureSize(rowBuffer, 0);
	ivec2 base = ivec2(int(gl_FragCoord.x), int(gl_FragCoord.y) * tileSize);
	int end = min(tileSize, size.y - base.y);
	vec2 largest = vec2(0.0);
	float largestLength = 0.0;

	for(int y = 0; y < end; ++y) {

		vec2 v = texelFetch(rowBuffer, base + ivec2(0, y), 0).xy;
		float l = dot(v, v);

		if(l > largestLength) {

			largestLength = l;
			largest = v;

		}

	}

	out_Color = vec4(largest, 0.0, 1.0);

}
`;

const neighbourMaxShader = /* glsl */ `
#include <pp_default_output_pars_fragment>

uniform highp sampler2D tileBuffer;

void main() {

	ivec2 size = textureSize(tileBuffer, 0);
	ivec2 center = ivec2(gl_FragCoord.xy);
	vec2 largest = vec2(0.0);
	float largestLength = 0.0;

	for(int y = -1; y <= 1; ++y) {

		for(int x = -1; x <= 1; ++x) {

			vec2 v = texelFetch(tileBuffer, clamp(center + ivec2(x, y), ivec2(0), size - 1), 0).xy;
			float l = dot(v, v);

			if(l > largestLength) {

				largestLength = l;
				largest = v;

			}

		}

	}

	out_Color = vec4(largest, 0.0, 1.0);

}
`;

const gatherShader = /* glsl */ `
#include <pp_default_output_pars_fragment>
#include <pp_input_buffer_pars_fragment>

uniform highp sampler2D stateBuffer;
uniform highp sampler2D neighbourBuffer;
uniform int tileSize;
uniform int samples;
uniform bool adaptiveSamples;
uniform float shutter;
uniform float maxBlur;
uniform float softDepth;
uniform float frame;
uniform vec4 bounds;
uniform bool hasMotion;

in vec2 vUv;

vec2 blurVector(vec2 motion) {

	vec2 v = motion * (0.5 * shutter);
	float l = length(v);
	return l > maxBlur ? v * (maxBlur / l) : v;

}

// The background has no depth: infinitely far
float viewDepth(float z) {

	return z > 0.0 ? z : 1e4;

}

// 1 when a is in front of b, fading to 0 when a is softDepth behind it
float inFront(float a, float b) {

	return clamp(1.0 - (a - b) / softDepth, 0.0, 1.0);

}

// Whether a pixel blurring over a distance l reaches d. Cone: tapered streak, cylinder: both blurry and overlapping.
float cone(float d, float l) {

	return clamp(1.0 - d / max(l, 1e-4), 0.0, 1.0);

}

float cylinder(float d, float l) {

	return 1.0 - smoothstep(0.95 * l, 1.05 * l + 1e-4, d);

}

// Interleaved gradient noise (Jimenez 2014), offsets the samples so that their pattern turns into fine noise
float noise(vec2 p) {

	return fract(52.9829189 * fract(dot(p + 5.588238 * frame, vec2(0.06711056, 0.00583715))));

}

void main() {

	// TAA certifies black outside its bounds, the blur reaches at most maxBlur further
	if(any(lessThan(vUv, bounds.xy)) || any(greaterThan(vUv, bounds.zw))) {

		out_Color = vec4(0.0, 0.0, 0.0, 1.0);
		return;

	}

	ivec2 size = textureSize(inputBuffer, 0);
	ivec2 x = ivec2(gl_FragCoord.xy);
	vec3 colorX = texelFetch(inputBuffer, x, 0).rgb;

	vec2 vN = hasMotion ? texelFetch(neighbourBuffer, x / tileSize, 0).xy : vec2(0.0);
	float lengthN = length(vN);

	if(lengthN < 0.5) {

		out_Color = vec4(colorX, 1.0);
		return;

	}

	vec4 stateX = texelFetch(stateBuffer, x, 0);
	vec2 vX = blurVector(stateX.zw);
	float lengthX = length(vX);
	float zX = viewDepth(stateX.x);

	// The pixel's own weight: a sharp pixel dominates its own colour, a blurry one is spread over its streak
	float weight = 1.0 / max(lengthX, 0.5);
	vec3 sum = colorX * weight;

	float j = noise(gl_FragCoord.xy) - 0.5;
	// Jimenez: half of the samples follow the pixel's own motion, so that the blur inside a moving object follows it
	// rather than the fastest motion around, which may point elsewhere
	bool ownDirection = lengthX > 0.5;

	// Adaptive: about one sample per pixel of the longest streak around (2 * lengthN pixels), even, at least 4. A short
	// streak spends the full count on the same few pixels. Each sample then stands for samples / count of them, so the
	// pixel's own weight keeps its share.
	int count = adaptiveSamples ? min(samples, max(4, 2 * int(ceil(lengthN)))) : samples;
	float sampleWeight = float(samples) / float(count);

	for(int i = 0; i < count; ++i) {

		float t = mix(-1.0, 1.0, (float(i) + j + 1.0) / (float(count) + 1.0));
		vec2 direction = (ownDirection && (i & 1) == 1) ? vX : vN;
		vec2 offset = direction * t;
		ivec2 y = clamp(x + ivec2(round(offset)), ivec2(0), size - 1);
		float d = length(offset);

		vec4 stateY = texelFetch(stateBuffer, y, 0);
		float lengthY = length(blurVector(stateY.zw));
		float zY = viewDepth(stateY.x);

		// McGuire et al.: a blurry foreground Y over X, the background Y behind a blurry X, both blurry
		float w = (inFront(zY, zX) * cone(d, lengthY) + inFront(zX, zY) * cone(d, lengthX) +
			cylinder(d, lengthY) * cylinder(d, lengthX) * 2.0) * sampleWeight;

		weight += w;
		sum += texelFetch(inputBuffer, y, 0).rgb * w;

	}

	out_Color = vec4(sum / weight, 1.0);

}
`;

class MotionBlurMaterial extends FullscreenMaterial {

    constructor(name: string, fragmentShader: string, uniforms: Record<string, Uniform>) {

        super({ name, fragmentShader, uniforms });

        // Velocities and HDR colour, see TemporalAAMaterial
        this.outputPrecision = "mediump";
        this.onBeforeCompile = () => {};

    }

}

/**
 * MotionBlurPass options.
 */

export interface MotionBlurPassOptions {

    /**
     * The fraction of the frame time the shutter is open: 0.5 is a 180° film shutter. Higher streaks longer.
     *
     * @defaultValue 0.6
     */

    shutter?: number;

    /**
     * The longest half streak, as a fraction of the output height. Also the tile size.
     *
     * @defaultValue 0.08
     */

    maxBlur?: number;

    /**
     * The number of samples along the streaks. More is smoother and slower.
     *
     * @defaultValue 12
     */

    samples?: number;

    /**
     * Scales the sample count with the streak length, up to {@link samples}: about one sample per pixel of streak, at
     * least 4. Short streaks (slow motion) otherwise spend every sample on the same few pixels.
     *
     * @defaultValue true
     */

    adaptiveSamples?: boolean;

    /**
     * The view depth distance over which a surface goes from "in front" to "behind" another, in scene units.
     *
     * @defaultValue 0.052
     */

    softDepth?: number;

}

/**
 * Motion blur reconstructed from the per-pixel motion of {@link TemporalAAPass}. Add it right after the TAA pass.
 * Disabled passes are skipped by the pipeline, so toggling {@link enabled} costs nothing while off.
 */

export class MotionBlurPass extends Pass<MotionBlurMaterial> {

    /**
     * The bounds outside which the output is black, in UV, for {@link BoundedBloomEffect}. Full screen unless TAA
     * certifies its own.
     */

    readonly backgroundBounds = new Vector4(0, 0, 1, 1);

    private readonly tileMaxXMaterial: MotionBlurMaterial;
    private readonly tileMaxYMaterial: MotionBlurMaterial;
    private readonly neighbourMaxMaterial: MotionBlurMaterial;
    private readonly gatherMaterial: MotionBlurMaterial;
    private readonly tileMaxX: WebGLRenderTarget;
    private readonly tileMax: WebGLRenderTarget;
    private readonly neighbourMax: WebGLRenderTarget;
    private readonly outputBuffer: WebGLRenderTarget;
    private readonly tileSize = new Uniform(1);
    private readonly shutterUniform: Uniform<number>;
    private readonly maxBlurUniform = new Uniform(1);
    private _maxBlur: number;
    private frame = 0;

    /**
     * Constructs a new motion blur pass.
     *
     * @param taa - The TAA pass that provides the motion and depth.
     * @param options - The options.
     */

    constructor(private readonly taa: TemporalAAPass, {
        shutter = 0.6,
        maxBlur = 0.08,
        samples = 12,
        adaptiveSamples = true,
        softDepth = 0.052
    }: MotionBlurPassOptions = {}) {

        super("MotionBlurPass");

        this.shutterUniform = new Uniform(shutter);
        this._maxBlur = maxBlur;

        const shared = { tileSize: this.tileSize, shutter: this.shutterUniform, maxBlur: this.maxBlurUniform };
        this.tileMaxXMaterial = new MotionBlurMaterial("MotionBlurTileMaxXMaterial", tileMaxXShader, {
            ...shared, stateBuffer: new Uniform(null)
        });
        this.tileMaxYMaterial = new MotionBlurMaterial("MotionBlurTileMaxYMaterial", tileMaxYShader, {
            tileSize: this.tileSize, rowBuffer: new Uniform(null)
        });
        this.neighbourMaxMaterial = new MotionBlurMaterial("MotionBlurNeighbourMaxMaterial", neighbourMaxShader, {
            tileBuffer: new Uniform(null)
        });
        this.gatherMaterial = new MotionBlurMaterial("MotionBlurGatherMaterial", gatherShader, {
            ...shared,
            stateBuffer: new Uniform(null),
            neighbourBuffer: new Uniform(null),
            samples: new Uniform(samples),
            adaptiveSamples: new Uniform(adaptiveSamples),
            softDepth: new Uniform(softDepth),
            frame: new Uniform(0),
            bounds: new Uniform(this.backgroundBounds),
            hasMotion: new Uniform(true)
        });

        // Compiled and kept in sync by the pass: every fullscreen material it has used is registered
        this.fullscreenMaterial = this.tileMaxXMaterial;
        this.fullscreenMaterial = this.tileMaxYMaterial;
        this.fullscreenMaterial = this.neighbourMaxMaterial;
        this.fullscreenMaterial = this.gatherMaterial;

        const tileOptions = { type: HalfFloatType, format: RGBAFormat, depthBuffer: false,
            minFilter: NearestFilter, magFilter: NearestFilter };
        this.tileMaxX = new WebGLRenderTarget(1, 1, tileOptions);
        this.tileMax = new WebGLRenderTarget(1, 1, tileOptions);
        this.neighbourMax = new WebGLRenderTarget(1, 1, tileOptions);
        this.disposables.add(this.tileMaxX);
        this.disposables.add(this.tileMax);
        this.disposables.add(this.neighbourMax);

        // Same format as the TAA output, see TemporalAAPass
        this.outputBuffer = new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBFormat, depthBuffer: false });
        this.outputBuffer.texture.internalFormat = "R11F_G11F_B10F";
        this.output.defaultBuffer = this.outputBuffer;

        this.tileMaxYMaterial.uniforms.rowBuffer.value = this.tileMaxX.texture;
        this.neighbourMaxMaterial.uniforms.tileBuffer.value = this.tileMax.texture;
        this.gatherMaterial.uniforms.neighbourBuffer.value = this.neighbourMax.texture;

    }

    /** @see {@link MotionBlurPassOptions.shutter} */
    get shutter(): number {

        return this.shutterUniform.value;

    }

    set shutter(value: number) {

        this.shutterUniform.value = value;

    }

    /** @see {@link MotionBlurPassOptions.maxBlur} */
    get maxBlur(): number {

        return this._maxBlur;

    }

    set maxBlur(value: number) {

        this._maxBlur = value;
        this.onResolutionChange();

    }

    /** @see {@link MotionBlurPassOptions.samples} */
    get samples(): number {

        return this.gatherMaterial.uniforms.samples.value;

    }

    set samples(value: number) {

        this.gatherMaterial.uniforms.samples.value = value;

    }

    /** @see {@link MotionBlurPassOptions.adaptiveSamples} */
    get adaptiveSamples(): boolean {

        return this.gatherMaterial.uniforms.adaptiveSamples.value;

    }

    set adaptiveSamples(value: boolean) {

        this.gatherMaterial.uniforms.adaptiveSamples.value = value;

    }

    /** @see {@link MotionBlurPassOptions.softDepth} */
    get softDepth(): number {

        return this.gatherMaterial.uniforms.softDepth.value;

    }

    set softDepth(value: number) {

        this.gatherMaterial.uniforms.softDepth.value = value;

    }

    protected override onResolutionChange(): void {

        const { width, height } = this.resolution;
        const tile = Math.max(Math.ceil(this._maxBlur * height), 1);
        this.tileSize.value = tile;
        this.maxBlurUniform.value = tile;
        this.tileMaxX.setSize(Math.ceil(width / tile), height);
        this.tileMax.setSize(Math.ceil(width / tile), Math.ceil(height / tile));
        this.neighbourMax.setSize(Math.ceil(width / tile), Math.ceil(height / tile));
        this.outputBuffer.setSize(width, height);

    }

    render(): void {

        const input = this.input.defaultBuffer?.value;

        if(this.renderer === null || input == null) {

            return;

        }

        const taa = this.taa;
        const gather = this.gatherMaterial.uniforms;
        const state = taa.stateTexture;
        // Without TAA there is no motion: pass the image through
        gather.hasMotion.value = taa.enabled;
        gather.frame.value = this.frame++ % 64;
        gather.stateBuffer.value = state;
        this.tileMaxXMaterial.uniforms.stateBuffer.value = state;

        const { width, height } = this.resolution;
        const bounds = this.backgroundBounds.set(0, 0, 1, 1);

        if(taa.enabled && taa.backgroundFastPath && taa.output.defaultBuffer?.value?.texture === input) {

            // The streaks reach at most one tile past whatever TAA wrote
            const tile = this.tileSize.value + 1;
            const source = taa.fullscreenMaterial.uniforms.backgroundBounds.value as Vector4;
            bounds.set(source.x - tile / width, source.y - tile / height, source.z + tile / width, source.w + tile / height);

        }

        if(taa.enabled) {

            this.fullscreenMaterial = this.tileMaxXMaterial;
            this.setRenderTarget(this.tileMaxX);
            this.renderFullscreen();

            this.fullscreenMaterial = this.tileMaxYMaterial;
            this.setRenderTarget(this.tileMax);
            this.renderFullscreen();

            this.fullscreenMaterial = this.neighbourMaxMaterial;
            this.setRenderTarget(this.neighbourMax);
            this.renderFullscreen();

        }

        this.fullscreenMaterial = this.gatherMaterial;
        this.setRenderTarget(this.outputBuffer);
        this.renderFullscreen();

    }

}
