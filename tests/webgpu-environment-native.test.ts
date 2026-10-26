import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import {
    CubeUVReflectionMapping,
    HalfFloatType,
    LinearFilter,
    LinearMipmapLinearFilter,
    LinearSRGBColorSpace,
    Mesh,
    MeshStandardMaterial,
    PMREMGenerator,
    RenderTarget,
    Texture,
} from 'three/webgpu';
import { GainMapDecoderMaterial } from '@monogrid/gainmap-js/webgpu';
import {
    EnvironmentResources,
    SDR_ONLY_GAIN_MAP_METADATA,
    abortable,
    createSourceImages,
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

/**
 * A JPEG whose XMP gain-map metadata parses but that carries no MPF second image: the installed
 * ISO/MPF extractor then never settles, which is the cancellation case the loader has to escape.
 */
function hangingGainMapJpeg(): Uint8Array {
    const xmp = '<?xpacket?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><Description hdrgm:HDRCapacityMin="0" hdrgm:HDRCapacityMax="4" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/"><hdrgm:GainMapMax>4</hdrgm:GainMapMax></Description></rdf:RDF></x:xmpmeta>';
    const xmpBytes = new TextEncoder().encode(xmp);
    const padding = new Array(16).fill(0x11);
    return new Uint8Array([
        0xff, 0xd8,
        0xff, 0xe1, (xmpBytes.length + 2) >> 8, (xmpBytes.length + 2) & 0xff, ...xmpBytes,
        0xff, 0xe2, (padding.length + 2) >> 8, (padding.length + 2) & 0xff, ...padding,
    ]);
}

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

/** Records every RenderTarget / PMREMGenerator dispose between `run()` calls. */
async function recordDisposals<T>(run: (record: { targets: RenderTarget[]; generators: number }) => Promise<T>) {
    const record = { targets: [] as RenderTarget[], generators: 0 };
    const originalTargetDispose = RenderTarget.prototype.dispose;
    const originalGeneratorDispose = PMREMGenerator.prototype.dispose;
    RenderTarget.prototype.dispose = function dispose(this: RenderTarget) {
        record.targets.push(this);
        return originalTargetDispose.call(this);
    };
    PMREMGenerator.prototype.dispose = function dispose(this: PMREMGenerator) {
        record.generators++;
        return originalGeneratorDispose.call(this);
    };
    try {
        return { record, result: await run(record) };
    } finally {
        RenderTarget.prototype.dispose = originalTargetDispose;
        PMREMGenerator.prototype.dispose = originalGeneratorDispose;
    }
}

/**
 * Renderer stand-in for the native backend: records render targets and the queue wait and never
 * touches a GPU, so the real decode/PMREM code paths run in Node.
 */
function createFakeRenderer({ failRenderCall }: { failRenderCall?: number } = {}) {
    const events: string[] = [];
    const targets: unknown[] = [];
    let renderCalls = 0;
    const renderer = {
        isWebGLRenderer: false,
        autoClear: true,
        hasInitialized: () => true,
        init: async () => {},
        getMaxAnisotropy: () => 16,
        getRenderTarget: () => null,
        getActiveCubeFace: () => 0,
        getActiveMipmapLevel: () => 0,
        setRenderTarget: (target: unknown) => {
            if (target !== null) targets.push(target);
        },
        getClearColor: (color: unknown) => color,
        render: () => {
            renderCalls++;
            if (failRenderCall === renderCalls) {
                events.push('renderFailed');
                throw new Error('render failed');
            }
            events.push(`render${renderCalls}`);
        },
        backend: { device: { queue: { onSubmittedWorkDone: async () => { events.push('queueDone'); } } } },
    };
    return { renderer, events, targets, renderCalls: () => renderCalls };
}

function installBitmapFactory({ failIndex }: { failIndex?: number } = {}) {
    const created: { id: number; orientation?: string; type?: string; closed: number }[] = [];
    const original = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
    const factory = async (blob: Blob, bitmapOptions?: { imageOrientation?: string }) => {
        const bitmap = {
            id: created.length + 1,
            orientation: bitmapOptions?.imageOrientation,
            type: blob.type,
            width: 4096,
            height: 2048,
            closed: 0,
            close() { bitmap.closed++; },
        };
        created.push(bitmap);
        if (failIndex === created.length) throw new Error('bitmap decode failed');
        return bitmap;
    };
    Object.defineProperty(globalThis, 'createImageBitmap', { value: factory, configurable: true, writable: true });
    return {
        created,
        restore: () => {
            if (original === undefined) delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
            else Object.defineProperty(globalThis, 'createImageBitmap', original);
        },
    };
}

function installFetch(bytes: Uint8Array) {
    const original = globalThis.fetch;
    let requests = 0;
    const fetchStub = async () => {
        requests++;
        // A response without a body stream skips the loader's progress streaming.
        return {
            status: 200,
            body: undefined,
            url: 'https://example.com/environment.jpg',
            arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
    };
    globalThis.fetch = fetchStub as unknown as typeof fetch;
    return { requests: () => requests, restore: () => { globalThis.fetch = original; } };
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

test('a failed sibling decode closes the bitmap that did decode', async () => {
    const bitmaps = installBitmapFactory({ failIndex: 2 });
    try {
        await assert.rejects(createSourceImages(new Uint8Array([1]), new Uint8Array([2])), /bitmap decode failed/);
        assert.equal(bitmaps.created.length, 2);
        assert.equal(bitmaps.created[0].closed, 1);
        assert.equal(bitmaps.created[1].closed, 0);
    } finally {
        bitmaps.restore();
    }
});

test('source bitmaps keep the reference orientation and JPEG source type', async () => {
    const bitmaps = installBitmapFactory();
    try {
        const images = await createSourceImages(new Uint8Array([1]), new Uint8Array([2]));
        assert.deepEqual(bitmaps.created.map((bitmap) => bitmap.orientation), ['from-image', 'from-image']);
        assert.deepEqual(bitmaps.created.map((bitmap) => bitmap.type), ['image/jpeg', 'image/jpeg']);
        assert.equal(images.sdrImage, bitmaps.created[0]);
        assert.equal(images.gainMapImage, bitmaps.created[1]);
        assert.equal(bitmaps.created[0].closed, 0);
    } finally {
        bitmaps.restore();
    }
});

test('the native path has no HTML image fallback when createImageBitmap is missing', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
    delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
    try {
        await assert.rejects(createSourceImages(new Uint8Array([1])), /createImageBitmap/);
    } finally {
        if (original !== undefined) Object.defineProperty(globalThis, 'createImageBitmap', original);
    }
});

test('abortable removes its listener when the raced promise wins and rejects on abort', async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    let added = 0;
    let removed = 0;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<typeof add>) => { added++; return add(...args); }) as typeof add;
    signal.removeEventListener = ((...args: Parameters<typeof remove>) => { removed++; return remove(...args); }) as typeof remove;

    assert.equal(await abortable(Promise.resolve('decoded'), signal), 'decoded');
    assert.equal(added, 1);
    assert.equal(removed, 1);

    const hanging = new Promise(() => {});
    const aborted = abortable(hanging, controller.signal);
    controller.abort();
    await assert.rejects(aborted, (error: Error) => error.name === 'AbortError');
    // `{ once: true }` removes the listener without a second explicit call.
    assert.equal(added, 2);
    assert.equal(removed, 1);
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

test('an abort escapes a gain-map extraction that never settles', { timeout: 5_000 }, async () => {
    const fetchStub = installFetch(hangingGainMapJpeg());
    const renderer = new Proxy({}, { get() { throw new Error('renderer must not be touched'); } });
    const controller = new AbortController();
    try {
        const pending = loadWebGpuEnvironment(renderer, 'https://example.com/hanging.jpg', { signal: controller.signal });
        // Let the request finish and the extraction reach the point where it never settles.
        await new Promise((resolve) => setTimeout(resolve, 25));
        controller.abort();
        await assert.rejects(pending, (error: Error) => error.name === 'AbortError');
        assert.equal(fetchStub.requests(), 1);
    } finally {
        fetchStub.restore();
    }
});

test('a loaded environment retains only the PMREM, released after the queue finished', async () => {
    const jpegBuffer = new Uint8Array(await readFile(GAIN_MAP_ENVIRONMENTS[1].path));
    const fetchStub = installFetch(jpegBuffer);
    const bitmaps = installBitmapFactory();
    const { renderer, events, targets } = createFakeRenderer();
    try {
        const { result: state } = await recordDisposals(async (record) => {
            const environment = await loadWebGpuEnvironment(renderer, 'https://example.com/lifecycle.jpg');
            const pmremTarget = environment.texture.renderTarget as RenderTarget;
            const afterLoad = {
                equirectDisposed: record.targets.includes(targets[0] as RenderTarget),
                pmremDisposed: record.targets.includes(pmremTarget),
                generators: record.generators,
                disposals: record.targets.length,
            };
            environment.dispose();
            const afterDispose = {
                pmremDisposed: record.targets.includes(pmremTarget),
                disposals: record.targets.length,
            };
            environment.dispose();
            return { texture: environment.texture, afterLoad, afterDispose, idempotentDisposals: record.targets.length };
        });

        assert.equal(state.texture.mapping, CubeUVReflectionMapping);
        assert.equal(state.texture.isPMREMTexture, true);
        assert.equal(state.texture.type, HalfFloatType);
        assert.equal(state.texture.colorSpace, LinearSRGBColorSpace);
        assert.deepEqual([state.texture.image.width, state.texture.image.height], [3072, 4096]);

        // Both bitmaps decoded with the JPEG's own orientation and were released exactly once.
        assert.equal(bitmaps.created.length, 2);
        assert.deepEqual(bitmaps.created.map((bitmap) => bitmap.closed), [1, 1]);
        // Release happens only after the device reported the submitted decode/PMREM work done.
        assert.deepEqual(events.slice(0, 2), ['render1', 'render2']);
        assert.ok(events.indexOf('queueDone') > 0);
        // The decode render target and the PMREM generator are scratch; the PMREM target survives.
        assert.equal(state.afterLoad.equirectDisposed, true);
        assert.equal(state.afterLoad.pmremDisposed, false);
        assert.equal(state.afterLoad.generators, 1);

        assert.equal(state.afterDispose.pmremDisposed, true);
        assert.ok(state.afterDispose.disposals > state.afterLoad.disposals);
        assert.equal(state.idempotentDisposals, state.afterDispose.disposals);
    } finally {
        bitmaps.restore();
        fetchStub.restore();
    }
});

test('a failure after the decode material exists releases every intermediate', async () => {
    const jpegBuffer = new Uint8Array(await readFile(GAIN_MAP_ENVIRONMENTS[0].path));
    const fetchStub = installFetch(jpegBuffer);
    const bitmaps = installBitmapFactory();
    const { renderer, targets } = createFakeRenderer({ failRenderCall: 2 });
    try {
        const { record, result: error } = await recordDisposals(async () => {
            try {
                await loadWebGpuEnvironment(renderer, 'https://example.com/failing.jpg');
                return;
            } catch (caught) {
                return caught as Error;
            }
        });
        assert.ok(error instanceof Error);
        assert.match(error.message, /^Failed to load HDR environment: /);
        assert.equal((error.cause as Error).message, 'render failed');
        assert.deepEqual(bitmaps.created.map((bitmap) => bitmap.closed), [1, 1]);
        assert.ok(record.targets.includes(targets[0] as RenderTarget));
        assert.equal(record.generators, 1);
    } finally {
        bitmaps.restore();
        fetchStub.restore();
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
