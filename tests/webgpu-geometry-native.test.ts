// Focused Node tests for the native geometry stage: the MSAA resolve encoding curves, the per-object motion
// contract and the converted-material contracts. They do not need a GPU device, so the shader graphs are
// only checked for construction here; the rendered output (formats, sample counts, image parity) stays a
// browser acceptance gate.
import assert from "node:assert/strict";
import test from "node:test";
import * as GPU from "three/webgpu";
import * as T from "three/tsl";
import {
    ENCODINGS,
    GLASS_LAYER,
    OPAQUE_LAYER,
    WebGpuGeometry,
    encodeColor,
    encodingIndex,
    velocityForVertex,
} from "../src/webgpu/Geometry.js";

const CLOSE = 1e-9;

/**
 * Minimal stand-in for the native renderer: it records state, and its render() walks the scene like the
 * real one, calling onBeforeRender only for the meshes it would draw (visible, matching camera layers).
 */
function createStubRenderer() {
    const renderer = {
        autoClear: true,
        autoClearColor: true,
        autoClearDepth: true,
        autoClearStencil: true,
        draws: [] as string[],
        target: null as unknown,
        mrt: null as unknown,
        getRenderTarget() { return this.target; },
        getActiveCubeFace() { return 0; },
        getActiveMipmapLevel() { return 0; },
        getMRT() { return this.mrt; },
        setMRT(mrt: unknown) { this.mrt = mrt; },
        setRenderTarget(target: unknown) { this.target = target; },
        render(scene: GPU.Scene, camera: GPU.Camera) {
            scene.updateMatrixWorld();
            scene.traverse((object: GPU.Object3D) => {
                if ((object as GPU.Mesh).isMesh !== true) return;
                if (!object.visible) return;
                if ((object.layers.mask & camera.layers.mask) === 0) return;
                this.draws.push(object.name || object.uuid);
                object.onBeforeRender(this, scene, camera, (object as GPU.Mesh).geometry, (object as GPU.Mesh).material, null);
            });
        },
    };
    return renderer as unknown as GPU.WebGPURenderer & typeof renderer;
}

function createCamera() {
    const camera = new GPU.PerspectiveCamera(50, 1.5, 0.03, 100);
    camera.position.set(0, 0, 2);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    return camera;
}

/** A model like the viewer's: opaque physical/standard meshes plus one transparent glass pane. */
function createModel() {
    const map = new GPU.Texture();
    const roughnessMap = new GPU.Texture();
    const artwork = new GPU.MeshPhysicalMaterial({
        name: "ARTWORK",
        map,
        roughnessMap,
        roughness: 0.42,
        metalness: 0.7,
        ior: 1.5,
        specularIntensity: 0.8,
        clearcoat: 0.25,
        clearcoatRoughness: 0.12,
        envMapIntensity: 0.9,
    });
    const aluminium = new GPU.MeshStandardMaterial({ name: "ALU", roughness: 0.3, metalness: 1 });
    const glass = new GPU.MeshPhysicalMaterial({
        name: "GLASS",
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
        roughness: 0.05,
        metalness: 0,
    });

    const root = new GPU.Group();
    root.name = "model";
    const artworkMesh = new GPU.Mesh(new GPU.SphereGeometry(0.3, 8, 6), artwork);
    artworkMesh.name = "artwork";
    const aluminiumMesh = new GPU.Mesh(new GPU.SphereGeometry(0.2, 8, 6), aluminium);
    aluminiumMesh.name = "aluminium";
    const glassMesh = new GPU.Mesh(new GPU.SphereGeometry(0.25, 8, 6), glass);
    glassMesh.name = "glass";
    root.add(artworkMesh, aluminiumMesh, glassMesh);
    return { root, artwork, aluminium, glass, artworkMesh, aluminiumMesh, glassMesh, map, roughnessMap };
}

