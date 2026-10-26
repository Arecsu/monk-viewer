import * as GPU from "three/webgpu";
import * as T from "three/tsl";
import { Vector4 } from "three";
import { createTarget, FullscreenPass, loadLogical, logicalPixel } from "./Common.js";

/**
 * Native WebGPU port of src/postprocessing/MotionBlurPass.ts.
 *
 * McGuire et al. 2012 with the Jimenez 2014 improvements: separable tile max (rows then columns, never tileSize²),
 * 3x3 neighbour max, then a depth-weighted gather along the neighbourhood's motion and half along the pixel's own.
 * The motion and view depth come from TemporalAAPass state: x is positive view depth (0 background), y the thin
 * feature lock, zw the frame motion in logical pixels (positive X right, positive Y up). Storage is top-left; the
 * shader works in logical bottom-left pixels and flips exactly once through Common.loadLogical/logicalPixel.
 *
 * The reduction targets are signed rgba16float (motion is a signed vector), the HDR output is rg11b10ufloat, and the
 * reach is screen-relative: maxBlur is a fraction of the output height, so the reach follows the render scale.
 */

const BACKGROUND_DEPTH = 1e4;
const NOISE = [0.06711056, 0.00583715];
const NOISE_FRAME_SCALE = 5.588238;
const NOISE_SCALE = 52.9829189;

/** Physical target dimensions and the pixel reach of a maxBlur fraction at the given output height. */
export function motionBlurLayout(width, height, maxBlur) {

    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    const tileSize = Math.max(Math.ceil(maxBlur * h), 1);

    return {
        width: w,
        height: h,
        tileSize,
        columns: Math.ceil(w / tileSize),
        rows: Math.ceil(h / tileSize)
    };

}

/** Half the blur streak: motion * shutter / 2, clamped to the tile size. Same units as the state motion (pixels). */
export function blurVector(x, y, shutter, maxBlurPixels) {

    const vx = x * (0.5 * shutter);
    const vy = y * (0.5 * shutter);
    const length = Math.hypot(vx, vy);

    return length > maxBlurPixels ? [vx * (maxBlurPixels / length), vy * (maxBlurPixels / length)] : [vx, vy];

}

/** The background has no depth: infinitely far, as in the reference gather. */
export function viewDepth(z) {

    return z > 0 ? z : BACKGROUND_DEPTH;

}

/** 1 when a is in front of b, fading to 0 when a is softDepth behind it. */
export function inFront(a, b, softDepth) {

    return Math.min(Math.max(1 - (a - b) / softDepth, 0), 1);

}

/** Cone: tapered streak; cylinder: both blurry and overlapping. d is the sample distance, l the streak length. */
export function cone(distance, length) {

    return Math.min(Math.max(1 - distance / Math.max(length, 1e-4), 0), 1);

}

export function cylinder(distance, length) {

    return 1 - smoothstep(0.95 * length, 1.05 * length + 1e-4, distance);

}

/** Interleaved gradient noise (Jimenez 2014): deterministic in pixel and frame. */
export function interleavedGradientNoise(x, y, frame) {

    const nx = x + NOISE_FRAME_SCALE * frame;
    const ny = y + NOISE_FRAME_SCALE * frame;

    return fract(NOISE_SCALE * fract(nx * NOISE[0] + ny * NOISE[1]));

}

/** McGuire weights: foreground over background, background behind a blurry foreground, and both blurry. */
export function gatherWeight({ zX, lengthX, zY, lengthY, distance, softDepth }) {

    return inFront(zY, zX, softDepth) * cone(distance, lengthY) +
        inFront(zX, zY, softDepth) * cone(distance, lengthX) +
        cylinder(distance, lengthY) * cylinder(distance, lengthX) * 2;

}

/** Largest motion by squared length; signed components are preserved, ties keep the first vector. */
export function largestMotion(vectors) {

    let x = 0, y = 0, largestLength = 0;

    for(const [vx, vy] of vectors) {

        const length = vx * vx + vy * vy;

        if(length > largestLength) {

            largestLength = length;
            x = vx;
            y = vy;

        }

    }

    return [x, y];

}

/** CPU counterpart of the tile-max X loop: the row's largest motion over [start, end). */
export function tileMaxXRow(row, start, end) {

    return largestMotion(row.slice(start, end));

}

/** CPU counterpart of the tile-max Y loop: the column's largest row motion over [start, end). */
export function tileMaxYColumn(rows, start, end) {

    return largestMotion(rows.slice(start, end));

}

