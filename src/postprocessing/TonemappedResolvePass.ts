import {
    Camera,
    Color,
    DoubleSide,
    HalfFloatType,
    Material,
    Object3D,
    RedFormat,
    RGBFormat,
    Scene,
    ShaderMaterial,
    Texture,
    Uniform,
    WebGLProgramParametersWithUniforms,
    WebGLRenderer,
    WebGLRenderTarget
} from "three";
import { FullscreenMaterial, GBuffer, Pass } from "postprocessing";

/**
 * Tonemapped MSAA resolve.
 *
 * Hardware MSAA averages samples in linear HDR. A pixel half covered by a highlight of 8.0 resolves to 4.0, which
 * still tonemaps to pure white, so bright edges stay jagged no matter how many samples are taken.
 *
 * Opaque materials therefore write `E(c) = kc / (1 + kc)` per channel. With `k` matching the exposure of the final
 * Reinhard tone mapping, the hardware resolve averages exactly what ends up on screen. This pass then restores linear
 * HDR with the exact inverse `c = E / (k(1 - E))`, so bloom and tone mapping see the usual values. With another tone
 * mapping (GT7) it is an approximation: the encoding has to stay invertible, a curve that clips to white can't.
 *
 * {@link TonemappedResolvePass.encoding} picks the curve: per channel as above, on the largest channel
 * (`E(c) = kc / (1 + k max(c))`, Karis 2013: keeps the hue of coloured edges) or none (plain linear MSAA).
 *
 * Blending doesn't commute with the encoding, so transparent objects are excluded from the main geometry pass (see
 * {@link TonemappedResolvePass.layer}) and drawn here, on top of the decoded colour, with regular linear blending.
 *
 * @see https://graphicrants.blogspot.com/2013/12/tone-mapping.html
 * @see https://therealmjp.github.io/posts/msaa-resolve-filters/
 */

/**
 * The largest encoded value that is decoded. Keeps `1 - E` away from 0.
 */

const MAX_ENCODED = "0.9995";

/**
 * The tonemapped resolve curves, see {@link TonemappedResolvePass.encoding}.
 */

export type TonemappedResolveEncoding = "linear" | "rgb" | "max";

const ENCODINGS: TonemappedResolveEncoding[] = ["linear", "rgb", "max"];

const decodeFragmentShader = /* glsl */ `
#include <pp_default_output_pars_fragment>
#include <pp_input_buffer_pars_fragment>

uniform float exposure;
uniform int encoding;

in vec2 vUv;

void main() {

	highp vec3 e = texture(inputBuffer, vUv).rgb;

	if(encoding == 1) {

		e = min(e, vec3(${MAX_ENCODED}));
		out_Color = vec4(e / (exposure * (1.0 - e)), 1.0);

	} else if(encoding == 2) {

		out_Color = vec4(e / (exposure * (1.0 - min(max(e.r, max(e.g, e.b)), ${MAX_ENCODED}))), 1.0);

	} else {

		out_Color = vec4(e / exposure, 1.0);

	}

}
`;

/**
 * Writes 1 where a transparent surface faces the camera, fading to 0 edge-on: the thin edges of a glass pane alias like
 * any other edge and keep their temporal antialiasing. See {@link TonemappedResolvePass.reactiveMask}.
 */

const reactiveMaskMaterial = () => new ShaderMaterial({
    name: "ReactiveMaskMaterial",
    vertexShader: /* glsl */ `
		varying vec3 vViewPosition;

		void main() {

			vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
			vViewPosition = -mvPosition.xyz;
			gl_Position = projectionMatrix * mvPosition;

		}
	`,
    fragmentShader: /* glsl */ `
		varying vec3 vViewPosition;

		void main() {

			vec3 faceNormal = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
			float facing = abs(dot(faceNormal, normalize(vViewPosition)));
			gl_FragColor = vec4(smoothstep(0.1, 0.3, facing), 0.0, 0.0, 1.0);

		}
	`,
    side: DoubleSide,
    depthWrite: false
});

class TonemappedResolveMaterial extends FullscreenMaterial {

    constructor(exposure: Uniform<number>, encoding: Uniform<number>) {

        super({
            name: "TonemappedResolveMaterial",
            fragmentShader: decodeFragmentShader,
            uniforms: { exposure, encoding }
        });

        // FullscreenMaterial drops to lowp when compiled while the canvas is bound, which RenderPipeline.compile()
        // does. lowp is only guaranteed to hold [-2, 2] and this material always writes HDR to a half float buffer.
        this.outputPrecision = "mediump";
        this.onBeforeCompile = () => {};

    }

}

/**
 * TonemappedResolvePass options.
 */

export interface TonemappedResolvePassOptions {

    /**
     * The tone mapping exposure that the encoding should match.
     *
     * @defaultValue 1.0
     */

    exposure?: number;