function createStage(options: Record<string, unknown> = {}) {
    const renderer = createStubRenderer();
    const scene = new GPU.Scene();
    scene.background = new GPU.Color(0x000000);
    const camera = createCamera();
    const model = createModel();
    scene.add(model.root);
    const geometry = new WebGpuGeometry(renderer, { scene, camera, ...options });
    geometry.setSize(96, 64);
    geometry.prepare(model.root);
    return { renderer, scene, camera, model, geometry };
}

function close(actual: number, expected: number, message?: string) {
    assert.ok(Math.abs(actual - expected) <= 1e-6, `${message ?? "value"}: expected ${expected}, got ${actual}`);
}

type GraphNode = {
    isNode?: boolean;
    isVarNode?: boolean;
    node?: GraphNode;
    type?: string;
    op?: string;
    aNode?: GraphNode;
    bNode?: GraphNode;
    cNode?: GraphNode;
    isUniformNode?: boolean;
};

/** TSL wraps intermediate values in VarNodes; the tests care about the expression inside them. */
function unwrapNode(node?: GraphNode) {
    let current = node;
    while (current && current.isVarNode === true && current.node) current = current.node;
    return current;
}

function collectNodes(node: GraphNode | undefined, visit: (node: GraphNode) => void, seen = new Set<GraphNode>()) {
    const current = unwrapNode(node);
    if (!current || typeof current !== "object" || seen.has(current)) return;
    seen.add(current);
    visit(current);
    for (const child of [current.aNode, current.bNode, current.cNode, current.node]) collectNodes(child, visit, seen);
}

test("encoding names map to the reference curve indices", () => {
    assert.deepEqual(ENCODINGS, ["linear", "rgb", "max"]);
    assert.equal(encodingIndex("linear"), 0);
    assert.equal(encodingIndex("rgb"), 1);
    assert.equal(encodingIndex("max"), 2);
    assert.throws(() => encodingIndex("reinhard"), /unknown encoding/);
});

test("encodeColor mirrors the tonemapped resolve curves", () => {
    const color = new GPU.Color(2, 0.5, -0.25);
    const exposure = 1.6;

    // Per channel: E(c) = kc / (1 + kc).
    const rgb = encodeColor(color, exposure, "rgb");
    close(rgb.r, 3.2 / 4.2, "rgb.r");
    close(rgb.g, 0.8 / 1.8, "rgb.g");
    close(rgb.b, 0, "rgb.b (negatives clamp like max(color, 0))");

    // Largest channel: E(c) = kc / (1 + k max(c)), the hue-preserving curve.
    const max = encodeColor(color, exposure, "max");
    close(max.r, 3.2 / 4.2, "max.r");
    close(max.g, 0.8 / 4.2, "max.g");
    close(max.b, 0, "max.b");

    // Linear: plain MSAA, only the encoding exposure.
    const linear = encodeColor(color, exposure, "linear");
    close(linear.r, 3.2, "linear.r");
    close(linear.g, 0.8, "linear.g");
    close(linear.b, 0, "linear.b");

    // Black stays black for every curve, which is what the target clear color relies on.
    for (const encoding of ENCODINGS) {
        const cleared = encodeColor(new GPU.Color(0x000000), exposure, encoding);
        assert.deepEqual([cleared.r, cleared.g, cleared.b], [0, 0, 0]);
    }
    assert.throws(() => encodeColor(color, 1, "filmic"), /unknown encoding/);
});

