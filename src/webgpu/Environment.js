// Native WebGPU HDR environment: gain-map JPEG reconstruction plus native PMREM prefiltering.
// Nothing here creates, borrows or falls back to a WebGL renderer, and no browser-only DOM API is
// used at module scope, so the module can be imported by the renderer worker as well.
import * as GPU from 'three/webgpu';
import {
    GainMapDecoderMaterial,
    GainMapNotFoundError,
    QuadRenderer,
    XMPMetadataNotFoundError,
    createTextures,
    extractGainmapFromJPEG,
} from '@monogrid/gainmap-js/webgpu';

/**
 * Gain-map metadata the reference loader substitutes when a JPEG carries no gain map.
 * The SDR image is then decoded through a zero recovery gain map, so the result stays the
 * gamut-mapped SDR image instead of a boosted one.
 */
export const SDR_ONLY_GAIN_MAP_METADATA = Object.freeze({
    gainMapMin: Object.freeze([0, 0, 0]),
    gainMapMax: Object.freeze([1, 1, 1]),
    gamma: Object.freeze([1, 1, 1]),
    hdrCapacityMin: 0,
    hdrCapacityMax: 1,
    offsetSdr: Object.freeze([0, 0, 0]),
    offsetHdr: Object.freeze([0, 0, 0]),
});

// Reference GLTF texture optimisation targets: the model's authored color and PBR maps.
const MODEL_TEXTURE_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap'];

/**
 * LIFO ownership ledger. `dispose()` runs once; a resource that a late completion adds afterwards
 * is released immediately instead of leaking, which is what keeps an aborted load safe.
 */
export class EnvironmentResources {
    #disposers = [];
    #disposed = false;

    add(disposer) {
        if (typeof disposer !== 'function') throw new TypeError('EnvironmentResources.add() expects a dispose function');
        if (this.#disposed) {
            disposer();
            return;
        }
        this.#disposers.push(disposer);
    }

