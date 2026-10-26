import assert from "node:assert/strict";
import test from "node:test";
import * as GPU from "three/webgpu";
import {
    DEPTH_SAMPLE_INDEX,
    ENCODINGS,
    MAX_ENCODED,
    WebGpuTransparency,
    decodeEncodedHdr,
    facingFromViewDifferentials,
    loadRetainedDepthSample,
    reactiveMaskValue
} from "../src/webgpu/Transparency.js";

// The encoding the geometry pass writes before the hardware MSAA resolve, see TonemappedResolvePass.encodeMaterial.
function encode(color: number[], exposure: number, encoding: string): number[] {
    const k = exposure;
    const c = color.map((v) => Math.max(v, 0) * k);
    if(encoding === "rgb") return c.map((v) => v / (1 + v));
    if(encoding === "max") {
        const brightest = Math.max(c[0], c[1], c[2]);
        return c.map((v) => v / (1 + brightest));
    }
    return c;
}

function reinhard(value: number, exposure: number): number {
    const c = Math.max(value, 0) * exposure;
    return c / (1 + c);
}

function close(a: number, b: number, tolerance = 1e-9): boolean {
    return Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
}

// Stand-in for the geometry pass: resolved single-sample HDR colour plus the retained 4x multisampled depth.
function createGeometry(width: number, height: number) {
    const target = new GPU.RenderTarget(width, height, { samples: 4, depthBuffer: true });
    target.texture.internalFormat = "rg11b10ufloat";
    const depth = new GPU.DepthTexture(width, height, GPU.FloatType);
    target.depthTexture = depth;
    return { target, color: target.texture, depth };
}

function createRenderer() {
    const calls: any[] = [];
    const renderer = {
        autoClear: true,
        renderTarget: null as any,
        mrt: "pipeline-mrt" as any,
        clearColor: new GPU.Color(0.2, 0.4, 0.6),
        clearAlpha: 0.5,
        failingRender: false,
        getRenderTarget() { return this.renderTarget; },
        setRenderTarget(target: any) { this.renderTarget = target; calls.push({ type: "setRenderTarget", target }); },
        getMRT() { return this.mrt; },
        setMRT(mrt: any) { this.mrt = mrt; calls.push({ type: "setMRT", mrt }); },
        getClearColor(target: any) { return target.copy(this.clearColor); },
        getClearAlpha() { return this.clearAlpha; },
        setClearColor(color: any, alpha = 1) { this.clearColor.copy(color); this.clearAlpha = alpha; },
        clear(color = true, depth = true, stencil = true) { calls.push({ type: "clear", color, depth, stencil }); },
        render(scene: any, camera: any) {
            if(this.failingRender && scene.isScene === true) throw new Error("glass render failed");
            calls.push({ type: "render", scene, camera, target: this.renderTarget, overrideMaterial: scene.overrideMaterial ?? null,
                background: scene.background ?? null, layers: camera.layers.mask, autoClear: this.autoClear });
        }
    };
    return { renderer, calls };
}

function createScene() {
    const scene = new GPU.Scene();
    const background = new GPU.Color(0, 0, 0);
    scene.background = background;
    const opaqueMaterial = new GPU.MeshBasicNodeMaterial({ name: "Opaque" });
    const glassMaterial = new GPU.MeshBasicNodeMaterial({ name: "Glass" });
    glassMaterial.transparent = true;
    glassMaterial.depthWrite = false;
    glassMaterial.side = GPU.DoubleSide;
    glassMaterial.blending = GPU.NormalBlending;
    const geometry = new GPU.BoxGeometry(1, 1, 0.01);
    const opaque = new GPU.Mesh(geometry, opaqueMaterial);
    opaque.layers.set(0);
    const glass = new GPU.Mesh(geometry, glassMaterial);
    glass.layers.set(1);
    scene.add(opaque, glass);
    return { scene, background, opaque, glass, glassMaterial };
}