test("velocity is current minus previous screen motion with relative depth and W = 0", () => {
    const camera = createCamera();
    const projection = camera.projectionMatrix.clone();
    const viewProjection = new GPU.Matrix4().multiplyMatrices(projection, camera.matrixWorldInverse);

    const position = new GPU.Vector3(0.1, 0.2, 0.05);
    const identity = new GPU.Matrix4();

    // Rest: no motion at all, not just a small one.
    const rest = velocityForVertex(position, {
        currentViewProjection: viewProjection,
        currentModel: identity,
        previousViewProjection: viewProjection,
        previousModel: identity,
    });
    assert.deepEqual([rest.x, rest.y, rest.z, rest.w], [0, 0, 0, 0]);

    // The mesh slides right: positive screen X motion, WebGL NDC scaled by 0.5 like the reference.
    const moved = new GPU.Matrix4().makeTranslation(0.1, 0, 0);
    const slide = velocityForVertex(position, {
        currentViewProjection: viewProjection,
        currentModel: moved,
        previousViewProjection: viewProjection,
        previousModel: identity,
    });
    // Independent reference formula, in the same units as the GLSL/handoff contract.
    const currentClip = new GPU.Vector4(position.x, position.y, position.z, 1).applyMatrix4(moved).applyMatrix4(viewProjection);
    const previousClip = new GPU.Vector4(position.x, position.y, position.z, 1).applyMatrix4(identity).applyMatrix4(viewProjection);
    close(slide.x, 0.5 * (currentClip.x / currentClip.w - previousClip.x / previousClip.w), "slide.x");
    close(slide.y, 0.5 * (currentClip.y / currentClip.w - previousClip.y / previousClip.w), "slide.y");
    close(slide.z, previousClip.w / currentClip.w - 1, "slide.z");
    assert.ok(slide.x > 0, "positive X means the mesh moved right");
    assert.equal(slide.w, 0);

    // Positive Y is up in the WebGL NDC the velocity is defined in.
    const lifted = velocityForVertex(position, {
        currentViewProjection: viewProjection,
        currentModel: new GPU.Matrix4().makeTranslation(0, 0.2, 0),
        previousViewProjection: viewProjection,
        previousModel: identity,
    });
    assert.ok(lifted.y > 0, "positive Y means the mesh moved up");

    // Camera dolly in: the surface got closer, so the relative depth change is positive.
    const closer = createCamera();
    closer.position.set(0, 0, 1.5);
    closer.updateMatrixWorld();
    const closerViewProjection = new GPU.Matrix4().multiplyMatrices(closer.projectionMatrix, closer.matrixWorldInverse);
    const dolly = velocityForVertex(position, {
        currentViewProjection: closerViewProjection,
        currentModel: identity,
        previousViewProjection: viewProjection,
        previousModel: identity,
    });
    assert.ok(dolly.z > 0, "a closer surface has a positive previous/current depth ratio");
    assert.equal(dolly.w, 0);

    // Only the projection's z row differs between the native and the WebGL conventions, so the velocity is
    // unchanged when the caller passes either; the stage does not re-convert the projection it is given.
    const native = projection.clone();
    const elements = native.elements;
    for (let column = 0; column < 4; ++column) {
        elements[column * 4 + 2] = (elements[column * 4 + 2] + elements[column * 4 + 3]) / 2;
    }
    const nativeViewProjection = new GPU.Matrix4().multiplyMatrices(native, camera.matrixWorldInverse);
    const nativeVelocity = velocityForVertex(position, {
        currentViewProjection: nativeViewProjection,
        currentModel: moved,
        previousViewProjection: nativeViewProjection,
        previousModel: identity,
    });
    close(nativeVelocity.x, slide.x, "native x");
    close(nativeVelocity.y, slide.y, "native y");
    close(nativeVelocity.z, 0, "native z");
    assert.ok(Math.abs(position.x - 0.1) <= CLOSE, "the CPU mirror does not mutate its inputs");
});

