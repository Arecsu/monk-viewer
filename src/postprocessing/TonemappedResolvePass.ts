import {
    Camera,
    Color,
    HalfFloatType,
    Material,
    Object3D,
    RGBFormat,
    Scene,
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
 * HDR with the exact inverse `c = E / (k(1 - E))`, so bloom and tone mapping see the usual values.
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

const decodeFragmentShader = /* glsl */ `
#include <pp_default_output_pars_fragment>
#include <pp_input_buffer_pars_fragment>

uniform float exposure;

in vec2 vUv;

void main() {

	highp vec3 e = min(texture(inputBuffer, vUv).rgb, vec3(${MAX_ENCODED}));
	out_Color = vec4(e / (exposure * (1.0 - e)), 1.0);

}
`;

class TonemappedResolveMaterial extends FullscreenMaterial {

    constructor(exposure: Uniform<number>) {

        super({
            name: "TonemappedResolveMaterial",
            fragmentShader: decodeFragmentShader,
            uniforms: { exposure }
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
     * The layer that holds transparent objects. Objects on this layer must not be visible to the main camera layers.
     *
     * @defaultValue 1
     */

    layer?: number;

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
     * Constructs a new tonemapped resolve pass.
     *
     * @param options - The options.
     */

    constructor({ exposure = 1.0, layer = 1 }: TonemappedResolvePassOptions = {}) {

        super("TonemappedResolvePass");

        this.layer = layer;
        this.exposureUniform = new Uniform(exposure);
        this.fullscreenMaterial = new TonemappedResolveMaterial(this.exposureUniform);

        // The geometry pass depth is needed to depth test transparent objects against the opaque ones.
        this.input.gBuffer.add(GBuffer.COLOR);
        this.input.gBuffer.add(GBuffer.DEPTH);

        // Same format as the HDR colour buffer of the geometry pass. The default framebuffer is 8-bit and would clamp
        // the decoded values to 1.
        const outputBuffer = new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBFormat, depthBuffer: true });
        outputBuffer.texture.internalFormat = "R11F_G11F_B10F";
        this.output.defaultBuffer = outputBuffer;

    }

    /**
     * The tone mapping exposure that the encoding matches.
     */

    get exposure(): number {

        return this.exposureUniform.value;

    }

    set exposure(value: number) {

        this.exposureUniform.value = value;

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
        const encode = (c: number) => (Math.max(c, 0.0) * k) / (1.0 + Math.max(c, 0.0) * k);
        return target.setRGB(encode(color.r), encode(color.g), encode(color.b));

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
        const onBeforeCompile = material.onBeforeCompile;

        material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) => {

            onBeforeCompile.call(material, shader, renderer);

            if(!shader.fragmentShader.includes("#include <dithering_fragment>")) {

                console.warn(`${material.name}: no <dithering_fragment>, skipping tonemapped resolve encoding`);
                return;

            }

            shader.uniforms.tonemappedResolveExposure = exposure;
            shader.fragmentShader = "uniform float tonemappedResolveExposure;\n" + shader.fragmentShader.replace(
                "#include <dithering_fragment>",
                `#include <dithering_fragment>
				gl_FragColor.rgb = max(gl_FragColor.rgb, 0.0) * tonemappedResolveExposure;
				gl_FragColor.rgb /= 1.0 + gl_FragColor.rgb;`
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

        }

    }

    protected override onInputChange(): void {

        this.updateDepthTexture();

    }

    protected override onOutputChange(): void {

        this.updateDepthTexture();

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

        camera.layers.mask = mask;
        scene.background = background;
        renderer.autoClear = autoClear;

    }

}