function createTransparency(options: any = {}) {
    const { renderer, calls } = createRenderer();
    const { scene, background, opaque, glass, glassMaterial } = createScene();
    const camera = new GPU.PerspectiveCamera(50, 2, 0.1, 100);
    const transparency = new WebGpuTransparency(renderer as any, { scene, camera, ...options });
    return { renderer, calls, scene, background, opaque, glass, glassMaterial, camera, transparency };
}

test("decodes every edge encoding mode back to linear HDR", () => {
    const exposure = 1.6;
    const colors = [[0, 0, 0], [0.25, 0.5, 0.75], [1, 2, 8], [12.5, 0.01, 3]];
    for(const encoding of ENCODINGS) {
        for(const color of colors) {
            const encoded = encode(color, exposure, encoding);
            if(encoding !== "linear") {
                assert.ok(encoded.every((v) => v <= MAX_ENCODED), `${encoding} ${color} encodes above the decoded clamp`);
            }
            const decoded = decodeEncodedHdr(encoded, exposure, encoding);
            decoded.forEach((v, i) => assert.ok(close(v, color[i]), `${encoding} ${color} → ${decoded}, expected ${color}`));
        }
    }
    // The encoding indices are the reference uniform values
    assert.deepEqual(ENCODINGS, ["linear", "rgb", "max"]);
    assert.throws(() => decodeEncodedHdr([0, 0, 0], exposure, "reinhard"), /unknown encoding/);
});

test("the decode keeps the tone mapped average of bright subpixel edges", () => {
    const exposure = 1.6;
    // A pixel half covered by an 8.0 highlight and half black, averaged by the hardware MSAA resolve in encoded space
    const highlight = [8, 8, 8];
    const black = [0, 0, 0];
    for(const encoding of ["rgb", "max"]) {
        const covered = encode(highlight, exposure, encoding);
        const resolved = covered.map((v, i) => 0.5 * (v + encode(black, exposure, encoding)[i]));
        const decoded = decodeEncodedHdr(resolved, exposure, encoding);
        // The defining property of the resolve: the final Reinhard curve recovers exactly the averaged encoded samples
        decoded.forEach((v, i) => assert.ok(close(reinhard(v, exposure), resolved[i]), `${encoding} channel ${i}: ${v}`));
        // ... which is far below the plain linear MSAA average that tonemaps to a solid white step
        assert.ok(reinhard(decoded[0], exposure) < 0.6);
        assert.ok(reinhard(4, exposure) > 0.86);
    }
    // The largest channel curve compresses the other channels by the brightest one before the resolve
    assert.ok(encode([0.5, 0.2, 0], exposure, "max")[1] < encode([0.5, 0.2, 0], exposure, "rgb")[1]);
    // Plain linear MSAA decodes to itself
    assert.deepEqual(decodeEncodedHdr([2, 1, 0.5], exposure, "linear"), [2 / exposure, 1 / exposure, 0.5 / exposure]);
});

test("the clamp keeps the decoded value finite", () => {
    const decoded = decodeEncodedHdr([1, 1, 1], 1.6, "rgb");
    assert.ok(decoded.every(Number.isFinite));
    assert.ok(decoded.every((v) => close(v, MAX_ENCODED / (1.6 * (1 - MAX_ENCODED)))));
});

test("depth sample policy reads sample 0 of the borrowed retained depth", () => {
    assert.equal(DEPTH_SAMPLE_INDEX, 0);
    const depth = new GPU.DepthTexture(16, 8, GPU.FloatType);
    const node = loadRetainedDepthSample(depth) as any;
    // The retained texture itself, not a copy: level(0) is the explicit textureLoad sample index on multisampled depth
    assert.equal(node.value, depth);
    assert.equal(node.levelNode.value, 0);
    assert.equal(node.sampler, false);
});

