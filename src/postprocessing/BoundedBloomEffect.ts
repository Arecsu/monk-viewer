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
import type { MotionBlurPass } from "./MotionBlurPass.js";

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
 * BoundedBloomEffect options.
 */
export interface BoundedBloomEffectOptions extends BloomEffectOptions {

    /**
     * The output height at which {@link BloomEffectOptions.levels} applies as is. The bloom keeps the same reach,
     * relative to the screen, at any other resolution.
     *
     * @defaultValue 1800
     */
    referenceHeight?: number;

}

/**
 * Stock v7 BloomEffect composition with bounded luminance/downsampling. Upsampling, formats, thresholds and radius
 * are unchanged. No depth-based mask: the source bounds also include the glass.
 *
 * Resolution independent: the stock mip chain halves the input a fixed number of times, so its reach is fixed in
 * pixels and shrinks on screen as the render scale or the pixel ratio grows. With a radius of 1 the bloom is the
 * coarsest mip blurred back up, so the reach is the screen over that mip's height. The level count follows the
 * resolution, and the luminance pass resamples by less than 2x so that the coarsest mip is always the same height.
 */
export class BoundedBloomEffect extends Effect {

    readonly luminancePass: LuminancePass;
    readonly mipmapBlurPass: MipmapBlurPass;
    backgroundFastPath = true;

    private readonly bounds = new Uniform(new Vector4(0, 0, 1, 1));
    private readonly boundsSource: TemporalAAPass | null;

    /**
     * A motion blur pass between TAA and bloom. Its output is black outside its own bounds, which only extend TAA's.
     */

    motionBlurSource: MotionBlurPass | null = null;

    /** @see {@link BoundedBloomEffectOptions.referenceHeight} */
    referenceHeight: number;

    private readonly referenceLevels: number;

    constructor(boundsSource: TemporalAAPass | null, {
        luminanceThreshold = 1,
        luminanceSmoothing = 0.03,
        intensity = 1,
        referenceHeight = 1800,
        ...blurOptions
    }: BoundedBloomEffectOptions = {}) {

        super("BloomEffect");
        this.boundsSource = boundsSource;
        this.referenceHeight = referenceHeight;
        this.referenceLevels = blurOptions.levels ?? 8;
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

    /**
     * Keeps the coarsest mip at referenceHeight / 2^levels pixels, see the class description.
     */
    private updateScale(): void {

        const height = this.resolution.height;
        if(height <= 0) return;

        const target = this.referenceHeight / 2 ** this.referenceLevels;
        const luminance = this.luminancePass;
        const blur = this.mipmapBlurPass;
        // Without the luminance pass the chain reads the input directly and can only round to the nearest level
        const levels = Math.max(luminance.enabled ? Math.floor(Math.log2(height / target)) :
            Math.round(Math.log2(height / target)), 1);
        // In (0.5, 1]: a bilinear resample by less than 2x still reads every source texel
        const scale = luminance.enabled ? Math.min(target * 2 ** levels / height, 1) : 1;

        const resized = luminance.resolution.scale !== scale;
        if(resized) luminance.resolution.scale = scale;

        if(blur.levels !== levels) {
            blur.levels = levels;
        } else if(resized) {
            // The chain sizes its mips from its input texture, which only the luminance pass knows has changed
            (blur as unknown as { onResolutionChange(): void }).onResolutionChange();
        }

    }

    override render(): void {

        const bounds = this.bounds.value.set(0, 0, 1, 1);
        const source = this.boundsSource;
        const blur = this.motionBlurSource;
        const input = this.input.defaultBuffer?.value;
        const blurBuffer = blur?.output.defaultBuffer?.value;
        let sourceBuffer = source?.output.defaultBuffer?.value;

        // Only TAA's actual output is certified black outside these bounds. Disabling TAA, inserting another pass,
        // fog or a different background must never crop new signal. TAA already expands unsafe cases to full screen.
        // The motion blur extends them by its reach, and keeps them full screen unless it read TAA's output.
        if(this.backgroundFastPath && blur?.enabled && blurBuffer != null && blurBuffer.texture === input) {
            sourceBuffer = blurBuffer;
            bounds.copy(blur.backgroundBounds);
        } else if(this.backgroundFastPath && source?.enabled && source.backgroundFastPath &&
            sourceBuffer != null && sourceBuffer.texture === input) {
            bounds.copy(source.fullscreenMaterial.uniforms.backgroundBounds.value);
        } else {
            sourceBuffer = undefined;
        }

        if(sourceBuffer != null) {
            const { width, height } = sourceBuffer;
            if(width > 0 && height > 0) {
                // Luminance may run at a different resolution: linear sampling reaches one original source texel.
                bounds.x -= 1 / width;
                bounds.y -= 1 / height;
                bounds.z += 1 / width;
                bounds.w += 1 / height;
            } else {
                bounds.set(0, 0, 1, 1);
            }
        }

        this.updateScale();
        if(this.luminancePass.enabled) this.luminancePass.render();
        this.mipmapBlurPass.render();

    }

}