/** CPU counterpart of the 3x3 neighbour max, clamped to the tile grid. */
export function neighbourMax(tileMaxima, centerX, centerY) {

    const candidates = [];
    const rows = tileMaxima.length;
    const columns = tileMaxima[0].length;

    for(let y = -1; y <= 1; ++y) {

        for(let x = -1; x <= 1; ++x) {

            const cx = Math.min(Math.max(centerX + x, 0), columns - 1);
            const cy = Math.min(Math.max(centerY + y, 0), rows - 1);
            candidates.push(tileMaxima[cy][cx]);

        }

    }

    return largestMotion(candidates);

}

function fract(value) {

    return value - Math.floor(value);

}

function smoothstep(edge0, edge1, x) {

    const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
    return t * t * (3 - 2 * t);

}

function tslBlurVector(motion, shutter, maxBlurPixels) {

    const v = motion.mul(shutter.mul(0.5));
    const length = T.length(v);

    return T.select(length.greaterThan(maxBlurPixels), v.mul(maxBlurPixels.div(length)), v);

}

function tslViewDepth(z) {

    return T.select(z.greaterThan(0), z, T.float(BACKGROUND_DEPTH));

}

function tslInFront(a, b, softDepth) {

    return T.clamp(T.float(1).sub(a.sub(b).div(softDepth)), 0, 1);

}

function tslCone(distance, length) {

    return T.clamp(T.float(1).sub(distance.div(T.max(length, 1e-4))), 0, 1);

}

function tslCylinder(distance, length) {

    return T.float(1).sub(T.smoothstep(length.mul(0.95), length.mul(1.05).add(1e-4), distance));

}

function tslNoise(pixel, frame) {

    const p = T.vec2(T.float(pixel.x), T.float(pixel.y));

    return T.fract(T.float(NOISE_SCALE).mul(
        T.fract(T.dot(p.add(T.vec2(frame.mul(NOISE_FRAME_SCALE))), T.vec2(...NOISE)))
    ));

}

export class WebGpuMotionBlur {

    constructor(renderer, {
        shutter = 0.6,
        maxBlur = 0.08,
        samples = 12,
        softDepth = 0.052
    } = {}) {

        this.renderer = renderer;
        this.enabled = true;
        this.backgroundBounds = new Vector4(0, 0, 1, 1);

        this._shutter = shutter;
        this._maxBlur = maxBlur;
        this._samples = samples;
        this._softDepth = softDepth;
        this._frame = 0;
        this._disposed = false;

        this.shutterUniform = T.uniform(shutter);
        this.maxBlurPixelsUniform = T.uniform(1);
        this.samplesUniform = T.uniform(samples, "int");
        this.softDepthUniform = T.uniform(softDepth);
        this.frameUniform = T.uniform(0);
        this.boundsUniform = T.uniform(this.backgroundBounds);
        this.tileSizeUniform = T.uniform(1, "int");
        this.widthUniform = T.uniform(1, "int");
        this.heightUniform = T.uniform(1, "int");
        this.columnsUniform = T.uniform(1, "int");
        this.rowsUniform = T.uniform(1, "int");

        // One texture node per material: the value is rebound every render, so a TAA toggle can neither keep nor
        // read stale state. A dummy uv keeps TextureNode clones from applying a texture matrix to textureLoad().
        this.tileMaxXStateNode = T.texture(new GPU.Texture(), T.vec2(0, 0));
        this.gatherStateNode = T.texture(new GPU.Texture(), T.vec2(0, 0));
        this.rowNode = T.texture(new GPU.Texture(), T.vec2(0, 0));
        this.tileNode = T.texture(new GPU.Texture(), T.vec2(0, 0));
        this.colorNode = T.texture(new GPU.Texture(), T.vec2(0, 0));

        this.tileMaxXTarget = createTarget(1, 1, { format: "rgba16float", nearest: true });
        this.tileMaxTarget = createTarget(1, 1, { format: "rgba16float", nearest: true });
        this.neighbourMaxTarget = createTarget(1, 1, { format: "rgba16float", nearest: true });
        this.outputTarget = createTarget(1, 1);

        this.tileMaxXPass = new FullscreenPass(renderer, this.createTileMaxXFragment(), {
            target: this.tileMaxXTarget,
            name: "MotionBlurTileMaxXMaterial"
        });
        this.tileMaxYPass = new FullscreenPass(renderer, this.createTileMaxYFragment(), {
            target: this.tileMaxTarget,
            name: "MotionBlurTileMaxYMaterial"
        });
        this.neighbourMaxPass = new FullscreenPass(renderer, this.createNeighbourMaxFragment(), {
            target: this.neighbourMaxTarget,
            name: "MotionBlurNeighbourMaxMaterial"
        });
        this.gatherPass = new FullscreenPass(renderer, this.createGatherFragment(), {
            target: this.outputTarget,
            name: "MotionBlurGatherMaterial"
        });

        this.setSize(1, 1);

    }