test("exports sample 0 into a real single-sample depth32float attachment", () => {
    const { transparency, renderer } = createTransparency({ exposure: 1.6, encoding: "rgb" });
    const geometry = createGeometry(8, 4);
    const result = transparency.render(geometry as any);

    assert.equal(geometry.depth.renderTarget.samples, 4, "the retained depth must stay multisampled");
    assert.notEqual(result.depth, geometry.depth, "the exported depth must not be the retained multisampled depth");
    assert.equal(result.depth.format, GPU.DepthFormat);
    assert.equal(result.depth.type, GPU.FloatType);
    assert.equal(result.depth.renderTarget, result.target, "the export must land in a real depth attachment");
    assert.equal(result.target.depthTexture, result.depth);
    assert.equal(result.target.samples, 0, "the glass target and its depth attachment are single sample");
    // Contract v1.3: WebGPU cannot blend into rg11b10ufloat, so the glass composite target is rgba16float.
  assert.equal(result.target.texture.internalFormat, "rgba16float");
    assert.equal(result.color, result.target.texture, "the colour is the composited HDR colour");
    assert.equal(transparency.width, 8);
    assert.equal(transparency.height, 4);

    // The wired export material reads sample 0 of the depth handed in by the geometry pass
    // Decode and depth export are one pass (fused): the decode material owns the sample-0 depth write.
    const depthNode = (transparency as any).decodeMaterial.depthNode;
    assert.equal(depthNode.value, geometry.depth);
    assert.equal(depthNode.levelNode.value, DEPTH_SAMPLE_INDEX);
    assert.equal(typeof renderer.render, "function");
});

test("renders export, decode, glass and a depth tested reactive mask, then restores renderer state", () => {
    const { transparency, renderer, calls, scene, background, camera, glass, glassMaterial, opaque } = createTransparency({ exposure: 1.6, encoding: "rgb" });
    const geometry = createGeometry(8, 4);
    const glassState = { material: glass.material, transparent: glassMaterial.transparent, depthWrite: glassMaterial.depthWrite,
        depthTest: glassMaterial.depthTest, side: glassMaterial.side, blending: glassMaterial.blending };
    const opaqueMaterial = opaque.material;

    const result = transparency.render(geometry as any);

    const renders = calls.filter((call) => call.type === "render");
    assert.equal(renders.length, 3, "fused decode+depth export, glass and mask");
    // 1: decode writes the HDR colour AND depth sample 0 into the single-sample depth attachment
    const decodePass = renders[0];
    assert.equal(decodePass.scene.isQuadMesh, true);
    assert.equal(decodePass.target, result.target);
    assert.equal(decodePass.autoClear, false, "the decode must not clear the exported depth");
    assert.equal(decodePass.scene.material, transparency.decodeMaterial);
    assert.equal(transparency.decodeMaterial.depthWrite, true, "the fused pass writes the exported depth");
    assert.equal(transparency.decodeMaterial.depthTest, false, "depth testing against the cleared depth would reject it");
    // 2: the glass, drawn with the authored materials against the exported depth
    const glassPass = renders[1];
    assert.equal(glassPass.scene.isScene, true);
    assert.equal(glassPass.target, result.target);
    assert.equal(glassPass.autoClear, false);
    assert.equal(glassPass.overrideMaterial, null, "the glass must keep its own double-side/blend/depth material");
    assert.equal(glassPass.background, null, "a background colour would clear the decoded colour");
    assert.equal(glassPass.layers, 1 << 1, "only the transparent layer is drawn");
    // 4: the reactive mask, colour only cleared so the shared exported depth survives, depth tested against it
    const maskTarget = (result.reactiveMask as any).renderTarget;
    const maskPass = renders[2];
    assert.equal(maskTarget, transparency.reactiveMaskTarget);
    assert.equal(maskTarget.depthTexture, result.depth, "the mask is depth tested against the exported depth");
    assert.equal(maskTarget.samples, 0);
    assert.equal(maskPass.target, maskTarget);
    assert.equal(maskPass.overrideMaterial, transparency.reactiveMaskMaterial);
    const clears = calls.filter((call) => call.type === "clear");
    assert.equal(clears.length, 1);
    assert.deepEqual([clears[0].color, clears[0].depth, clears[0].stencil], [true, false, false]);
    assert.ok(calls.indexOf(clears[0]) < calls.indexOf(renders[2]));

    // No hidden opaque write: the glass keeps its transparent, non depth writing, double sided state
    assert.equal(glass.material, glassState.material);
    assert.equal(glassMaterial.transparent, glassState.transparent);
    assert.equal(glassMaterial.depthWrite, glassState.depthWrite);
    assert.equal(glassMaterial.depthTest, glassState.depthTest);
    assert.equal(glassMaterial.side, glassState.side);
    assert.equal(glassMaterial.blending, glassState.blending);
    assert.equal(opaque.material, opaqueMaterial);

    // Renderer, scene and camera state is restored in finally
    assert.equal(scene.overrideMaterial, null);
    assert.equal(scene.background, background);
    assert.equal(camera.layers.mask, 1);
    assert.equal(renderer.autoClear, true);
    assert.equal(renderer.renderTarget, null);
    assert.equal(renderer.mrt, "pipeline-mrt");
    assert.equal(renderer.clearAlpha, 0.5);
    assert.equal(renderer.clearColor.getHex(), new GPU.Color(0.2, 0.4, 0.6).getHex());
});