    /**
     * The curve the samples are averaged through, see {@link TonemappedResolvePass.encoding}.
     *
     * @defaultValue "rgb"
     */

    encoding?: TonemappedResolveEncoding;

    /**
     * The layer that holds transparent objects. Objects on this layer must not be visible to the main camera layers.
     *
     * @defaultValue 1
     */

    layer?: number;

    /**
     * Controls whether {@link TonemappedResolvePass.reactiveMask} is rendered.
     *
     * @defaultValue false
     */

    reactiveMask?: boolean;

}

/**
 * Decodes the tonemapped MSAA resolve back to linear HDR and renders transparent objects on top.
 *
 * Must be added right after the main {@link GeometryPass}.
 */

export class TonemappedResolvePass extends Pass<TonemappedResolveMaterial> {

    /**
     * The layer that holds transparent objects.
     */

    readonly layer: number;

    /**
     * The exposure shared by the encoding in scene materials and the decoding in this pass.
     */

    private readonly exposureUniform: Uniform<number>;

    /**
     * The index of the encoding in {@link ENCODINGS}, shared like the exposure.
     */

    private readonly encodingUniform: Uniform<number>;

    /**
     * Controls whether {@link reactiveMask} is rendered. It costs one more draw of the transparent objects.
     */

    reactiveMaskEnabled: boolean;

    private readonly reactiveMaskBuffer: WebGLRenderTarget;
    private readonly reactiveMaskMaterial: ShaderMaterial;
    private readonly clearColor = new Color();

    /**
     * Constructs a new tonemapped resolve pass.
     *
     * @param options - The options.
     */

