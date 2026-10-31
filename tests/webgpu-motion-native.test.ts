import assert from "node:assert/strict";
import test from "node:test";
import { Scene, Texture, Vector4 } from "three";
import { WebGPURenderer, WGSLNodeBuilder } from "three/webgpu";
import {
    WebGpuMotionBlur,
    blurVector,
    cone,
    cylinder,
    gatherWeight,
    inFront,
    interleavedGradientNoise,
    largestMotion,
    motionBlurLayout,
    neighbourMax,
    tileMaxXRow,
    tileMaxYColumn,
    viewDepth,
    adaptiveSampleCount
} from "../src/webgpu/MotionBlur.js";

const close = (a: number, b: number, epsilon = 1e-12) => assert.ok(Math.abs(a - b) <= epsilon, `${a} != ${b}`);

class RecordingRenderer {

    calls: Array<{ op: string, value?: any }> = [];

    setMRT(value: any) {

        this.calls.push({ op: "mrt", value });

    }

    setRenderTarget(value: any) {

        this.calls.push({ op: "target", value });

    }

    render() {

        this.calls.push({ op: "render" });

    }

}

function shaderRenderer(): WebGPURenderer {

    const canvas = {
        width: 1,
        height: 1,
        style: {},
        addEventListener() {},
        removeEventListener() {},
        getContext() {

            return null;

        }
    };
    const renderer = new WebGPURenderer({ canvas: canvas as any });
    // Shader generation only: no device, queue or render call is used.
    renderer.hasFeature = () => true;
    renderer.hasCompatibility = () => false;
    renderer.backend.utils = { getTextureSampleData: () => ({ primarySamples: 1 }) } as any;
    return renderer;

}

function buildFragment(renderer: WebGPURenderer, pass: any): { builder: any, code: string } {

    const builder = new WGSLNodeBuilder(pass.quad, renderer);
    builder.camera = pass.quad.camera;
    builder.scene = new Scene();
    builder.build();
    return { builder, code: builder.fragmentShader };

}

function textureBindings(builder: any): Texture[] {

    return builder.uniforms.fragment.filter((uniform: any) => uniform.type === "texture")
        .map((uniform: any) => uniform.node.value);

}

function assertSameTextures(actual: Texture[], expected: Texture[]): void {

    assert.equal(actual.length, expected.length);
    for(const texture of expected) {

        assert.ok(actual.includes(texture));

    }

}

function tileGrid(width: number, height: number): number[][][] {

    const rows: number[][][] = [];

    for(let y = 0; y < height; ++y) {

        const row: number[][] = [];

        for(let x = 0; x < width; ++x) {

            // Mostly small motion, one large signed vector: reductions compare squared length, not absolute X.
            row.push([x % 3 - 1, y % 2 - 1]);

        }

        rows.push(row);

    }

    rows[3][5] = [-13, 2];
    rows[4][1] = [9, -11];
    return rows;

}

test("layout follows maxBlur as a fraction of the output height", () => {

    assert.deepEqual(motionBlurLayout(900, 600, 0.08), {
        width: 900, height: 600, tileSize: 48, columns: 19, rows: 13
    });
    assert.deepEqual(motionBlurLayout(901, 601, 0.08), {
        width: 901, height: 601, tileSize: 49, columns: 19, rows: 13
    });
    assert.deepEqual(motionBlurLayout(900, 600, 0), {
        width: 900, height: 600, tileSize: 1, columns: 900, rows: 600
    });
    assert.deepEqual(motionBlurLayout(0, 0, 0.08), {
        width: 1, height: 1, tileSize: 1, columns: 1, rows: 1
    });

});

test("blurVector keeps the signed half streak and clamps it to the tile reach", () => {

    assert.deepEqual(blurVector(10, 0, 0.6, 48), [3, 0]);
    close(Math.hypot(...blurVector(200, 0, 0.8, 48)), 48);
    assert.deepEqual(blurVector(0, -200, 0.6, 48), [0, -48]);
    assert.deepEqual(blurVector(0, 0, 0.6, 48), [0, 0]);

});

test("separable tile max X then Y equals the largest signed motion of each tile", () => {

    const width = 7, height = 5, tileSize = 2;
    const rows = tileGrid(width, height);
    const columns = Math.ceil(width / tileSize);
    const rowCount = Math.ceil(height / tileSize);

    const columnMax = rows.map((row) => {

        const result: number[][] = [];

        for(let column = 0; column < columns; ++column) {

            result.push(tileMaxXRow(row, column * tileSize, Math.min(width, (column + 1) * tileSize)));

        }

        return result;

    });

    const tiles: number[][][] = [];

    for(let tileY = 0; tileY < rowCount; ++tileY) {

        const tileRow: number[][] = [];

        for(let tileX = 0; tileX < columns; ++tileX) {

            tileRow.push(tileMaxYColumn(
                columnMax.map((row) => row[tileX]),
                tileY * tileSize,
                Math.min(height, (tileY + 1) * tileSize)
            ));

        }

        tiles.push(tileRow);

    }

    for(let tileY = 0; tileY < rowCount; ++tileY) {

        for(let tileX = 0; tileX < columns; ++tileX) {

            const candidates: number[][] = [];

            for(let y = tileY * tileSize; y < Math.min(height, (tileY + 1) * tileSize); ++y) {

                for(let x = tileX * tileSize; x < Math.min(width, (tileX + 1) * tileSize); ++x) {

                    candidates.push(rows[y][x]);

                }

            }

            assert.deepEqual(tiles[tileY][tileX], largestMotion(candidates));

        }

    }

    // The signed vectors with the largest squared length win, not the largest absolute component.
    assert.deepEqual(tiles[1][2], [-13, 2]);

});