test("the target is an encoded HDR + velocity MRT with retained multisampled depth", () => {
    const { geometry } = createStage({ samples: 4 });
    const target = geometry.target;
    const [color, velocity] = target.textures;

    assert.equal(geometry.samples, 4);
    assert.equal(target.samples, 4);
    assert.equal(target.textures.length, 2);

    assert.equal(color.name, "output");
    assert.equal(color.internalFormat, "rg11b10ufloat");
    assert.equal(color.format, GPU.RGBFormat);
    assert.equal(color.type, GPU.UnsignedInt101111Type);
    assert.equal(color.colorSpace, GPU.NoColorSpace);
    assert.equal(color.minFilter, GPU.LinearFilter);
    assert.equal(color.magFilter, GPU.LinearFilter);

    assert.equal(velocity.name, "velocity");
    assert.equal(velocity.format, GPU.RGBAFormat);
    assert.equal(velocity.type, GPU.HalfFloatType);
    assert.equal(velocity.colorSpace, GPU.NoColorSpace);
    assert.equal(velocity.minFilter, GPU.NearestFilter);
    assert.equal(velocity.magFilter, GPU.NearestFilter);

    // DepthFormat + FloatType is depth32float; the samples must survive the pass for TAA and the glass test.
    assert.equal(target.depthTexture.type, GPU.FloatType);
    assert.equal(target.depthTexture.format, GPU.DepthFormat);
    assert.equal(target.storeMultisampledColorBuffer, false);
    assert.equal(target.storeMultisampledDepthBuffer, true);

    assert.equal(target.width, 96);
    assert.equal(target.height, 64);
    assert.equal(target.depthTexture.image.width, 96);
    assert.equal(target.depthTexture.image.height, 64);
    assert.equal(target.depthTexture.image.width, target.width);

    // setSize only reallocates on a real change, and consumers see the new attachments afterwards.
    const sameTarget = geometry.target;
    geometry.setSize(96, 64);
    assert.equal(geometry.target, sameTarget);
    geometry.setSize(120, 80);
    assert.notEqual(geometry.target, sameTarget);
    assert.equal(geometry.target.width, 120);
    assert.equal(geometry.target.height, 80);
    assert.equal(geometry.target.depthTexture.image.width, 120);

    geometry.dispose();
});

test("prepare converts standard and physical materials in place and splits the layers", () => {
    const { geometry, model } = createStage();

    const artwork = model.artworkMesh.material as GPU.MeshPhysicalNodeMaterial;
    const aluminium = model.aluminiumMesh.material as GPU.MeshStandardNodeMaterial;
    const glass = model.glassMesh.material as GPU.MeshPhysicalNodeMaterial;

    // Node materials of the matching kind, not GLSL materials with onBeforeCompile patches.
    assert.equal(artwork.isNodeMaterial, true);
    assert.equal(artwork.isMeshPhysicalNodeMaterial, true);
    assert.equal(aluminium.isNodeMaterial, true);
    assert.equal(aluminium.isMeshStandardNodeMaterial, true);

    // Maps and physical properties survive the conversion.
    assert.equal(artwork.map, model.map);
    assert.equal(artwork.roughnessMap, model.roughnessMap);
    assert.equal(artwork.roughness, model.artwork.roughness);
    assert.equal(artwork.metalness, model.artwork.metalness);
    assert.equal(artwork.ior, model.artwork.ior);
    assert.equal(artwork.specularIntensity, model.artwork.specularIntensity);
    assert.equal(artwork.clearcoat, model.artwork.clearcoat);
    assert.equal(artwork.clearcoatRoughness, model.artwork.clearcoatRoughness);
    assert.equal(artwork.envMapIntensity, model.artwork.envMapIntensity);
    assert.equal(aluminium.roughness, model.aluminium.roughness);
    assert.equal(aluminium.metalness, model.aluminium.metalness);

    // Opaque materials write the encoded color and the per-mesh velocity, glass writes neither here.
    assert.notEqual(artwork.outputNode, null);
    assert.notEqual(aluminium.outputNode, null);
    assert.notEqual(artwork.mrtNode, null);
    assert.equal(artwork.mrtNode.has("velocity"), true);
    assert.equal(glass.outputNode, null);
    assert.equal(glass.mrtNode, null);
    assert.equal(glass.transparent, true);
    assert.equal(glass.opacity, model.glass.opacity);
    assert.equal(glass.depthWrite, false);

    // Layer separation matches TonemappedResolvePass.prepare.
    assert.equal(model.artworkMesh.layers.mask, 1 << OPAQUE_LAYER);
    assert.equal(model.aluminiumMesh.layers.mask, 1 << OPAQUE_LAYER);
    assert.equal(model.glassMesh.layers.mask, 1 << GLASS_LAYER);

    // NodeMaterial keeps its program cache key (the TSL graph and its bindings), never the plain material key.
    assert.equal(artwork.customProgramCacheKey, GPU.MeshPhysicalNodeMaterial.prototype.customProgramCacheKey);
    assert.notEqual(artwork.customProgramCacheKey, GPU.Material.prototype.customProgramCacheKey);
    assert.equal(typeof artwork.customProgramCacheKey(), "string");

    // Per-mesh motion state: separate uniforms, so two meshes sharing a source material keep their own history.
    const [artworkRecord, aluminiumRecord] = geometry.meshes;
    assert.equal(geometry.meshes.length, 3);
    assert.notEqual(artworkRecord.previousModel, aluminiumRecord.previousModel);
    assert.notEqual(artworkRecord.currentModel, aluminiumRecord.currentModel);
    assert.equal(artworkRecord.glass, false);
    assert.equal(geometry.meshes[2].glass, true);
    assert.equal(geometry.meshes[2].previousModel, null);

    // The same model object is used, not a clone, so runtime motion of the loaded graph stays visible.
    assert.equal(artworkRecord.mesh, model.artworkMesh);

    // prepare() is idempotent, and dispose() restores the loader's materials, layers and hooks.
    const materials = model.artworkMesh.material;
    geometry.prepare(model.root);
    assert.equal(geometry.meshes.length, 3);
    assert.equal(model.artworkMesh.material, materials);

    geometry.dispose();
    geometry.dispose();
    assert.equal(model.artworkMesh.material, model.artwork);
    assert.equal(model.aluminiumMesh.material, model.aluminium);
    assert.equal(model.glassMesh.material, model.glass);
    assert.equal(model.glassMesh.layers.mask, 1 << OPAQUE_LAYER);
    assert.throws(() => geometry.render({ projection: new GPU.Matrix4() }), /dispose/);
});

