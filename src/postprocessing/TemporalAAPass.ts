import {
    HalfFloatType,
    Matrix4,
    Mesh,
    Object3D,
    OrthographicCamera,
    PerspectiveCamera,
    PlaneGeometry,
    RGBAFormat,
    RGBFormat,
    Scene,
    Uniform,
    Vector2,
    WebGLRenderTarget
} from "three";
import { CopyMaterial, FullscreenMaterial, GBuffer, Pass } from "postprocessing";

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
 * @see https://de45xmedrsdbp.cloudfront.net/Resources/files/TemporalAA_small-59732822.pdf
 * @see https://github.com/playdeadgames/temporal
 */

const fragmentShader = /* glsl */ `
#include <pp_default_output_pars_fragment>
#include <pp_input_buffer_pars_fragment>

uniform highp sampler2D depthBuffer;
uniform sampler2D historyBuffer;

uniform mat4 inverseViewProjectionJittered;
uniform mat4 viewProjection;
uniform mat4 previousViewProjection;
uniform mat4 objectMotion;

uniform vec2 texelSize;
uniform vec2 jitterOffset;
uniform float exposure;
uniform float blend;
uniform float varianceGamma;
uniform bool historyValid;
uniform float filterSharpness;

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

// Where the surface seen at uv was on screen in the previous frame.
vec2 reproject(vec2 uv, float depth) {

	if(depth >= 1.0) {

		// Background, static
		return uv;

	}

	vec4 world = inverseViewProjectionJittered * vec4(vec3(uv, depth) * 2.0 - 1.0, 1.0);
	world /= world.w;

	vec4 current = viewProjection * world;
	vec4 previous = previousViewProjection * (objectMotion * world);
	vec2 velocity = (current.xy / current.w - previous.xy / previous.w) * 0.5;

	return uv - velocity;

}

// Centre and the 4 direct neighbours. A full 3x3 costs 8 more fetches for no measurable gain here.
const ivec2 NEIGHBOURS[5] = ivec2[5](ivec2(0, 0), ivec2(-1, 0), ivec2(1, 0), ivec2(0, -1), ivec2(0, 1));

void main() {

	// Velocity of the closest surface in the neighbourhood. The MSAA depth resolve keeps a single sample, so the depth
	// of a sub-pixel edge is often the background's: without this, thin edges would lag behind as static.
	vec2 closestUv = vUv;
	float closestDepth = 1.0;

	for(int i = 0; i < 5; ++i) {

		vec2 uv = vUv + vec2(NEIGHBOURS[i]) * texelSize;
		float d = texture(depthBuffer, uv).r;

		if(d < closestDepth) {

			closestDepth = d;
			closestUv = uv;

		}

	}

	vec2 historyUv = vUv + (reproject(closestUv, closestDepth) - closestUv);

	vec3 m1 = vec3(0.0);
	vec3 m2 = vec3(0.0);
	vec3 filtered = vec3(0.0);
	float filterWeight = 0.0;

	for(int i = 0; i < 5; ++i) {

		vec3 c = sampleCurrent(NEIGHBOURS[i]);
		m1 += c;
		m2 += c * c;

		// Reconstruct the pixel from the jittered samples around it, weighted by their distance to the pixel centre.
		// Without it, the history converges to a box filter, which leaves faint steps on thin near-horizontal lines.
		// Gaussian, as in Karis 2014. See filterSharpness.
		vec2 d = vec2(NEIGHBOURS[i]) + jitterOffset;
		float w = exp(-filterSharpness * dot(d, d));
		filtered += c * w;
		filterWeight += w;

	}

	vec3 current = filtered / filterWeight;

	bool offscreen = any(lessThan(historyUv, vec2(0.0))) || any(greaterThan(historyUv, vec2(1.0)));

	if(!historyValid || offscreen) {

		out_Color = vec4(decode(YCoCgToRGB(current)), 1.0);
		return;

	}

	vec3 mean = m1 / 5.0;
	vec3 sigma = sqrt(max(m2 / 5.0 - mean * mean, 0.0)) * varianceGamma;

	vec3 history = RGBToYCoCg(encode(sampleHistory(historyUv)));
	history = clipToBox(mean - sigma, mean + sigma, history);

	vec3 result = mix(history, current, blend);
	out_Color = vec4(decode(YCoCgToRGB(result)), 1.0);

}
`;

class TemporalAAMaterial extends FullscreenMaterial {

