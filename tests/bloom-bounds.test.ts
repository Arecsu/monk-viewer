import assert from "node:assert/strict";
import test from "node:test";
import { BloomEffect } from "postprocessing";
import { Uniform, Vector4, WebGLRenderTarget } from "three";
import type { TemporalAAPass } from "../src/postprocessing/TemporalAAPass.ts";
import { BLOOM_DOWNSAMPLE_PADDING, BoundedBloomEffect, boundBloomShader } from "../src/postprocessing/BoundedBloomEffect.ts";

test("padding covers every rounded downsample footprint, including odd dimensions", () => {
    for(let width = 1; width <= 8192; ++width) {
        let size = width, accumulatedReach = 0;
        for(let level = 0; level < 16; ++level) {
            accumulatedReach += 3 / size; // 2-texel offsets plus up to one texel for linear filtering.
            const padding = BLOOM_DOWNSAMPLE_PADDING / size;
            // At >= 1 UV the padded rectangle covers the entire image, regardless of the original bounds.
            if(padding < 1) assert.ok(padding >= accumulatedReach, `${width}px level ${level}`);
            size = Math.max(1, Math.round(size / 2));
        }
    }
});

test("bounded shader preserves the stock filter and explicitly writes zero rather than discarding", () => {
    const original = "uniform sampler2D inputBuffer; in vec2 vUv; void main() { out_Color=texture(inputBuffer,vUv); }";
    const patched = boundBloomShader(original, BLOOM_DOWNSAMPLE_PADDING);
    assert.ok(patched.includes("out_Color=texture(inputBuffer,vUv);"));
    assert.ok(patched.includes("vec2(8.0) / vec2(textureSize(inputBuffer, 0))"));
    assert.ok(patched.includes("out_Color = vec4(0.0)"));
    assert.ok(!patched.includes("discard"));
    assert.throws(() => boundBloomShader("unsupported shader", 0), /main\(\) not found/);
});

test("only the active TAA output may certify black pixels", () => {
    const target = new WebGLRenderTarget(16, 16), other = new WebGLRenderTarget(16, 16);
    const source = { enabled: true, backgroundFastPath: true, output: { defaultBuffer: { value: target } },
        fullscreenMaterial: { uniforms: { backgroundBounds: new Uniform(new Vector4(0.25, 0.25, 0.75, 0.75)) } } };
    const bloom = new BoundedBloomEffect(source as unknown as TemporalAAPass);
    const bounds = () => bloom.luminanceMaterial.uniforms.boundedBloomBounds.value.toArray();
    try {
        bloom.input.defaultBuffer = target.texture;
        bloom.render();
        assert.deepEqual(bounds(), [0.1875, 0.1875, 0.8125, 0.8125]);
        assert.deepEqual(source.fullscreenMaterial.uniforms.backgroundBounds.value.toArray(), [0.25, 0.25, 0.75, 0.75]);
        source.enabled = false;
        bloom.render();
        assert.deepEqual(bounds(), [0, 0, 1, 1]);
        source.enabled = true;
        source.backgroundFastPath = false;
        bloom.render();
        assert.deepEqual(bounds(), [0, 0, 1, 1]);
        source.backgroundFastPath = true;
        bloom.input.defaultBuffer = other.texture;
        bloom.render();
        assert.deepEqual(bounds(), [0, 0, 1, 1]);
        bloom.input.defaultBuffer = target.texture;
        bloom.backgroundFastPath = false;
        bloom.render();
        assert.deepEqual(bounds(), [0, 0, 1, 1]);
    } finally {
        bloom.dispose(); target.dispose(); other.dispose();
    }
});

test("composition retains stock bloom settings and shared luminance controls", () => {
    const options = { luminanceThreshold: 0.1, luminanceSmoothing: 0.4, intensity: 0.3, radius: 1, levels: 8 };
    const stock = new BloomEffect(options);
    const bounded = new BoundedBloomEffect(null, options);
    try {
        assert.equal(bounded.name, stock.name);
        assert.equal(bounded.intensity, stock.intensity);
        assert.equal(bounded.luminanceThreshold, stock.luminanceThreshold);
        assert.equal(bounded.luminanceSmoothing, stock.luminanceSmoothing);
        assert.equal(bounded.mipmapBlurPass.levels, stock.mipmapBlurPass.levels);
        assert.equal(bounded.mipmapBlurPass.radius, stock.mipmapBlurPass.radius);
        assert.equal(bounded.mipmapBlurPass.fullResolutionUpsampling, stock.mipmapBlurPass.fullResolutionUpsampling);
        assert.equal(bounded.mipmapBlurPass.clampToBorder, stock.mipmapBlurPass.clampToBorder);
        bounded.luminanceThreshold = 0.2;
        bounded.luminanceSmoothing = 0.1;
        bounded.intensity = 0.6;
        assert.equal(bounded.luminanceMaterial.threshold, 0.2);
        assert.equal(bounded.luminanceMaterial.smoothing, 0.1);
        assert.equal(bounded.intensity, 0.6);
        bounded.render(); // No bounds source: safe full-screen fallback, even before attachment.
        assert.deepEqual(bounded.luminanceMaterial.uniforms.boundedBloomBounds.value.toArray(), [0, 0, 1, 1]);
    } finally {
        stock.dispose();
        bounded.dispose();
    }
});