test("render keeps per-mesh history, restarts freshly drawn meshes and restores renderer state", () => {
    const { geometry, renderer, scene, camera, model } = createStage({ exposure: 1.6 });

    const projection = camera.projectionMatrix.clone();
    const mesh = model.artworkMesh;

    // A caller who leaves the renderer in a different state must get it back.
    const sentinelTarget = new GPU.RenderTarget(4, 4);
    const sentinelMRT = T.mrt({ output: T.output });
    camera.layers.enableAll();
    const layersBefore = camera.layers.mask;
    scene.background = new GPU.Color(0x123456);
    renderer.autoClear = false;
    renderer.autoClearColor = false;
    renderer.autoClearDepth = false;
    renderer.setMRT(sentinelMRT);
    renderer.setRenderTarget(sentinelTarget);

    const first = geometry.render({ projection });
    assert.equal(first.target, geometry.target);
    assert.equal(first.color, geometry.target.textures[0]);
    assert.equal(first.velocity, geometry.target.textures[1]);
    assert.equal(first.depth, geometry.target.depthTexture);
    assert.equal(first.meshesMoved, false);

    // State is restored whatever happened during the draw.
    assert.equal(renderer.getRenderTarget(), sentinelTarget);
    assert.equal(renderer.getMRT(), sentinelMRT);
    assert.equal(camera.layers.mask, layersBefore);
    assert.equal(scene.background.getHex(), 0x123456);
    assert.equal(renderer.autoClear, false);
    assert.equal(renderer.autoClearColor, false);
    assert.equal(renderer.autoClearDepth, false);

    // The first frame reports the opacity mesh as drawn and its previous transform as its current one.
    assert.deepEqual([...geometry.viewProjection.elements], [...new GPU.Matrix4().multiplyMatrices(projection, camera.matrixWorldInverse).elements]);
    assert.deepEqual([...geometry.previousViewProjection.elements], [...geometry.viewProjection.elements]);
    const artworkRecord = geometry.meshes[0];
    assert.equal(artworkRecord.lastDrawnFrame, 1);
    assert.deepEqual([...artworkRecord.previousMatrix.elements], [...mesh.matrixWorld.elements]);

    // Frame 2: the mesh moves on its own, so its previous transform is frame 1's, and meshesMoved reports it.
    const firstMatrix = mesh.matrixWorld.clone();
    mesh.position.x += 0.1;
    mesh.updateMatrixWorld(true);
    const second = geometry.render({ projection });
    assert.equal(second.meshesMoved, true);
    assert.deepEqual([...artworkRecord.previousMatrix.elements], [...firstMatrix.elements]);
    assert.deepEqual([...artworkRecord.previousModel.value.elements], [...firstMatrix.elements]);
    assert.deepEqual([...artworkRecord.currentModel.value.elements], [...mesh.matrixWorld.elements]);
    assert.deepEqual([...geometry.previousViewProjection.elements], [...geometry.viewProjection.elements]);
    geometry.finishFrame();

    // Frame 3: the camera moves, the mesh does not; the velocity keeps both view-projections.
    const previousViewProjection = geometry.viewProjection.clone();
    camera.position.z = 1.6;
    camera.updateMatrixWorld(true);
    const third = geometry.render({ projection: camera.projectionMatrix });
    assert.equal(third.meshesMoved, false);
    assert.deepEqual([...geometry.previousViewProjection.elements], [...previousViewProjection.elements]);
    geometry.finishFrame();

    // Frame 4: the mesh is culled through its draw visibility and moves off screen.
    mesh.visible = false;
    mesh.position.y += 0.5;
    mesh.updateMatrixWorld(true);
    const fourth = geometry.render({ projection: camera.projectionMatrix });
    assert.equal(fourth.meshesMoved, false, "a mesh that was not drawn reports no motion");

    // Frame 5: it becomes visible again at a new place. It restarts from rest instead of jumping.
    mesh.visible = true;
    const fifth = geometry.render({ projection: camera.projectionMatrix });
    assert.equal(fifth.meshesMoved, false);
    assert.deepEqual([...artworkRecord.previousMatrix.elements], [...mesh.matrixWorld.elements]);
    assert.deepEqual([...artworkRecord.previousModel.value.elements], [...artworkRecord.currentModel.value.elements]);
    geometry.finishFrame();

    // A still scene stays still: nothing moved since the last draw, camera motion is not a mesh move.
    assert.equal(geometry.render({ projection }).meshesMoved, false);
    geometry.reset();
    mesh.position.x += 0.2;
    mesh.updateMatrixWorld(true);
    const afterReset = geometry.render({ projection });
    assert.equal(afterReset.meshesMoved, false);
    assert.deepEqual([...artworkRecord.previousMatrix.elements], [...mesh.matrixWorld.elements]);
    assert.deepEqual([...geometry.previousViewProjection.elements], [...geometry.viewProjection.elements]);

    // A moved glass pane is not drawn by this stage and carries no velocity.
    assert.equal(geometry.meshes[2].glass, true);
    assert.equal(geometry.meshes[2].currentModel, null);

    geometry.dispose();
    sentinelTarget.dispose();
});