    get shutter() {

        return this._shutter;

    }

    set shutter(value) {

        this._shutter = value;
        this.shutterUniform.value = value;

    }

    get maxBlur() {

        return this._maxBlur;

    }

    set maxBlur(value) {

        this._maxBlur = value;
        this.applyLayout(this._layout.width, this._layout.height);

    }

    get samples() {

        return this._samples;

    }

    set samples(value) {

        this._samples = value;
        this.samplesUniform.value = value;

    }

    get softDepth() {

        return this._softDepth;

    }

    set softDepth(value) {

        this._softDepth = value;
        this.softDepthUniform.value = value;

    }

    get tileSize() {

        return this._layout.tileSize;

    }

    setSize(width, height) {

        this.applyLayout(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)));

    }

    applyLayout(width, height) {

        const layout = motionBlurLayout(width, height, this._maxBlur);
        this._layout = layout;
        this.widthUniform.value = layout.width;
        this.heightUniform.value = layout.height;
        this.columnsUniform.value = layout.columns;
        this.rowsUniform.value = layout.rows;
        this.tileSizeUniform.value = layout.tileSize;
        this.maxBlurPixelsUniform.value = layout.tileSize;

        this.tileMaxXTarget.setSize(layout.columns, layout.height);
        this.tileMaxTarget.setSize(layout.columns, layout.rows);
        this.neighbourMaxTarget.setSize(layout.columns, layout.rows);
        this.outputTarget.setSize(layout.width, layout.height);

    }

    render({ color = null, state = null, bounds = null, hasMotion = false } = {}) {

        this.backgroundBounds.set(0, 0, 1, 1);

        if(this._disposed || !this.enabled || color === null) {

            return { color };

        }

        // Without upstream motion state (TAA disabled or toggled this frame) there is nothing to reconstruct: pass
        // the input through instead of reading a stale reduction or an undefined state texture.
        if(!hasMotion || state === null) {

            return { color };

        }

        const layout = this._layout;

        if(bounds) {

            // TAA certifies black outside its bounds, the blur reaches at most one tile further.
            const reach = layout.tileSize + 1;
            this.backgroundBounds.set(
                bounds.x - reach / layout.width,
                bounds.y - reach / layout.height,
                bounds.z + reach / layout.width,
                bounds.w + reach / layout.height
            );

        }

        this.tileMaxXStateNode.value = state;
        this.gatherStateNode.value = state;
        this.colorNode.value = color;
        this.frameUniform.value = this._frame++ % 64;

        this.tileMaxXPass.render();
        this.tileMaxYPass.render();
        this.neighbourMaxPass.render();
        this.gatherPass.render();

        return { color: this.outputTarget.texture };

    }

    dispose() {

        if(this._disposed) {

            return;

        }

        this._disposed = true;
        this.tileMaxXPass.dispose();
        this.tileMaxYPass.dispose();
        this.neighbourMaxPass.dispose();
        this.gatherPass.dispose();
        this.tileMaxXTarget.dispose();
        this.tileMaxTarget.dispose();
        this.neighbourMaxTarget.dispose();
        this.outputTarget.dispose();

    }

    createTileMaxXFragment() {

        return T.Fn(() => {

            const pixel = logicalPixel(this.heightUniform);
            const baseX = pixel.x.mul(this.tileSizeUniform);
            const end = T.min(this.tileSizeUniform, this.widthUniform.sub(baseX));
            const largest = T.vec2(0).toVar();
            const largestLength = T.float(0).toVar();

            T.Loop(end, ({ i }) => {

                const state = loadLogical(this.tileMaxXStateNode, T.ivec2(baseX.add(i), pixel.y), this.heightUniform);
                const v = tslBlurVector(state.zw, this.shutterUniform, this.maxBlurPixelsUniform);
                const length = T.dot(v, v);

                T.If(length.greaterThan(largestLength), () => {

                    largestLength.assign(length);
                    largest.assign(v);

                });

            });

            return T.vec4(largest, 0, 1);

        })();

    }

    createTileMaxYFragment() {

        return T.Fn(() => {

            const pixel = logicalPixel(this.rowsUniform);
            const baseY = pixel.y.mul(this.tileSizeUniform);
            const end = T.min(this.tileSizeUniform, this.heightUniform.sub(baseY));
            const largest = T.vec2(0).toVar();
            const largestLength = T.float(0).toVar();

            T.Loop(end, ({ i }) => {

                const row = loadLogical(this.rowNode, T.ivec2(pixel.x, baseY.add(i)), this.heightUniform);
                const length = T.dot(row.xy, row.xy);

                T.If(length.greaterThan(largestLength), () => {

                    largestLength.assign(length);
                    largest.assign(row.xy);

                });

            });

            return T.vec4(largest, 0, 1);

        })();

    }

    createNeighbourMaxFragment() {

        return T.Fn(() => {

            const pixel = logicalPixel(this.rowsUniform);
            const largest = T.vec2(0).toVar();
            const largestLength = T.float(0).toVar();

            for(let y = -1; y <= 1; ++y) {

                for(let x = -1; x <= 1; ++x) {

                    const cx = T.clamp(pixel.x.add(x), 0, this.columnsUniform.sub(1));
                    const cy = T.clamp(pixel.y.add(y), 0, this.rowsUniform.sub(1));
                    const v = loadLogical(this.tileNode, T.ivec2(cx, cy), this.rowsUniform).xy;
                    const length = T.dot(v, v);

                    T.If(length.greaterThan(largestLength), () => {

                        largestLength.assign(length);
                        largest.assign(v);

                    });

                }

            }

            return T.vec4(largest, 0, 1);

        })();

    }

    createGatherFragment() {

        return T.Fn(() => {

            const pixel = logicalPixel(this.heightUniform);
            const uv = T.vec2(
                T.float(pixel.x).add(0.5).div(T.float(this.widthUniform)),
                T.float(pixel.y).add(0.5).div(T.float(this.heightUniform))
            );
            const outside = T.any(uv.lessThan(this.boundsUniform.xy))
                .or(T.any(uv.greaterThan(this.boundsUniform.zw)));
            const result = T.vec4(0, 0, 0, 1).toVar();

            T.If(outside, () => {

                result.assign(T.vec4(0, 0, 0, 1));

            }).Else(() => {

                const colorX = loadLogical(this.colorNode, pixel, this.heightUniform).rgb;
                const tile = T.ivec2(pixel.x.div(this.tileSizeUniform), pixel.y.div(this.tileSizeUniform));
                const vN = loadLogical(this.tileNode, tile, this.rowsUniform).xy;
                const lengthN = T.length(vN);

                T.If(lengthN.lessThan(0.5), () => {

                    result.assign(T.vec4(colorX, 1));

                }).Else(() => {

                    const stateX = loadLogical(this.gatherStateNode, pixel, this.heightUniform);
                    const vX = tslBlurVector(stateX.zw, this.shutterUniform, this.maxBlurPixelsUniform);
                    const lengthX = T.length(vX);
                    const zX = tslViewDepth(stateX.x);
                    const sampleCount = T.float(this.samplesUniform).add(1);

                    // A sharp pixel dominates its own colour, a blurry one is spread over its streak.
                    const weight = T.float(1).div(T.max(lengthX, 0.5)).toVar();
                    const sum = colorX.mul(weight).toVar();
                    const jitter = tslNoise(pixel, this.frameUniform).sub(0.5);
                    // Half of the samples follow the pixel's own motion, so the blur inside a moving object follows it
                    // rather than the fastest motion around.
                    const ownDirection = lengthX.greaterThan(0.5);
                    const maxPixel = T.ivec2(this.widthUniform.sub(1), this.heightUniform.sub(1));

                    T.Loop(this.samplesUniform, ({ i }) => {

                        const t = T.mix(T.float(-1), T.float(1), T.float(i).add(jitter).add(1).div(sampleCount));
                        const direction = T.select(ownDirection.and(i.bitAnd(1).equal(1)), vX, vN);
                        const offset = direction.mul(t);
                        const y = T.clamp(pixel.add(T.ivec2(T.round(offset))), T.ivec2(0), maxPixel);
                        const distance = T.length(offset);
                        const stateY = loadLogical(this.gatherStateNode, y, this.heightUniform);
                        const lengthY = T.length(tslBlurVector(stateY.zw, this.shutterUniform, this.maxBlurPixelsUniform));
                        const zY = tslViewDepth(stateY.x);

                        const w = tslInFront(zY, zX, this.softDepthUniform).mul(tslCone(distance, lengthY))
                            .add(tslInFront(zX, zY, this.softDepthUniform).mul(tslCone(distance, lengthX)))
                            .add(tslCylinder(distance, lengthY).mul(tslCylinder(distance, lengthX)).mul(2));

                        weight.addAssign(w);
                        sum.addAssign(loadLogical(this.colorNode, y, this.heightUniform).rgb.mul(w));

                    });

                    result.assign(T.vec4(sum.div(weight), 1));

                });

            });

            return result;

        })();

    }

}
