import { Uniform, Vector4 } from "three";
import {
    AddBlendFunction,
    DownsamplingMaterial,
    Effect,
    FullscreenMaterial,
    LuminancePass,
    MipmapBlurPass
} from "postprocessing";
import type { BloomEffectOptions, MipmapBlurPassOptions } from "postprocessing";
import type { TemporalAAPass } from "./TemporalAAPass.js";

/**
 * Each stock downsample reaches at most 3 source texels (2-tap offset + bilinear footprint).
 * With rounded half sizes, preceding sizes are >= 2^k * (m - 1) + 1. The accumulated UV reach is
 * < 6 / (m - 1), bounded by 8 / m for m >= 4. For smaller m, 8 / m covers the entire image.
 * This deliberately overestimates support: odd sizes and additional levels cannot clip the halo.
 */
export const BLOOM_DOWNSAMPLE_PADDING = 8;

/** Retains the stock filter/precision; only known-zero output pixels take the early return. */
export function boundBloomShader(shader: string, padding: number): string {

    const main = /void\s+main\s*\(\s*\)\s*\{/;
    if(!main.test(shader)) throw new Error("Unsupported postprocessing bloom shader: main() not found");
    return "uniform vec4 boundedBloomBounds;\n" + shader.replace(main, `void main() {
        vec2 padding = vec2(${padding.toFixed(1)}) / vec2(textureSize(inputBuffer, 0));
        if(any(lessThan(vUv, boundedBloomBounds.xy - padding)) ||
            any(greaterThan(vUv, boundedBloomBounds.zw + padding))) {
            out_Color = vec4(0.0);
            return;
        }
    `);

}

function boundMaterial(material: FullscreenMaterial, bounds: Uniform<Vector4>, padding: number): void {

    material.uniforms.boundedBloomBounds = bounds;
    material.fragmentShader = boundBloomShader(material.fragmentShader, padding);
    material.needsUpdate = true;

}

class BoundedMipmapBlurPass extends MipmapBlurPass {

    constructor(bounds: Uniform<Vector4>, options: MipmapBlurPassOptions) {

        super(options);
        // Use the public/protected material collection, not MipmapBlurPass's private implementation fields.
        const downsample = [...this.materials].find((material) => material instanceof DownsamplingMaterial);
        if(downsample === undefined) throw new Error("Unsupported postprocessing bloom: no downsampling material");
        boundMaterial(downsample, bounds, BLOOM_DOWNSAMPLE_PADDING);

    }

}

const fragmentShader = /* glsl */ `
#ifdef FRAMEBUFFER_PRECISION_HIGH
uniform mediump sampler2D map;
#else
uniform lowp sampler2D map;
#endif
uniform float intensity;
vec4 mainImage(const in vec4 inputColor, const in vec2 uv, const in GData gData) {
    return texture(map, uv) * intensity;
}
`;

/**
 * Stock v7 BloomEffect composition with bounded luminance/downsampling. Upsampling, formats, thresholds,
 * radius and level count are unchanged. No depth-based mask: the source bounds also include the glass.
 */
export class BoundedBloomEffect extends Effect {

    readonly luminancePass: LuminancePass;
    readonly mipmapBlurPass: MipmapBlurPass;
    backgroundFastPath = true;

    private readonly bounds = new Uniform(new Vector4(0, 0, 1, 1));
    private readonly boundsSource: TemporalAAPass | null;

    constructor(boundsSource: TemporalAAPass | null, {
        luminanceThreshold = 1,
        luminanceSmoothing = 0.03,
        intensity = 1,
        ...blurOptions
    }: BloomEffectOptions = {}) {

        super("BloomEffect");
        this.boundsSource = boundsSource;
        this.fragmentShader = fragmentShader;
        this.blendMode.blendFunction = new AddBlendFunction();

        this.luminancePass = new LuminancePass();
        this.luminancePass.addEventListener("toggle", () => this.onInputChange());
        this.luminanceMaterial.threshold = luminanceThreshold;
        this.luminanceMaterial.smoothing = luminanceSmoothing;
        boundMaterial(this.luminanceMaterial, this.bounds, 0);

        this.mipmapBlurPass = new BoundedMipmapBlurPass(this.bounds, blurOptions);
        this.input.uniforms.set("intensity", new Uniform(intensity));
        this.input.uniforms.set("map", new Uniform(null));
        this.mipmapBlurPass.texture.bindUniform(this.input.uniforms.get("map")!);
        this.subpasses = [this.luminancePass, this.mipmapBlurPass];

    }

    get luminanceMaterial() { return this.luminancePass.fullscreenMaterial; }
    get luminanceThreshold() { return this.luminanceMaterial.threshold; }
    set luminanceThreshold(value: number) { this.luminanceMaterial.threshold = value; }
    get luminanceSmoothing() { return this.luminanceMaterial.smoothing; }
    set luminanceSmoothing(value: number) { this.luminanceMaterial.smoothing = value; }
    get intensity() { return this.input.uniforms.get("intensity")!.value as number; }
    set intensity(value: number) { this.input.uniforms.get("intensity")!.value = value; }

    protected override onInputChange(): void {

        if(this.input.defaultBuffer === null) {
            this.luminancePass.input.removeDefaultBuffer();
            this.mipmapBlurPass.input.removeDefaultBuffer();
            return;
        }
        this.luminancePass.input.defaultBuffer = this.input.defaultBuffer;
        this.mipmapBlurPass.input.defaultBuffer = this.luminancePass.enabled ?
            this.luminancePass.texture : this.input.defaultBuffer;

    }

    override render(): void {

        const bounds = this.bounds.value.set(0, 0, 1, 1);
        const source = this.boundsSource;
        const sourceBuffer = source?.output.defaultBuffer?.value;
        const input = this.input.defaultBuffer?.value;

        // Only TAA's actual output is certified black outside these bounds. Disabling TAA, inserting another pass,
        // fog or a different background must never crop new signal. TAA already expands unsafe cases to full screen.
        if(this.backgroundFastPath && source?.enabled && source.backgroundFastPath &&
            sourceBuffer != null && sourceBuffer.texture === input) {
            const { width, height } = sourceBuffer;
            if(width > 0 && height > 0) {
                bounds.copy(source.fullscreenMaterial.uniforms.backgroundBounds.value);
                // Luminance may run at a different resolution: linear sampling reaches one original source texel.
                bounds.x -= 1 / width;
                bounds.y -= 1 / height;
                bounds.z += 1 / width;
                bounds.w += 1 / height;
            }
        }

        if(this.luminancePass.enabled) this.luminancePass.render();
        this.mipmapBlurPass.render();

    }

}