test("exposure, encoding, samples and the AA settings stay mutable at runtime", () => {
    const { geometry, camera } = createStage({ exposure: 1.6, encoding: "rgb" });

    assert.equal(geometry.exposure, 1.6);
    assert.equal(geometry.encoding, "rgb");
    geometry.exposure = 3.25;
    geometry.encoding = "max";
    assert.equal(geometry.exposure, 3.25);
    assert.equal(geometry.encoding, "max");
    geometry.encoding = "linear";
    assert.equal(geometry.encoding, "linear");
    assert.throws(() => { geometry.encoding = "reinhard"; }, /unknown encoding/);
    assert.equal(geometry.encoding, "linear");

    // The settings objects mirror the reference surface and are shared by every converted material.
    assert.equal(geometry.specularAA.enabled, true);
    assert.equal(geometry.specularAA.variance, 0.15);
    assert.equal(geometry.specularAA.threshold, 0.2);
    geometry.specularAA.variance = 0.3;
    geometry.specularAA.threshold = 0.4;
    geometry.specularAA.enabled = false;
    assert.deepEqual([geometry.specularAA.variance, geometry.specularAA.threshold, geometry.specularAA.enabled], [0.3, 0.4, false]);
    geometry.specularAA.enabled = true;

    assert.equal(geometry.grazingClamp.enabled, false, "the viewer leaves the grazing clamp off");
    assert.equal(geometry.grazingClamp.angle, 0.5);
    assert.equal(geometry.grazingClamp.limit, 0.03);
    geometry.grazingClamp.enabled = true;
    geometry.grazingClamp.angle = 0.35;
    geometry.grazingClamp.limit = 0.05;
    assert.deepEqual([geometry.grazingClamp.enabled, geometry.grazingClamp.angle, geometry.grazingClamp.limit], [true, 0.35, 0.05]);

    // Node construction for both settings is exercised here so a broken TSL graph fails without a GPU.
    const filtered = geometry.specularAA.filter(T.float(0.4), T.vec3(0, 0, 1));
    assert.notEqual(filtered, null);
    const scaled = geometry.grazingClamp.factor(T.vec3(0.5, 0.5, 0.5));
    assert.notEqual(scaled, null);

    // The logical MSAA level stays 0 or 4 like the reference's msaaSamples: the auto-tuner decides by
    // testing `samples > 0`, so a disabled stage must report 0 and not silently become 1.
    const before = geometry.target;
    assert.equal(geometry.samples, 4);
    geometry.samples = 4;
    assert.equal(geometry.target, before, "the same sample count keeps the target");
    geometry.samples = 0;
    assert.equal(geometry.samples, 0);
    assert.equal(geometry.samples > 0, false, "a samples > 0 auto-tuner check must stay false");
    assert.notEqual(geometry.target, before);
    assert.equal(geometry.target.samples, 0, "logical 0 on the target: the native attachment becomes single-sampled");
    assert.equal(geometry.target.storeMultisampledDepthBuffer, true);
    const disabled = geometry.target;
    geometry.samples = 0;
    assert.equal(geometry.target, disabled, "re-applying 0 is a no-op, so a tuner loop terminates");
    geometry.samples = 1;
    assert.equal(geometry.target, disabled, "every level below 4 is the same disabled level");
    geometry.samples = 4;
    assert.equal(geometry.samples, 4);
    assert.equal(geometry.target.samples, 4);

    // Sanity: a render still works after the mutability round trip.
    geometry.render({ projection: camera.projectionMatrix });
    geometry.dispose();
});