test("restores renderer state when the glass render throws", () => {
    const { transparency, renderer, scene, background, camera } = createTransparency({});
    const geometry = createGeometry(8, 4);
    renderer.failingRender = true;
    assert.throws(() => transparency.render(geometry as any), /glass render failed/);
    assert.equal(scene.overrideMaterial, null);
    assert.equal(scene.background, background);
    assert.equal(camera.layers.mask, 1);
    assert.equal(renderer.autoClear, true);
    assert.equal(renderer.renderTarget, null);
    assert.equal(renderer.mrt, "pipeline-mrt");
});

test("the decode shader reads the geometry colour through the shared exposure and encoding uniforms", () => {
    const { transparency } = createTransparency({});
    const geometry = createGeometry(8, 4);
    transparency.render(geometry as any);

    const nodes: any[] = [];
    (transparency as any).decodeMaterial.fragmentNode.traverse((node: any) => nodes.push(node));
    const readsColour = nodes.filter((node) => node.isTextureNode === true && node.value === geometry.color);
    assert.ok(readsColour.length > 0, "the decode must read the resolved encoded colour");
    assert.ok(readsColour.some((node) => node.levelNode !== null && node.levelNode.value === 0));
    assert.ok(nodes.includes((transparency as any).exposureNode), "exposure must stay a uniform");
    assert.ok(nodes.includes((transparency as any).encodingNode), "encoding must stay a uniform");
    // Two nested conditionals select between the three curves, so every encoding mode is in the shader
    assert.equal(nodes.filter((node) => node.type === "ConditionalNode").length, 2);
});

test("disabled reactive mask renders no mask and returns no mask texture", () => {
    const { transparency, calls } = createTransparency({ reactiveMask: false });
    const geometry = createGeometry(8, 4);
    const result = transparency.render(geometry as any);
    assert.equal(result.reactiveMask, null);
    assert.equal(calls.filter((call) => call.type === "render").length, 2, "fused decode+depth export, then glass");
    assert.equal(calls.filter((call) => call.type === "clear").length, 0);
});