    constructor({ exposure = 1.0, encoding = "rgb", layer = 1, reactiveMask = false }: TonemappedResolvePassOptions = {}) {

        super("TonemappedResolvePass");

        this.layer = layer;
        this.exposureUniform = new Uniform(exposure);
        this.encodingUniform = new Uniform(ENCODINGS.indexOf(encoding));
        this.fullscreenMaterial = new TonemappedResolveMaterial(this.exposureUniform, this.encodingUniform);

        // The geometry pass depth is needed to depth test transparent objects against the opaque ones.
        this.input.gBuffer.add(GBuffer.COLOR);
        this.input.gBuffer.add(GBuffer.DEPTH);

        // Same format as the HDR colour buffer of the geometry pass. The default framebuffer is 8-bit and would clamp
        // the decoded values to 1.
        const outputBuffer = new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBFormat, depthBuffer: true });
        outputBuffer.texture.internalFormat = "R11F_G11F_B10F";
        this.output.defaultBuffer = outputBuffer;

        // Depth tested against the opaque geometry like the transparent objects themselves, see updateDepthTexture
        this.reactiveMaskEnabled = reactiveMask;
        this.reactiveMaskBuffer = new WebGLRenderTarget(1, 1, { format: RedFormat, depthBuffer: true });
        this.reactiveMaskMaterial = reactiveMaskMaterial();
        this.disposables.add(this.reactiveMaskBuffer);
        this.disposables.add(this.reactiveMaskMaterial);

    }

    /**
     * Where the transparent objects cover the image, for {@link TemporalAAPass.reactiveMask}: 1 where they face the
     * camera, 0 edge-on and elsewhere. Only rendered while {@link reactiveMaskEnabled}.
     */

    get reactiveMask(): Texture {

        return this.reactiveMaskBuffer.texture;

    }

    /**
     * The tone mapping exposure that the encoding matches. Higher compresses the highlights harder before the resolve
     * averages them: smoother bright edges, but dark edges average less like they look on screen.
     */

    get exposure(): number {

        return this.exposureUniform.value;

    }

    set exposure(value: number) {

        this.exposureUniform.value = value;

    }

    /**
     * The curve the MSAA samples are averaged through: "rgb" per channel, "max" on the largest channel (keeps the hue
     * of coloured edges, compresses the other channels by the brightest one), "linear" for plain MSAA. Background
     * clear colours encoded with {@link encodeColor} must be encoded again after a change, black needs nothing.
     */

    get encoding(): TonemappedResolveEncoding {

        return ENCODINGS[this.encodingUniform.value];

    }

    set encoding(value: TonemappedResolveEncoding) {

        this.encodingUniform.value = ENCODINGS.indexOf(value);

    }

    /**
     * Encodes a colour the same way {@link encodeMaterial} encodes fragments. Use it for clear colours.
     *
     * @param color - A linear colour.
     * @param target - A colour to store the result in.
     * @return The encoded colour.
     */

    encodeColor(color: Color, target = new Color()): Color {

        const k = this.exposure;
        const [r, g, b] = [color.r, color.g, color.b].map((c) => Math.max(c, 0.0) * k);
        const encoding = this.encoding;
        const encode = (c: number) => encoding === "rgb" ? c / (1.0 + c) : encoding === "max" ? c / (1.0 + Math.max(r, g, b)) : c;
        return target.setRGB(encode(r), encode(g), encode(b));

    }

    /**
     * Makes an opaque material write encoded colour.
     *
     * Must be called before the material is added to a scene that a {@link GeometryPass} renders, so that the G-Buffer
     * shader plugin wraps this hook instead of being replaced by it.
     *
     * @param material - The material.
     */

    encodeMaterial(material: Material): void {

        const exposure = this.exposureUniform;
        const encoding = this.encodingUniform;
        const onBeforeCompile = material.onBeforeCompile;

        material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) => {

            onBeforeCompile.call(material, shader, renderer);

            if(!shader.fragmentShader.includes("#include <dithering_fragment>")) {

                console.warn(`${material.name}: no <dithering_fragment>, skipping tonemapped resolve encoding`);
                return;

            }

            shader.uniforms.tonemappedResolveExposure = exposure;
            shader.uniforms.tonemappedResolveEncoding = encoding;
            shader.fragmentShader = "uniform float tonemappedResolveExposure;\nuniform int tonemappedResolveEncoding;\n" +
                shader.fragmentShader.replace(
                    "#include <dithering_fragment>",
                    `#include <dithering_fragment>
				gl_FragColor.rgb = max(gl_FragColor.rgb, 0.0) * tonemappedResolveExposure;
				if(tonemappedResolveEncoding == 1) gl_FragColor.rgb /= 1.0 + gl_FragColor.rgb;
				else if(tonemappedResolveEncoding == 2) gl_FragColor.rgb /= 1.0 + max(gl_FragColor.r, max(gl_FragColor.g, gl_FragColor.b));`
                );

        };

    }

    /**
     * Prepares the materials and layers of an object tree: opaque materials are encoded, transparent meshes are moved
     * to {@link layer}.
     *
     * @param object - The root object.
     */

    prepare(object: Object3D): void {

        object.traverse((child) => {

            if(!("material" in child)) {

                return;

            }

            const materials = (Array.isArray(child.material) ? child.material : [child.material]) as Material[];

            if(materials.some((material) => material.transparent)) {

                child.layers.set(this.layer);

            } else {

                materials.forEach((material) => this.encodeMaterial(material));

            }

        });

    }

    private get outputBuffer(): WebGLRenderTarget | null {

        return (this.output.defaultBuffer?.value as WebGLRenderTarget | null | undefined) ?? null;

    }

    /**
     * Shares the depth texture of the main geometry pass with the output buffer.
     *
     * The render target must not be disposed here: three disposes the depth texture along with it. Three rebinds a
     * changed depth texture on its own.
     */

    private updateDepthTexture(): void {

        const outputBuffer = this.outputBuffer;
        const depthTexture = this.input.getBuffer(GBuffer.DEPTH) as Texture | null;

        if(outputBuffer !== null && depthTexture !== null) {

            outputBuffer.depthTexture = depthTexture as WebGLRenderTarget["depthTexture"];
            this.reactiveMaskBuffer.depthTexture = depthTexture as WebGLRenderTarget["depthTexture"];

        }

    }

    protected override onInputChange(): void {

        this.updateDepthTexture();

    }

    protected override onOutputChange(): void {

        this.updateDepthTexture();

    }

    protected override onResolutionChange(): void {

        // setSize() disposes the target, and disposing a target disposes its depth texture: detach the shared one first
        const buffer = this.reactiveMaskBuffer;
        const depthTexture = buffer.depthTexture;
        buffer.depthTexture = null;
        buffer.setSize(this.resolution.width, this.resolution.height);
        buffer.depthTexture = depthTexture;

    }

    render(): void {

        const renderer = this.renderer;

        if(renderer === null || this.input.defaultBuffer?.value == null) {

            return;

        }

        this.setRenderTarget(this.outputBuffer);
        this.renderFullscreen();

        const scene: Scene | null = this.scene;
        const camera: Camera | null = this.camera;

        if(scene === null || camera === null) {

            return;

        }

        const mask = camera.layers.mask;
        const background = scene.background;
        const autoClear = renderer.autoClear;

        camera.layers.set(this.layer);
        scene.background = null;
        renderer.autoClear = false;

        renderer.render(scene, camera);

        if(this.reactiveMaskEnabled) {

            const clearAlpha = renderer.getClearAlpha();
            renderer.getClearColor(this.clearColor);
            renderer.setClearColor(0x000000, 0.0);
            this.setRenderTarget(this.reactiveMaskBuffer);
            renderer.clear(true, false, false);
            renderer.setClearColor(this.clearColor, clearAlpha);

            const overrideMaterial = scene.overrideMaterial;
            scene.overrideMaterial = this.reactiveMaskMaterial;
            renderer.render(scene, camera);
            scene.overrideMaterial = overrideMaterial;

        }

        camera.layers.mask = mask;
        scene.background = background;
        renderer.autoClear = autoClear;

    }

}
