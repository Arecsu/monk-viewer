import {
    Camera,
    HalfFloatType,
    Material,
    Matrix4,
    Mesh,
    NearestFilter,
    Object3D,
    RGBAFormat,
    Uniform,
    WebGLProgramParametersWithUniforms,
    WebGLRenderer
} from "three";
import type { ClearPass, GeometryPass } from "postprocessing";

/**
 * The name of the velocity G-Buffer component. Shaders write it as `out_Velocity`.
 */

export const VELOCITY = "Velocity";

interface MeshState {

    readonly previous: Uniform<Matrix4>;
    readonly last: Matrix4;
    frame: number;

}

/**
 * Per-object velocity, written by the geometry pass into an extra G-Buffer attachment.
 *
 * Every mesh is transformed twice in its vertex shader, with the current and with the previous frame's model and
 * view-projection matrices, both unjittered. The fragment writes the screen motion between them in UV units, current
 * minus previous, and the relative change of view depth, previous / current - 1. That covers camera motion, every
 * object, and children animated relative to their parents, which a single rigid transform can't.
 *
 * The depth change lets TAA tell a surface from another one a few millimetres behind it, e.g. the print uncovered by a
 * sliding clip: see TemporalAAPassOptions.depthTolerance. As a ratio it is tiny, so half floats keep it precise, and
 * the MSAA resolve averaging it with the background's 0 at an edge only halves an already small change.
 *
 * Not covered: skinning and morph targets (the previous frame's deformation isn't kept, only the transform moves) and
 * instancing. Transparent objects that don't write depth don't write velocity either: their pixels move with whatever
 * is behind them.
 *
 * Materials are made unique per mesh, since the previous model matrix is a per-mesh uniform: call {@link prepare}
 * before any other material patch.
 */

export class VelocityBuffer {

    private readonly viewProjection = new Uniform(new Matrix4());
    private readonly previousViewProjection = new Uniform(new Matrix4());
    private readonly states = new WeakMap<Object3D, MeshState>();
    private frame = 0;
    private initialized = false;
    private moved = false;

    /**
     * Whether any mesh drawn this frame moved since the previous one, camera aside. Valid once the geometry has been
     * rendered. TAA must not treat the frame as still then, even if the camera and its tracked object are.
     */

    get meshesMoved(): boolean {

        return this.moved;

    }

    /**
     * Adds the velocity component to a geometry pass and clears it to "no motion" with the given clear pass.
     *
     * @param geometryPass - The main geometry pass.
     * @param clearPass - The clear pass of its buffer.
     */

    register(geometryPass: GeometryPass, clearPass: ClearPass): void {

        // xy: the motion, z: the change of view depth. Half float: sub-pixel motion needs the precision. Nearest:
        // velocities don't interpolate across edges. RGBA because RGB half float isn't renderable.
        geometryPass.gBufferConfig.textureConfigs.set(VELOCITY, {
            minFilter: NearestFilter,
            magFilter: NearestFilter,
            type: HalfFloatType,
            format: RGBAFormat
        });

        clearPass.clearValues.gBuffer.set(VELOCITY, [0, 0, 0, 0]);
        clearPass.clearFlags.gBuffer.add(VELOCITY);

    }

    /**
     * Starts a frame. Call once per frame, before the geometry is rendered, with the unjittered projection.
     *
     * @param camera - The camera.
     * @param projection - Its unjittered projection matrix.
     */

    update(camera: Camera, projection: Matrix4): void {

        // The renderer only updates the camera while rendering, after this
        camera.updateMatrixWorld();

        const current = this.viewProjection.value;
        this.previousViewProjection.value.copy(current);
        current.multiplyMatrices(projection, camera.matrixWorldInverse);

        if(!this.initialized) {

            this.previousViewProjection.value.copy(current);
            this.initialized = true;

        }

        ++this.frame;
        this.moved = false;

    }

    /**
     * Makes the meshes of an object tree write their velocity. Shared materials are cloned so that every mesh has its
     * own.
     *
     * @param object - The root object.
     */

    prepare(object: Object3D): void {

        const claimed = new Set<Material>();

        object.traverse((child) => {

            if(!(child instanceof Mesh)) {

                return;

            }

            const unique = (material: Material) => {

                const result = claimed.has(material) ? material.clone() : material;
                claimed.add(result);
                return result;

            };

            child.material = Array.isArray(child.material) ? child.material.map(unique) : unique(child.material);
            this.track(child);

        });

    }

    private track(mesh: Mesh): void {

        const state: MeshState = { previous: new Uniform(new Matrix4()), last: new Matrix4(), frame: -1 };
        this.states.set(mesh, state);

        // matrixWorld is up to date here. A mesh that wasn't drawn last frame (culled, hidden) restarts from rest
        // instead of jumping from wherever it was last seen.
        const onBeforeRender = mesh.onBeforeRender;
        mesh.onBeforeRender = (...args) => {

            onBeforeRender.apply(mesh, args);

            if(state.frame !== this.frame) {

                state.previous.value.copy(state.frame === this.frame - 1 ? state.last : mesh.matrixWorld);
                state.last.copy(mesh.matrixWorld);
                state.frame = this.frame;
                this.moved ||= !state.previous.value.equals(mesh.matrixWorld);

            }

        };

        const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as Material[];
        materials.forEach((material) => this.patchMaterial(material, state.previous));

    }

    private patchMaterial(material: Material, previousModelMatrix: Uniform<Matrix4>): void {

        const onBeforeCompile = material.onBeforeCompile;

        material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) => {

            onBeforeCompile.call(material, shader, renderer);

            if(!shader.vertexShader.includes("#include <project_vertex>") ||
                !shader.fragmentShader.includes("#include <dithering_fragment>")) {

                return;

            }

            shader.uniforms.velocityViewProjection = this.viewProjection;
            shader.uniforms.velocityPreviousViewProjection = this.previousViewProjection;
            shader.uniforms.velocityPreviousModelMatrix = previousModelMatrix;

            shader.vertexShader = "uniform mat4 velocityViewProjection;\n" +
                "uniform mat4 velocityPreviousViewProjection;\n" +
                "uniform mat4 velocityPreviousModelMatrix;\n" +
                "varying vec4 vVelocityCurrent;\n" +
                "varying vec4 vVelocityPrevious;\n" +
                shader.vertexShader.replace(
                    "#include <project_vertex>",
                    `#include <project_vertex>
					vVelocityCurrent = velocityViewProjection * modelMatrix * vec4(transformed, 1.0);
					vVelocityPrevious = velocityPreviousViewProjection * velocityPreviousModelMatrix * vec4(transformed, 1.0);`
                );

            // out_Velocity is only defined while the G-Buffer has the component, see GBufferShaderPlugin
            shader.fragmentShader = "varying vec4 vVelocityCurrent;\n" +
                "varying vec4 vVelocityPrevious;\n" +
                shader.fragmentShader.replace(
                    "#include <dithering_fragment>",
                    `#include <dithering_fragment>
					#ifdef out_${VELOCITY}

						out_${VELOCITY} = vec4(
							0.5 * (vVelocityCurrent.xy / vVelocityCurrent.w - vVelocityPrevious.xy / vVelocityPrevious.w),
							vVelocityPrevious.w / vVelocityCurrent.w - 1.0,
							0.0
						);

					#endif`
                );

        };

    }

}