test("dispose is idempotent, releases only owned targets and never the borrowed geometry depth", () => {
    const { transparency } = createTransparency({});
    const geometry = createGeometry(8, 4);
    const result = transparency.render(geometry as any);
    const maskTarget = (result.reactiveMask as any).renderTarget;

    let ownDisposals = 0;
    let maskDisposals = 0;
    let borrowedDisposals = 0;
    result.target.addEventListener("dispose", () => ownDisposals += 1);
    maskTarget.addEventListener("dispose", () => maskDisposals += 1);
    geometry.depth.addEventListener("dispose", () => borrowedDisposals += 1);

    transparency.dispose();
    transparency.dispose();

    assert.equal(ownDisposals, 1);
    assert.equal(maskDisposals, 1);
    assert.equal(borrowedDisposals, 0, "the geometry depth is borrowed and must never be disposed");
    assert.equal(geometry.depth.renderTarget.samples, 4);
    assert.equal(geometry.target.depthTexture, geometry.depth);
    assert.equal((transparency as any).depthTexture, null);
    assert.throws(() => transparency.render(geometry as any), /after dispose/);
    assert.throws(() => transparency.setSize(4, 4), /after dispose/);
});

test("reallocates on size change and keeps the exported depth texture object", () => {
    const { transparency } = createTransparency({});
    const first = createGeometry(8, 4);
    const depth = transparency.render(first as any).depth;
    const second = createGeometry(16, 8);
    const result = transparency.render(second as any);
    assert.equal(result.depth, depth, "consumers keep referencing the same depth texture across a resize");
    assert.equal(transparency.width, 16);
    assert.equal(transparency.height, 8);
    assert.equal(result.target.width, 16);
    assert.throws(() => transparency.setSize(7.5, 4), /positive integers/);
});

test("the reactive mask is the reference facing formula, depth tested and grazing edges stay reactive-free", () => {
    // Camera facing plate: the view position points at the camera along -Z, the derivatives span the plate
    const facingPlate = facingFromViewDifferentials([1, 0, 0], [0, -1, 0], [0, 0, -1]);
    assert.ok(Math.abs(facingPlate - 1) < 1e-12);
    assert.equal(reactiveMaskValue(facingPlate), 1);
    // Double sided: the sign of the derivatives and of the view position cancel through cross/normalize/abs, which is
    // also what makes WebGPU's +Y-down dFdy match WebGL's +Y-up dFdy
    assert.ok(Math.abs(facingFromViewDifferentials([-1, 0, 0], [0, 1, 0], [0, 0, 1]) - facingPlate) < 1e-12);
    // Edge on plate: the face normal is perpendicular to the view direction, so the pixel is not reactive
    assert.equal(reactiveMaskValue(facingFromViewDifferentials([0, 1, 0], [0, 0, 1], [0, 0, -1])), 0);
    // Reference smoothstep thresholds
    assert.equal(reactiveMaskValue(0.1), 0);
    assert.equal(reactiveMaskValue(0.3), 1);
    assert.ok(Math.abs(reactiveMaskValue(0.2) - 0.5) < 1e-12);
    assert.equal(reactiveMaskValue(0), 0);
});

test("the mask material keeps the reference double sided, non writing, single pass state", () => {
    const { transparency } = createTransparency({});
    const material = transparency.reactiveMaskMaterial;
    assert.equal(material.side, GPU.DoubleSide);
    assert.equal(material.depthTest, true);
    assert.equal(material.depthWrite, false);
    assert.equal(material.forceSinglePass, true, "the scene override would otherwise split the faces into two passes");
    assert.equal(material.transparent, false);
    assert.notEqual((transparency as any).reactiveMaskTarget.texture, (transparency as any).glassTarget.texture);
});

test("exposure and encoding stay runtime uniforms", () => {
    const { transparency } = createTransparency({ exposure: 1.6, encoding: "rgb" });
    assert.equal(transparency.exposure, 1.6);
    assert.equal(transparency.encoding, "rgb");
    assert.equal((transparency as any).encodingNode.value, 1);
    transparency.exposure = 5.15;
    transparency.encoding = "max";
    assert.equal(transparency.exposure, 5.15);
    assert.equal((transparency as any).encodingNode.value, 2);
    assert.throws(() => { transparency.encoding = "reinhard"; }, /unknown encoding/);
    assert.equal(transparency.encoding, "max");
});