test("the clamp weight is grazing * strength, the reference curve, without squaring", () => {
    const { geometry } = createStage();

    // mix(1, scale, weight): MathNode 'mix' with (x, y, a) on aNode, bNode, cNode.
    const factor = unwrapNode(geometry.grazingClamp.factor(T.vec3(0.4, 0.4, 0.4)));
    assert.equal(factor.type, "MathNode");

    const weight = unwrapNode(factor.cNode);
    assert.equal(weight.type, "OperatorNode");
    assert.equal(weight.op, "*", "the blend weight is a single multiply");

    // GrazingSpecularClamp.ts: mix(1.0, scale, grazing * grazingSpecularStrength) — no second grazing factor.
    const grazingTerm = unwrapNode(weight.aNode);
    assert.equal(grazingTerm.type, "OperatorNode");
    assert.equal(grazingTerm.op, "-", "grazing = 1 - smoothstep(0, angle, |dot(faceNormal, viewDir)|)");
    assert.equal(unwrapNode(weight.bNode).isUniformNode, true, "the strength uniform multiplies the grazing term");

    const multiplications: GraphNode[] = [];
    const uniforms: GraphNode[] = [];
    collectNodes(weight, (node) => {
        if (node.type === "OperatorNode" && node.op === "*") multiplications.push(node);
        if (node.isUniformNode === true) uniforms.push(node);
    });
    assert.equal(multiplications.length, 1, "one multiply (grazing * strength): the reference does not square the grazing term");
    assert.ok(uniforms.length >= 1, "the weight still carries the strength uniform");

    geometry.dispose();
});

