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
    processImages,
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
 * LIFO ownership ledger for one environment load. `dispose()` runs once; a resource that a
 * late completion adds afterwards is released immediately instead of leaking, which is what
 * keeps an aborted load safe.
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

/** Decodes the gain-map source into a half-float equirectangular render target. */
async function decodeGainMapSource(renderer, source, resources) {
    if (renderer.hasInitialized() === false) await renderer.init();

    // 'from-image' keeps the JPEG's own orientation. The WebGPU render target stores top row
    // first, and the quad's uv places v=1 at the top of the viewport, so the decoded equirect
    // ends up with v=0 at the bottom of the image like the reference GPU-rendered texture.
    const { sdrImage, gainMapImage, needsFlip } = await processImages(source.sdr.buffer, source.gainMap?.buffer, 'from-image');
    const { sdr, gainMap } = createTextures(sdrImage, gainMapImage, needsFlip);
    resources.add(() => {
        sdr.dispose();
        gainMap.dispose();
    });

    const material = new GainMapDecoderMaterial(gainMapDecoderParameters(source.metadata, sdr, gainMap));
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
    resources.add(() => quadRenderer.dispose(true));

    await quadRenderer.render();
    return quadRenderer.renderTarget.texture;
}

/** Prefilters the equirectangular HDR environment with the native WebGPU PMREM generator. */
function prefilterEnvironment(renderer, equirectangular, resources) {
    const generator = new GPU.PMREMGenerator(renderer);
    resources.add(() => generator.dispose());
    const target = generator.fromEquirectangular(equirectangular);
    resources.add(() => target.dispose());
    return target.texture;
}

/**
 * Loads a gain-map HDR environment for a native WebGPU renderer.
 *
 * Returns the half-float CubeUV PMREM (`scene.environment` consumes it directly) and a `dispose`
 * that releases the PMREM, the PMREM generator and the decode intermediates. `signal` aborts the
 * request; a decode that completes after the abort is disposed instead of retained.
 */
export async function loadWebGpuEnvironment(renderer, url, { signal } = {}) {
    const resources = new EnvironmentResources();
    try {
        const jpegBuffer = await loadJPEGBuffer(url, signal);
        signal?.throwIfAborted();
        const source = await extractGainMapSource(jpegBuffer, url);
        signal?.throwIfAborted();
        const equirectangular = await decodeGainMapSource(renderer, source, resources);
        signal?.throwIfAborted();
        const texture = prefilterEnvironment(renderer, equirectangular, resources);
        return { texture, dispose: () => resources.dispose() };
    } catch (error) {
        resources.dispose();
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
