import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { LinearFilter, LinearMipmapLinearFilter, Mesh, MeshStandardMaterial, Texture } from 'three/webgpu';
import { GainMapDecoderMaterial } from '@monogrid/gainmap-js/webgpu';
import {
    EnvironmentResources,
    SDR_ONLY_GAIN_MAP_METADATA,
    extractGainMapSource,
    gainMapDecoderParameters,
    loadWebGpuEnvironment,
    optimizeWebGpuTextures,
} from '../src/webgpu/Environment.js';

const ENVIRONMENT_MODULE = new URL('../src/webgpu/Environment.js', import.meta.url);
const GAIN_MAP_ENVIRONMENTS = [
    {
        path: new URL('../src/envmaps/the_sky_is_on_fire_4k.jpg', import.meta.url),
        metadata: {
            gainMapMin: [0, 0, 0],
            gainMapMax: [4.73809, 4.73809, 4.73809],
            gamma: [1, 1, 1],
            offsetSdr: [0.015625, 0.015625, 0.015625],
            offsetHdr: [0.015625, 0.015625, 0.015625],
            hdrCapacityMin: 0,
            hdrCapacityMax: 4.73809,
        },
    },
    {
        path: new URL('../src/envmaps/old_bus_depot_4k_blur.jpg', import.meta.url),
        metadata: {
            gainMapMin: [0, 0, 0],
            gainMapMax: [7.71939, 7.71939, 7.71939],
            gamma: [1, 1, 1],
            offsetSdr: [0.015625, 0.015625, 0.015625],
            offsetHdr: [0.015625, 0.015625, 0.015625],
            hdrCapacityMin: 0,
            hdrCapacityMax: 7.71939,
        },
    },
];

// SDR-only JPEG: the reference fallback test input, no EXIF/ISO/XMP gain-map metadata.
const PLAIN_JPEG = new Uint8Array(Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
    'base64',
));