test("neighbour max takes the largest motion of the clamped 3x3 tiles", () => {

    const grid = [
        [[-5, 1], [0, 0], [0, 0], [0, 0]],
        [[0, 0], [1, 0], [0, 0], [0, 0]],
        [[0, 0], [0, 0], [6, 0], [0, 0]],
        [[0, 0], [0, 0], [0, 0], [0, 0]]
    ];

    assert.deepEqual(neighbourMax(grid, 0, 0), [-5, 1]);
    assert.deepEqual(neighbourMax(grid, 2, 2), [6, 0]);
    assert.deepEqual(neighbourMax(grid, 3, 3), [6, 0]);
    assert.deepEqual(neighbourMax(grid, -4, -4), [-5, 1]);

});

test("gather weights foreground over background without bleeding a sharp foreground", () => {

    const softDepth = 0.052;
    const background = viewDepth(0);

    // A foreground sample streaks over a sharp, farther background pixel.
    close(gatherWeight({ zX: 1, lengthX: 0, zY: 0.5, lengthY: 4, distance: 2, softDepth }), 0.5);
    // The background pixel gathers the blurry foreground.
    close(gatherWeight({ zX: background, lengthX: 0, zY: 0.5, lengthY: 4, distance: 2, softDepth }), 0.5);
    // A sharp foreground does not pick up a sharp background behind it.
    close(gatherWeight({ zX: 1, lengthX: 0, zY: 2, lengthY: 0, distance: 1, softDepth }), 0);
    // Two blurry pixels at the same depth overlap through both cones and both cylinders.
    close(gatherWeight({ zX: 1, lengthX: 4, zY: 1, lengthY: 4, distance: 1, softDepth }), 3.5);

    close(inFront(0.5, 1, softDepth), 1);
    close(inFront(1, 0.5, softDepth), 0);
    close(cone(2, 4), 0.5);
    close(cone(9, 4), 0);
    close(cylinder(2, 4), 1);
    close(cylinder(4, 4), 0.5, 5e-4);

});

test("interleaved gradient noise is deterministic in pixel and frame at pixel centers", () => {

    const raw = (x: number, y: number, frame: number) => {

        const fract = (value: number) => value - Math.floor(value);
        const nx = x + 5.588238 * frame;
        const ny = y + 5.588238 * frame;
        return fract(52.9829189 * fract(nx * 0.06711056 + ny * 0.00583715));

    };

    // Reference noise(gl_FragCoord.xy): the integer logical pixel is lifted to its center.
    close(interleavedGradientNoise(17, 29, 3), raw(17.5, 29.5, 3), 1e-15);
    assert.notEqual(interleavedGradientNoise(17, 29, 3), raw(17, 29, 3));

    const value = interleavedGradientNoise(17, 29, 3);
    assert.equal(interleavedGradientNoise(17, 29, 3), value);
    assert.ok(value >= 0 && value < 1);

    const frames = new Set<number>();
    for(let frame = 0; frame < 8; ++frame) {

        const sample = interleavedGradientNoise(17, 29, frame);
        assert.ok(sample >= 0 && sample < 1);
        frames.add(sample);

    }
    assert.equal(frames.size, 8);

});

test("reduction and gather passes bind their exact reduction textures", () => {

    const renderer = shaderRenderer();
    const blur = new WebGpuMotionBlur(renderer);
    blur.setSize(900, 600);

    assert.equal(blur.rowNode.value, blur.tileMaxXTarget.texture);
    assert.equal(blur.tileNode.value, blur.tileMaxTarget.texture);
    assert.equal(blur.neighbourNode.value, blur.neighbourMaxTarget.texture);
    assert.notEqual(blur.tileNode, blur.neighbourNode);

    const color = new Texture();
    const state = new Texture();
    blur.tileMaxXStateNode.value = state;
    blur.gatherStateNode.value = state;
    blur.colorNode.value = color;

    const tileMaxX = buildFragment(renderer, blur.tileMaxXPass);
    const tileMaxY = buildFragment(renderer, blur.tileMaxYPass);
    const neighbour = buildFragment(renderer, blur.neighbourMaxPass);
    const gather = buildFragment(renderer, blur.gatherPass);

    assertSameTextures(textureBindings(tileMaxX.builder), [state]);
    assertSameTextures(textureBindings(tileMaxY.builder), [blur.tileMaxXTarget.texture]);
    assertSameTextures(textureBindings(neighbour.builder), [blur.tileMaxTarget.texture]);
    assertSameTextures(textureBindings(gather.builder), [
        blur.neighbourMaxTarget.texture, color, state
    ]);
    assert.ok(!textureBindings(gather.builder).includes(blur.tileMaxTarget.texture));

    // Generated noise input is the pixel center, as in the reference noise(gl_FragCoord.xy).
    assert.match(gather.code, /vec2<f32>\( \( f32\( [\w.]+ \) \+ 0\.5 \), \( f32\( [\w.]+ \) \+ 0\.5 \) \)/);

    blur.dispose();

});

