import { Material, Object3D, Uniform, WebGLProgramParametersWithUniforms, WebGLRenderer } from "three";

/**
 * SpecularAntialiasing options.
 */

export interface SpecularAntialiasingOptions {

    /**
     * Controls whether the roughness is widened.
     *
     * @defaultValue true
     */

    enabled?: boolean;

    /**
     * The variance of the screen-space filter kernel, in pixels². Higher widens the highlights more.
     *
     * @defaultValue 0.15
     */

    variance?: number;

    /**
     * The largest roughness² the filter can add, so that flat-shaded creases don't turn fully rough.
     *
     * @defaultValue 0.2
     */

    threshold?: number;

}

/**
 * Geometric specular antialiasing (Tokuyoshi & Kaplanyan 2019, "Improved Geometric Specular Antialiasing"; as in
 * Filament).
 *
 * Where the normal changes a lot within a pixel, e.g. across the tight bevels of the frame, a sharp highlight is
 * narrower than a pixel: shading it once per pixel aliases whatever MSAA and TAA do with the coverage. This widens the
 * roughness by the variance of the normal over the pixel footprint, from screen-space derivatives, so the highlight is
 * prefiltered to what the pixel can show. Unlike {@link GrazingSpecularClamp} it keeps the energy of the reflection,
 * spread over the footprint instead of dimmed.
 *
 * three.js already adds a weaker, max-of-derivatives version of this (geometryRoughness); this one is applied on top
 * and only ever makes surfaces rougher. Settings are uniforms and can be changed at runtime.
 */

export class SpecularAntialiasing {

    private readonly strengthUniform: Uniform<number>;
    private readonly varianceUniform: Uniform<number>;
    private readonly thresholdUniform: Uniform<number>;

    /**
     * Constructs a new specular antialiasing patch.
     *
     * @param options - The options.
     */

    constructor({ enabled = true, variance = 0.15, threshold = 0.2 }: SpecularAntialiasingOptions = {}) {

        this.strengthUniform = new Uniform(enabled ? 1.0 : 0.0);
        this.varianceUniform = new Uniform(variance);
        this.thresholdUniform = new Uniform(threshold);

    }

    get enabled(): boolean {

        return this.strengthUniform.value > 0.0;

    }

    set enabled(value: boolean) {

        this.strengthUniform.value = value ? 1.0 : 0.0;

    }

    get variance(): number {

        return this.varianceUniform.value;

    }

    set variance(value: number) {

        this.varianceUniform.value = value;

    }

    get threshold(): number {

        return this.thresholdUniform.value;

    }

    set threshold(value: number) {

        this.thresholdUniform.value = value;

    }

    /**
     * Makes a physical material widen its roughness by the normal variance.
     *
     * Must be called before the material is compiled, see GrazingSpecularClamp.patchMaterial.
     *
     * @param material - The material.
     */

    patchMaterial(material: Material): void {

        const onBeforeCompile = material.onBeforeCompile;

        material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) => {

            onBeforeCompile.call(material, shader, renderer);

            if(!shader.fragmentShader.includes("#include <lights_physical_fragment>")) {

                return;

            }

            shader.uniforms.specularAAStrength = this.strengthUniform;
            shader.uniforms.specularAAVariance = this.varianceUniform;
            shader.uniforms.specularAAThreshold = this.thresholdUniform;
            shader.fragmentShader = "uniform float specularAAStrength;\n" +
                "uniform float specularAAVariance;\n" +
                "uniform float specularAAThreshold;\n" +
                "float specularAARoughness(float roughness, vec3 n) {\n" +
                "	vec3 du = dFdx(n);\n" +
                "	vec3 dv = dFdy(n);\n" +
                "	float variance = specularAAVariance * (dot(du, du) + dot(dv, dv));\n" +
                "	float kernel = min(2.0 * variance, specularAAThreshold);\n" +
                "	// Perceptual roughness r, GGX alpha = r², filtered alpha² = alpha² + kernel\n" +
                "	float alpha = roughness * roughness;\n" +
                "	float filtered = sqrt(sqrt(min(alpha * alpha + kernel, 1.0)));\n" +
                "	return mix(roughness, max(roughness, filtered), specularAAStrength);\n" +
                "}\n" +
                shader.fragmentShader.replace(
                    "#include <lights_physical_fragment>",
                    `#include <lights_physical_fragment>
					if(specularAAStrength > 0.0) {

						// The shading normal, normal maps included: their variance aliases the same way
						material.roughness = specularAARoughness(material.roughness, normal);

						#ifdef USE_CLEARCOAT

							material.clearcoatRoughness = specularAARoughness(material.clearcoatRoughness, clearcoatNormal);

						#endif

					}`
                );

        };

    }

    /**
     * Patches all materials of an object tree.
     *
     * @param object - The root object.
     */

    prepare(object: Object3D): void {

        object.traverse((child) => {

            if(!("material" in child)) {

                return;

            }

            const materials = (Array.isArray(child.material) ? child.material : [child.material]) as Material[];
            materials.forEach((material) => this.patchMaterial(material));

        });

    }

}