/** JPEG frame dimensions from the first SOF marker. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 2;
    while (offset + 9 < bytes.length) {
        assert.equal(bytes[offset], 0xff, `expected a JPEG marker at ${offset}`);
        const marker = bytes[offset + 1];
        if (marker >= 0xc0 && marker <= 0xc3) {
            return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
        }
        offset += 2 + view.getUint16(offset + 2);
    }
    throw new Error('no JPEG SOF marker found');
}

test('gain map metadata and split images are read from the reproduction environments', async () => {
    for (const { path, metadata: expected } of GAIN_MAP_ENVIRONMENTS) {
        const jpegBuffer = new Uint8Array(await readFile(path));
        const source = await extractGainMapSource(jpegBuffer, path.pathname);
        assert.deepEqual(source.metadata, expected);
        // The gain map is a second, smaller JPEG: the source really was split, not passed through.
        assert.equal(source.sdr[0], 0xff);
        assert.equal(source.sdr[1], 0xd8);
        assert.equal(source.gainMap?.[0], 0xff);
        assert.equal(source.gainMap?.[1], 0xd8);
        assert.ok((source.gainMap?.length ?? 0) > 0);
        assert.notEqual(source.gainMap?.length, jpegBuffer.length);
        assert.deepEqual(jpegSize(source.sdr), { width: 4096, height: 2048 });
        assert.deepEqual(jpegSize(source.gainMap!), { width: 4096, height: 2048 });
    }
});

test('gain map decode parameters reach the authored scene-linear range above 1', async () => {
    for (const { path, metadata } of GAIN_MAP_ENVIRONMENTS) {
        const jpegBuffer = new Uint8Array(await readFile(path));
        const source = await extractGainMapSource(jpegBuffer, path.pathname);
        const sdr = new Texture();
        const gainMap = new Texture();
        const parameters = gainMapDecoderParameters(source.metadata, sdr, gainMap);
        assert.equal(parameters.sdr, sdr);
        assert.equal(parameters.gainMap, gainMap);
        assert.deepEqual(parameters.gamma, metadata.gamma);
        assert.deepEqual(parameters.gainMapMin, metadata.gainMapMin);
        assert.deepEqual(parameters.gainMapMax, metadata.gainMapMax);
        assert.equal(parameters.hdrCapacityMin, metadata.hdrCapacityMin);
        assert.equal(parameters.hdrCapacityMax, metadata.hdrCapacityMax);
        // The reference loader drives the decode at the metadata's HDR capacity, i.e. the
        // material's weight factor is exactly 1 (no clamp, no reduced boost).
        assert.equal(parameters.maxDisplayBoost, Math.pow(2, metadata.hdrCapacityMax));
        const weight = (Math.log2(parameters.maxDisplayBoost) - metadata.hdrCapacityMin) / (metadata.hdrCapacityMax - metadata.hdrCapacityMin);
        assert.equal(weight, 1);
        // A clipped SDR channel at full recovery reconstructs a scene-linear value well above 1.
        const peak = (1 + metadata.offsetSdr[0]) * Math.pow(2, metadata.gainMapMax[0]) - metadata.offsetHdr[0];
        assert.ok(peak > 20, `expected a large scene-linear headroom, got ${peak}`);
    }
});

test('the native decode material receives the gain map metadata unchanged', async () => {
    const { path, metadata } = GAIN_MAP_ENVIRONMENTS[1];
    const source = await extractGainMapSource(new Uint8Array(await readFile(path)), path.pathname);
    const material = new GainMapDecoderMaterial(gainMapDecoderParameters(source.metadata, new Texture(), new Texture()));
    assert.equal(material.maxDisplayBoost, Math.pow(2, metadata.hdrCapacityMax));
    assert.equal(material.hdrCapacityMin, metadata.hdrCapacityMin);
    assert.equal(material.hdrCapacityMax, metadata.hdrCapacityMax);
    assert.deepEqual(material.gamma, metadata.gamma);
    assert.deepEqual(material.offsetSdr, metadata.offsetSdr);
    assert.deepEqual(material.offsetHdr, metadata.offsetHdr);
    assert.deepEqual(material.gainMapMin, metadata.gainMapMin);
    assert.deepEqual(material.gainMapMax, metadata.gainMapMax);
    assert.equal(material.colorNode?.isNode, true);
});

test('a JPEG without gain map metadata keeps the reference SDR fallback', async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => warnings.push(message);
    let source;
    try {
        source = await extractGainMapSource(PLAIN_JPEG, 'plain.jpg');
    } finally {
        console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Failure to reconstruct an HDR image from plain\.jpg/);
    assert.equal(source.metadata, SDR_ONLY_GAIN_MAP_METADATA);
    assert.equal(source.gainMap, undefined);
    assert.equal(source.sdr, PLAIN_JPEG);
    // Documented literal defaults: zero minimum recovery, unit maximum recovery, no offsets.
    assert.deepEqual({ ...SDR_ONLY_GAIN_MAP_METADATA }, {
        gainMapMin: [0, 0, 0],
        gainMapMax: [1, 1, 1],
        gamma: [1, 1, 1],
        hdrCapacityMin: 0,
        hdrCapacityMax: 1,
        offsetSdr: [0, 0, 0],
        offsetHdr: [0, 0, 0],
    });
    const parameters = gainMapDecoderParameters(source.metadata, new Texture(), new Texture());
    assert.equal(parameters.maxDisplayBoost, 2);
    assert.deepEqual(parameters.gainMapMin, [0, 0, 0]);
});

test('an already aborted load rejects without touching the renderer or the network', async () => {
    const controller = new AbortController();
    controller.abort();
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = () => { fetches++; throw new Error('network must not be used'); };
    const renderer = new Proxy({}, { get() { throw new Error('renderer must not be touched'); } });
    try {
        await assert.rejects(loadWebGpuEnvironment(renderer, 'https://example.com/env.jpg', { signal: controller.signal }),
            (error: Error) => error.name === 'AbortError');
        assert.equal(fetches, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('an abort during the request releases the load before the native decode starts', async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    let requests = 0;
    globalThis.fetch = (request: Request) => {
        requests++;
        return new Promise((_resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(request.signal.reason));
        });
    };
    const renderer = new Proxy({}, { get() { throw new Error('renderer must not be touched'); } });
    try {
        const pending = loadWebGpuEnvironment(renderer, 'https://example.com/aborted.jpg', { signal: controller.signal });
        controller.abort();
        await assert.rejects(pending, (error: Error) => error.name === 'AbortError');
        assert.equal(requests, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('the environment resource ledger disposes once, in reverse order, including late resources', () => {
    const order: string[] = [];
    const resources = new EnvironmentResources();
    assert.throws(() => resources.add(null as unknown as () => void), TypeError);
    resources.add(() => order.push('textures'));
    resources.add(() => order.push('decode'));
    resources.add(() => order.push('pmrem'));
    resources.dispose();
    assert.deepEqual(order, ['pmrem', 'decode', 'textures']);
    resources.dispose();
    assert.deepEqual(order, ['pmrem', 'decode', 'textures']);
    // A completion that arrives after disposal releases its resource immediately instead of leaking.
    resources.add(() => order.push('late'));
    assert.deepEqual(order, ['pmrem', 'decode', 'textures', 'late']);
});

test('model texture optimisation applies the reference settings to every material', () => {
    const anisotropy = 16;
    const renderer = { getMaxAnisotropy: () => anisotropy };
    const slots = (map: Texture) => new MeshStandardMaterial({
        map,
        normalMap: new Texture(),
        roughnessMap: new Texture(),
        metalnessMap: new Texture(),
    });
    const textured = slots(new Texture());
    const single = new Mesh(undefined, textured);
    const multi = new Mesh(undefined, [slots(new Texture()), slots(new Texture())]);
    const group = new Mesh(undefined, new MeshStandardMaterial());
    group.add(single, multi);

    optimizeWebGpuTextures(renderer, group);

    for (const material of [textured, ...(multi.material as MeshStandardMaterial[])]) {
        for (const texture of [material.map, material.normalMap, material.roughnessMap, material.metalnessMap]) {
            assert.equal(texture?.minFilter, LinearMipmapLinearFilter);
            assert.equal(texture?.magFilter, LinearFilter);
            assert.equal(texture?.anisotropy, anisotropy);
            assert.equal(texture?.generateMipmaps, true);
        }
    }
    // Untextured meshes are left alone instead of failing.
    optimizeWebGpuTextures(renderer, new Mesh(undefined, new MeshStandardMaterial()));
});

test('the environment module stays native, worker safe and free of WebGL state', async () => {
    const source = await readFile(ENVIRONMENT_MODULE, 'utf8');
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(specifiers)].sort(), ['@monogrid/gainmap-js/webgpu', 'three/webgpu']);
    for (const forbidden of ['WebGLRenderer', 'onBeforeCompile', 'ShaderMaterial', 'createElement', 'document.', 'window.', 'new Image(']) {
        assert.equal(source.includes(forbidden), false, `Environment.js must not reference ${forbidden}`);
    }
});