test("component allocates separable signed reduction targets and measures bounds reach", () => {

    const renderer = new RecordingRenderer();
    const blur = new WebGpuMotionBlur(renderer, { maxBlur: 0.08 });
    blur.setSize(900, 600);
    assert.equal(blur.tileSize, 48);

    const color = new Texture();
    const state = new Texture();
    const bounds = new Vector4(0.1, 0.2, 0.9, 0.8);
    const result = blur.render({ color, state, bounds, hasMotion: true });

    assert.equal(result.color, blur.outputTarget.texture);
    const targets = renderer.calls.filter((call) => call.op === "target").map((call) => call.value);
    assert.deepEqual(targets.map((target) => [target.width, target.height, target.textures[0].internalFormat]), [
        [19, 600, "rgba16float"],
        [19, 13, "rgba16float"],
        [19, 13, "rgba16float"],
        [900, 600, "rg11b10ufloat"]
    ]);
    assert.equal(renderer.calls.filter((call) => call.op === "render").length, 4);

    // One tile past TAA's certified bounds, in physical pixels.
    close(blur.backgroundBounds.x, 0.1 - 49 / 900);
    close(blur.backgroundBounds.y, 0.2 - 49 / 600);
    close(blur.backgroundBounds.z, 0.9 + 49 / 900);
    close(blur.backgroundBounds.w, 0.8 + 49 / 600);

    blur.maxBlur = 0.16;
    assert.equal(blur.tileSize, 96);
    renderer.calls.length = 0;
    blur.render({ color, state, bounds: null, hasMotion: true });
    const resized = renderer.calls.filter((call) => call.op === "target").map((call) => call.value);
    assert.deepEqual(resized.map((target) => [target.width, target.height]), [
        [10, 600], [10, 7], [10, 7], [900, 600]
    ]);
    assert.deepEqual(blur.backgroundBounds.toArray(), [0, 0, 1, 1]);

    blur.dispose();

});

test("disabled or motionless input bypasses the passes without stale state", () => {

    const renderer = new RecordingRenderer();
    const blur = new WebGpuMotionBlur(renderer);
    blur.setSize(320, 200);
    const color = new Texture();
    const state = new Texture();

    blur.enabled = false;
    assert.equal(blur.render({ color, state, hasMotion: true }).color, color);
    assert.equal(renderer.calls.length, 0);

    blur.enabled = true;
    assert.equal(blur.render({ color, state, hasMotion: false }).color, color);
    assert.equal(renderer.calls.length, 0);
    assert.deepEqual(blur.backgroundBounds.toArray(), [0, 0, 1, 1]);

    assert.equal(blur.render({ color, state: null, hasMotion: true }).color, color);
    assert.equal(renderer.calls.length, 0);

    // Reference settings remain mutable through reference-compatible accessors.
    blur.shutter = 0.8;
    blur.samples = 20;
    blur.softDepth = 0.1;
    assert.equal(blur.shutter, 0.8);
    assert.equal(blur.samples, 20);
    assert.equal(blur.softDepth, 0.1);

    blur.dispose();
    blur.dispose();

});

test("reset restarts the deterministic noise frame sequence", () => {

    const renderer = new RecordingRenderer();
    const blur = new WebGpuMotionBlur(renderer);
    blur.setSize(64, 48);
    const color = new Texture();
    const state = new Texture();
    const render = () => blur.render({ color, state, hasMotion: true });

    render();
    assert.equal(blur.frameUniform.value, 0);
    render();
    assert.equal(blur.frameUniform.value, 1);
    render();
    assert.equal(blur.frameUniform.value, 2);

    blur.reset();
    render();
    assert.equal(blur.frameUniform.value, 0);

    blur.dispose();

});

test("adaptive gather: about one sample per streak pixel, even, between 4 and the configured count", () => {
  assert.equal(adaptiveSampleCount(0.6, 12), 4);
  assert.equal(adaptiveSampleCount(2.1, 12), 6);
  assert.equal(adaptiveSampleCount(5.5, 12), 12);
  assert.equal(adaptiveSampleCount(40, 12), 12);
  assert.equal(adaptiveSampleCount(3, 4), 4);
  for (let length = 0.5; length < 20; length += 0.37) assert.equal(adaptiveSampleCount(length, 64) % 2, 0);
});