    constructor(exposure: Uniform<number>) {

        super({
            name: "TemporalAAMaterial",
            fragmentShader,
            uniforms: {
                depthBuffer: new Uniform(null),
                historyBuffer: new Uniform(null),
                inverseViewProjectionJittered: new Uniform(new Matrix4()),
                viewProjection: new Uniform(new Matrix4()),
                previousViewProjection: new Uniform(new Matrix4()),
                objectMotion: new Uniform(new Matrix4()),
                texelSize: new Uniform(new Vector2()),
                jitterOffset: new Uniform(new Vector2()),
                exposure,
                blend: new Uniform(0.2),
                varianceGamma: new Uniform(1.0),
                historyValid: new Uniform(false),
                filterSharpness: new Uniform(5.0)
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

}

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
     * Ping-pong history: one is read while the other is written.
     */

    private readonly history: [WebGLRenderTarget, WebGLRenderTarget];
    private readonly copyMaterial: CopyMaterial;
    private readonly copyScene: Scene;
    private readonly copyCamera: OrthographicCamera;
    private frame: number;

    private readonly projection: Matrix4;
    private readonly viewProjection: Matrix4;
    private readonly previousViewProjection: Matrix4;
    private readonly objectMatrix: Matrix4;
    private readonly previousObjectMatrix: Matrix4;
    private jittered: boolean;

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
        filterSharpness = 5.0
    }: TemporalAAPassOptions = {}) {

        super("TemporalAAPass");

        this.fullscreenMaterial = new TemporalAAMaterial(new Uniform(exposure));
        this.fullscreenMaterial.uniforms.blend.value = blend;
        this.fullscreenMaterial.uniforms.filterSharpness.value = filterSharpness;

        this.input.gBuffer.add(GBuffer.COLOR);
        this.input.gBuffer.add(GBuffer.DEPTH);

        // The history accumulates over many frames, R11G11B10 measurably loses edge quality there. Linear filtering:
        // the 5-tap Catmull-Rom relies on it.
        const historyOptions = { type: HalfFloatType, format: RGBAFormat, depthBuffer: false };
        this.history = [new WebGLRenderTarget(1, 1, historyOptions), new WebGLRenderTarget(1, 1, historyOptions)];
        this.history.forEach((buffer) => this.disposables.add(buffer));

        // The output stays in the 32-bit format of the rest of the pipeline. Passes downstream adopt the format of
        // their input, so RGBA16F here would double the bandwidth of bloom.
        const outputBuffer = new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBFormat, depthBuffer: false });
        outputBuffer.texture.internalFormat = "R11F_G11F_B10F";
        this.output.defaultBuffer = outputBuffer;

        // Copies the history into the output. Writes HDR, see TonemappedResolveMaterial.
        this.copyMaterial = new CopyMaterial();
        this.copyMaterial.colorSpaceConversion = false;
        this.copyMaterial.outputPrecision = "mediump";
        this.copyMaterial.onBeforeCompile = () => {};
        this.disposables.add(this.copyMaterial);

        // Fullscreen quad: the vertex shader of FullscreenMaterial uses the positions as clip coordinates
        const copyQuad = new Mesh(new PlaneGeometry(2, 2), this.copyMaterial);
        copyQuad.frustumCulled = false;
        this.disposables.add(copyQuad.geometry);
        this.copyScene = new Scene().add(copyQuad);
        this.copyCamera = new OrthographicCamera();

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
        this.jittered = false;

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

        return this.fullscreenMaterial.uniforms.blend.value as number;

    }

    set blend(value: number) {

        this.fullscreenMaterial.uniforms.blend.value = value;

    }

    /**
     * Discards the history, e.g. after a cut.
     */

    reset(): void {

        if(this.fullscreenMaterial !== undefined) {

            this.fullscreenMaterial.uniforms.historyValid.value = false;

        }

        // Restart the jitter sequence so that convergence after a reset is deterministic
        this.frame = 0;

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
        this.fullscreenMaterial.uniforms.jitterOffset.value.set(x, y);

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

        this.fullscreenMaterial.uniforms.depthBuffer.value = this.input.getBuffer(GBuffer.DEPTH);

    }

    protected override onResolutionChange(): void {

        const { width, height } = this.resolution;
        this.history.forEach((buffer) => buffer.setSize(width, height));
        this.fullscreenMaterial.uniforms.texelSize.value.set(1.0 / width, 1.0 / height);
        this.reset();

    }

    render(): void {

        const renderer = this.renderer;
        const camera = this.camera;
        const outputBuffer = (this.output.defaultBuffer?.value ?? null) as WebGLRenderTarget | null;

        if(renderer === null || !(camera instanceof PerspectiveCamera) || this.input.defaultBuffer?.value == null) {

            return;

        }

        const uniforms = this.fullscreenMaterial.uniforms;

        // camera.matrixWorldInverse and the object matrix were updated while rendering the geometry
        uniforms.inverseViewProjectionJittered.value
            .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
        this.viewProjection.multiplyMatrices(this.projection, camera.matrixWorldInverse);
        uniforms.viewProjection.value.copy(this.viewProjection);
        uniforms.previousViewProjection.value.copy(this.previousViewProjection);

        if(this.trackedObject !== null) {

            this.objectMatrix.copy(this.trackedObject.matrixWorld);
            uniforms.objectMotion.value.copy(this.objectMatrix).invert().premultiply(this.previousObjectMatrix);

        } else {

            uniforms.objectMotion.value.identity();

        }

        const historyRead = this.history[this.frame % 2];
        const historyWrite = this.history[(this.frame + 1) % 2];
        uniforms.historyBuffer.value = historyRead.texture;

        this.setRenderTarget(historyWrite);
        this.renderFullscreen();

        // copyTexSubImage2D can't convert RGBA16F to R11G11B10, so copy with a draw
        this.copyMaterial.inputBuffer = historyWrite.texture;
        this.setRenderTarget(outputBuffer);
        renderer.render(this.copyScene, this.copyCamera);

        uniforms.historyValid.value = true;
        this.previousViewProjection.copy(this.viewProjection);
        this.previousObjectMatrix.copy(this.objectMatrix);
        this.restoreProjection(camera);
        ++this.frame;

    }

}