test("the clamp scales the base outgoing light before clearcoat and sheen are composed", () => {
    const { geometry, model } = createStage();
    const material = model.artworkMesh.material as GPU.MeshPhysicalNodeMaterial;
    assert.equal(material.isMeshPhysicalNodeMaterial, true);

    const calls: string[] = [];
    const clampPrototype = Object.getPrototypeOf(geometry.grazingClamp) as { apply: (...args: unknown[]) => void };
    const physicalPrototype = GPU.PhysicalLightingModel.prototype as { finish: (...args: unknown[]) => void };
    const originalApply = clampPrototype.apply;
    const originalFinish = physicalPrototype.finish;

    try {
        // The patched model binds finish at setup time, so the spy has to be in place first.
        clampPrototype.apply = function () { calls.push("clamp"); };
        physicalPrototype.finish = function () { calls.push("finish"); };

        const lightingModel = material.setupLightingModel();
        assert.notEqual(lightingModel.finish, originalFinish, "the converted material wraps the physical model's finish");
        lightingModel.finish({ context: {} });
    } finally {
        clampPrototype.apply = originalApply;
        physicalPrototype.finish = originalFinish;
    }

    // PhysicalLightingModel.finish composes clearcoat/sheen on outgoingLight, so the clamp has to land before it.
    assert.deepEqual(calls, ["clamp", "finish"]);
    geometry.dispose();
});

test("setSize and sample changes restart the motion history", () => {
    const { geometry, camera, model } = createStage();
    const projection = camera.projectionMatrix.clone();
    const mesh = model.artworkMesh;

    geometry.render({ projection });
    mesh.position.x += 0.1;
    mesh.updateMatrixWorld(true);
    assert.equal(geometry.render({ projection }).meshesMoved, true);

    geometry.setSize(120, 80);
    assert.equal(geometry.meshesMoved, false, "a resize drops the previous frame");
    assert.equal(geometry.render({ projection }).meshesMoved, false, "the first frame after a resize reports no motion");
    assert.deepEqual([...geometry.previousViewProjection.elements], [...geometry.viewProjection.elements]);

    mesh.position.x += 0.1;
    mesh.updateMatrixWorld(true);
    assert.equal(geometry.render({ projection }).meshesMoved, true);

    geometry.samples = 0;
    assert.equal(geometry.meshesMoved, false, "a sample change drops the previous frame");
    assert.equal(geometry.render({ projection }).meshesMoved, false, "the first frame after a sample change reports no motion");
    const record = geometry.meshes[0];
    assert.deepEqual([...record.previousModel.value.elements], [...record.currentModel.value.elements]);

    geometry.dispose();
});

test("the live meshesMoved getter sees glass drawn after the geometry pass", () => {
    const { geometry, renderer, scene, camera, model } = createStage();
    const projection = camera.projectionMatrix.clone();

    const frame = geometry.render({ projection });
    assert.equal(frame.meshesMoved, false);
    assert.equal(geometry.meshesMoved, false);

    // The transparency stage draws GLASS_LAYER after the geometry result has been handed over.
    model.glassMesh.position.x += 0.15;
    model.glassMesh.updateMatrixWorld(true);
    const previousLayers = camera.layers.mask;
    camera.layers.set(GLASS_LAYER);
    try {
        renderer.render(scene, camera);
    } finally {
        camera.layers.mask = previousLayers;
    }

    assert.equal(geometry.meshesMoved, true, "a glass pane that moved on its own is visible after the transparency draw");
    assert.equal(frame.meshesMoved, false, "the value returned with the geometry result is a snapshot of that pass");

    geometry.dispose();
});
