import { Material, Object3D, Uniform, WebGLProgramParametersWithUniforms, WebGLRenderer } from "three";

/**
 * GrazingSpecularClamp options.
 */

export interface GrazingSpecularClampOptions {

    /**
     * Controls whether the clamp is applied.
     *
     * @defaultValue true
     */

    enabled?: boolean;

    /**
     * The cosine of the view angle below which the clamp fades in: 0 is edge-on, 1 is head-on.
     *
     * @defaultValue 0.5
     */

    angle?: number;

    /**
     * The linear specular luminance above which reflections are compressed, before exposure. Edge-on, reflections
     * approach twice this value. Has to be low to matter: after Reinhard and sRGB, a radiance of 0.1 still displays at
     * ~40% brightness.
     *
     * @defaultValue 0.03
     */

    limit?: number;

}

/**
 * Grazing-angle specular clamp, a form of specular antialiasing.
 *
 * Seen at a grazing angle, a surface is foreshortened to a sliver on screen while Fresnel makes its reflection the
 * brightest: the thin edges of the frame become sub-pixel lines of HDR highlight, which stay jagged whatever the
 * sample count. This compresses the indirect specular above {@link limit} on such surfaces. Not physically based, but
 * neither are the stairs.
 *
 * The angle comes from the face normal, derived from screen-space derivatives of the view position, so normal maps
 * don't make it noisy. Settings are uniforms and can be changed at runtime.
 */

export class GrazingSpecularClamp {

    private readonly strengthUniform: Uniform<number>;
    private readonly angleUniform: Uniform<number>;
    private readonly limitUniform: Uniform<number>;

    /**
     * Constructs a new grazing-angle specular clamp.
     *
     * @param options - The options.
     */

    constructor({ enabled = true, angle = 0.5, limit = 0.03 }: GrazingSpecularClampOptions = {}) {

        this.strengthUniform = new Uniform(enabled ? 1.0 : 0.0);
        this.angleUniform = new Uniform(angle);
        this.limitUniform = new Uniform(limit);

    }

    get enabled(): boolean {

        return this.strengthUniform.value > 0.0;

    }

    set enabled(value: boolean) {

        this.strengthUniform.value = value ? 1.0 : 0.0;

    }

    get angle(): number {

        return this.angleUniform.value;

    }

    set angle(value: number) {

        this.angleUniform.value = value;

    }

    get limit(): number {

        return this.limitUniform.value;

    }

    set limit(value: number) {

        this.limitUniform.value = value;

    }

    /**
     * Makes a lit material clamp its specular at grazing angles.
     *
     * Must be called before the material is added to a scene that a GeometryPass renders, see
     * TonemappedResolvePass.encodeMaterial.
     *
     * @param material - The material.
     */

    patchMaterial(material: Material): void {

        const onBeforeCompile = material.onBeforeCompile;

        material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) => {

            onBeforeCompile.call(material, shader, renderer);

            if(!shader.fragmentShader.includes("#include <lights_fragment_end>")) {

                return;

            }

            shader.uniforms.grazingSpecularStrength = this.strengthUniform;
            shader.uniforms.grazingSpecularAngle = this.angleUniform;
            shader.uniforms.grazingSpecularLimit = this.limitUniform;
            shader.fragmentShader = "uniform float grazingSpecularStrength;\n" +
                "uniform float grazingSpecularAngle;\n" +
                "uniform float grazingSpecularLimit;\n" +
                shader.fragmentShader.replace(
                    "#include <lights_fragment_end>",
                    `#include <lights_fragment_end>
					if(grazingSpecularStrength > 0.0) {

						// Face normal: ignores normal maps and smooth shading, it's the foreshortening that aliases
						vec3 faceNormal = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
						float grazing = 1.0 - smoothstep(0.0, grazingSpecularAngle, abs(dot(faceNormal, geometryViewDir)));

						// Soft knee: unchanged up to the limit, then compressed towards twice the limit
						vec3 specular = reflectedLight.indirectSpecular;
						float l = dot(specular, vec3(0.2126, 0.7152, 0.0722));
						float excess = max(l - grazingSpecularLimit, 0.0);
						float compressed = l - excess + excess / (1.0 + excess / grazingSpecularLimit);
						float scale = l > 0.0 ? compressed / l : 1.0;
						reflectedLight.indirectSpecular *= mix(1.0, scale, grazing * grazingSpecularStrength);

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