    dispose() {
        if (this.#disposed) return;
        this.#disposed = true;
        for (let i = this.#disposers.length - 1; i >= 0; --i) this.#disposers[i]();
        this.#disposers.length = 0;
    }
}

/**
 * Splits a gain-map JPEG into its SDR image, recovery (gain map) image and ISO 21496-1 or
 * Ultra HDR XMP metadata. A JPEG without gain-map metadata keeps the reference fallback: the
 * single SDR image with {@link SDR_ONLY_GAIN_MAP_METADATA} and a warning instead of an error.
 */
export async function extractGainMapSource(jpegBuffer, url = '') {
    try {
        const { sdr, gainMap, metadata } = await extractGainmapFromJPEG(jpegBuffer);
        return { sdr, gainMap, metadata };
    } catch (error) {
        if (!(error instanceof XMPMetadataNotFoundError) && !(error instanceof GainMapNotFoundError)) throw error;
        console.warn(`Failure to reconstruct an HDR image from ${url}: gain map metadata not found in the file, the WebGPU environment decodes the SDR jpeg`);
        return { sdr: jpegBuffer, gainMap: undefined, metadata: SDR_ONLY_GAIN_MAP_METADATA };
    }
}

/**
 * Decode-material parameters for a gain-map source, mapped exactly as the reference loader does:
 * the display boost is the metadata's HDR capacity, so the reconstruction reaches the authored
 * gain map range and scene-linear values above 1 survive.
 */
export function gainMapDecoderParameters(metadata, sdr, gainMap) {
    return {
        gamma: metadata.gamma,
        offsetSdr: metadata.offsetSdr,
        offsetHdr: metadata.offsetHdr,
        gainMapMin: metadata.gainMapMin,
        gainMapMax: metadata.gainMapMax,
        hdrCapacityMin: metadata.hdrCapacityMin,
        hdrCapacityMax: metadata.hdrCapacityMax,
        maxDisplayBoost: Math.pow(2, metadata.hdrCapacityMax),
        sdr,
        gainMap,
    };
}

/**
 * Decodes the SDR and gain-map JPEGs with `createImageBitmap`. The native path has no HTML image
 * fallback, so this stays worker safe. `'from-image'` keeps the JPEG's own orientation, and the
 * textures below disable `flipY`, which is what the reference WebGPU decode renders from.
 *
 * Both decodes are awaited before a failure is reported, so a sibling bitmap is closed instead of
 * leaked when only one of the two images cannot be decoded.
 */
export async function createSourceImages(sdrBuffer, gainMapBuffer, createBitmap = globalThis.createImageBitmap) {
    if (typeof createBitmap !== 'function') {
        throw new Error('Gain map environment decoding needs createImageBitmap; the native path has no HTML image fallback');
    }
    const options = { imageOrientation: 'from-image' };
    const decodes = await Promise.allSettled([
        createBitmap(new Blob([sdrBuffer], { type: 'image/jpeg' }), options),
        gainMapBuffer === undefined
            ? Promise.resolve(undefined)
            : createBitmap(new Blob([gainMapBuffer], { type: 'image/jpeg' }), options),
    ]);
    const images = decodes.map((decode) => decode.status === 'fulfilled' ? decode.value : undefined);
    const failed = decodes.find((decode) => decode.status === 'rejected');
    if (failed !== undefined) {
        for (const image of images) image?.close();
        throw failed.reason;
    }
    return { sdrImage: images[0], gainMapImage: images[1] };
}

/**
 * Races a promise that cannot be cancelled against `signal`. The abort listener is always removed
 * and a late settlement is ignored, so a JPEG whose gain-map metadata carries no second image —
 * the ISO/MPF extractor then never settles — cannot hold up a cancelled initialization.
 */
export function abortable(promise, signal) {
    if (signal === undefined) return promise;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
        const settle = (callback) => (value) => {
            signal.removeEventListener('abort', onAbort);
            callback(value);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(settle(resolve), settle(reject));
    });
}

/** Decodes the gain-map source into a half-float equirectangular render target. */
async function decodeGainMapSource(renderer, source, scratch) {
    if (renderer.hasInitialized() === false) await renderer.init();

    const { sdrImage, gainMapImage } = await createSourceImages(source.sdr, source.gainMap);
    // Registered before the textures exist, so a later constructor failure cannot leak the bitmaps:
    // Texture.dispose() releases GPU memory only, never the CPU image data.
    scratch.add(() => {
        sdrImage.close();
        gainMapImage?.close();
    });

    // `false` = no texture flip; the bitmaps were decoded with 'from-image' above.
    const { sdr, gainMap } = createTextures(sdrImage, gainMapImage, false);
    scratch.add(() => {
        sdr.dispose();
        gainMap.dispose();
    });

    const material = new GainMapDecoderMaterial(gainMapDecoderParameters(source.metadata, sdr, gainMap));
    scratch.add(() => material.dispose());

    const quadRenderer = new QuadRenderer({
        width: sdrImage.width,
        height: sdrImage.height,
        type: GPU.HalfFloatType,
        colorSpace: GPU.LinearSRGBColorSpace,
        material,
        renderer,
        renderTargetOptions: {
            mapping: GPU.EquirectangularReflectionMapping,
            // The native PMREM samples this level 0 explicitly, so trilinear mip filtering on a
            // render-target texture would only add unused mips; keep the anisotropy the reference
            // configured on the HDR environment.
            minFilter: GPU.LinearFilter,
            magFilter: GPU.LinearFilter,
            generateMipmaps: false,
            anisotropy: renderer.getMaxAnisotropy(),
            wrapS: GPU.ClampToEdgeWrapping,
            wrapT: GPU.ClampToEdgeWrapping,
        },
    });
    // QuadRenderer owns the render target, the decode material and the quad geometry; the SDR and
    // gain map source textures live inside its TSL nodes and are disposed above.
    scratch.add(() => quadRenderer.dispose(true));

    await quadRenderer.render();
    return quadRenderer.renderTarget.texture;
}

/**
 * Prefilters the equirectangular HDR environment with the native WebGPU PMREM generator. The
 * generator is scratch (it terminates once the PMREM exists); the PMREM target is the only
 * resource that outlives the load.
 */
function prefilterEnvironment(renderer, equirectangular, scratch, environment) {
    const generator = new GPU.PMREMGenerator(renderer);
    scratch.add(() => generator.dispose());
    const target = generator.fromEquirectangular(equirectangular);
    environment.add(() => target.dispose());
    return target.texture;
}

/**
 * Loads a gain-map HDR environment for a native WebGPU renderer.
 *
 * Returns the half-float CubeUV PMREM (`scene.environment` consumes it directly) and a `dispose`
 * that releases it. The decode render target, its textures, the source bitmaps and the PMREM
 * generator are released as soon as the device reports the submitted work done, so a loaded
 * environment retains only the PMREM. `signal` aborts the request; work that completes after an
 * abort is released instead of returned.
 */
export async function loadWebGpuEnvironment(renderer, url, { signal } = {}) {
    const scratch = new EnvironmentResources();
    const environment = new EnvironmentResources();
    let released = false;
    // The decode and PMREM passes are only submitted to the queue, so their intermediates must live
    // until the device reports that work done; disposing them earlier would free textures a live
    // command buffer still reads.
    const releaseScratch = async () => {
        if (released) return;
        released = true;
        try {
            await waitForSubmittedWork(renderer);
        } catch {
            // A lost device already dropped that work; the JS-side references still have to go.
        }
        scratch.dispose();
    };

    try {
        const jpegBuffer = await loadJPEGBuffer(url, signal);
        signal?.throwIfAborted();
        const source = await abortable(extractGainMapSource(jpegBuffer, url), signal);
        signal?.throwIfAborted();
        const equirectangular = await decodeGainMapSource(renderer, source, scratch);
        signal?.throwIfAborted();
        const texture = prefilterEnvironment(renderer, equirectangular, scratch, environment);
        await releaseScratch();
        signal?.throwIfAborted();
        return { texture, dispose: () => environment.dispose() };
    } catch (error) {
        await releaseScratch();
        environment.dispose();
        if (error?.name === 'AbortError') throw error;
        throw new Error(`Failed to load HDR environment: ${error}`, { cause: error });
    }
}

async function loadJPEGBuffer(url, signal) {
    signal?.throwIfAborted();
    const loader = new GPU.FileLoader();
    loader.setResponseType('arraybuffer');
    const abort = () => loader.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
        return new Uint8Array(await loader.loadAsync(url));
    } finally {
        signal?.removeEventListener('abort', abort);
    }
}

/** Resolves when the WebGPU queue finished everything submitted so far. */
async function waitForSubmittedWork(renderer) {
    const queue = renderer.backend?.device?.queue;
    if (queue?.onSubmittedWorkDone === undefined) return;
    await queue.onSubmittedWorkDone();
}

/**
 * Applies the reference GLTF texture optimisation to a loaded model: mipmapped trilinear
 * minification, linear magnification and the device's maximum anisotropy on the color and PBR
 * maps. Multi-material meshes are handled per material.
 */
export function optimizeWebGpuTextures(renderer, model) {
    const anisotropy = renderer.getMaxAnisotropy();
    model.traverse((child) => {
        if (child.isMesh !== true) return;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
            if (!material) continue;
            for (const slot of MODEL_TEXTURE_SLOTS) applyTextureOptimization(material[slot], anisotropy);
        }
    });
}

function applyTextureOptimization(texture, anisotropy) {
    if (!texture) return;
    texture.minFilter = GPU.LinearMipmapLinearFilter;
    texture.magFilter = GPU.LinearFilter;
    texture.anisotropy = anisotropy;
    texture.generateMipmaps = true;
}
