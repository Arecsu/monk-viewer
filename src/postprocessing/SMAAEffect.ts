import { LinearFilter, NearestFilter, Texture } from "three";
import { SMAAEffect as BaseSMAAEffect, SMAAPreset } from "postprocessing";

// The lookup textures of postprocessing, see textures/smaa. Its loader decodes them with Image, which workers lack.
import searchImageDataURL from "./smaa/search.png?inline";
import areaImageDataURL from "./smaa/area.png?inline";

/**
 * SMAAEffect options.
 */

export interface SMAAEffectOptions {

    /**
     * The quality preset.
     *
     * @defaultValue SMAAPreset.HIGH
     */

    preset?: SMAAPreset;

}

/**
 * Decodes a PNG data URL without a DOM. ImageBitmap ignores texture.flipY, so the flip happens here.
 */

async function decodeImage(dataURL: string, flipY: boolean): Promise<ImageBitmap> {

    const bytes = Uint8Array.from(atob(dataURL.slice(dataURL.indexOf(",") + 1)), (c) => c.charCodeAt(0));

    return createImageBitmap(new Blob([bytes], { type: "image/png" }), {
        imageOrientation: flipY ? "flipY" : "from-image",
        premultiplyAlpha: "none",
        colorSpaceConversion: "none"
    });

}

/**
 * SMAA for display-referred input: expects to run after tone mapping, on an sRGB buffer.
 *
 * Edges are detected on sRGB-encoded values, like the reference implementation (its thresholds assume gamma space),
 * while the neighbourhood blend stays in linear space. Also works in an OffscreenCanvas worker.
 */

export class SMAAEffect extends BaseSMAAEffect {

    /**
     * Constructs a new SMAA effect.
     *
     * @param options - The options.
     */

    constructor({ preset = SMAAPreset.HIGH }: SMAAEffectOptions = {}) {

        super({ preset });

        const edgeDetectionMaterial = this.edgeDetectionMaterial;
        edgeDetectionMaterial.fragmentShader = edgeDetectionMaterial.fragmentShader
            .replace("void main(){", "vec3 sRGBEncode(const in vec3 c){return mix(c*12.92,1.055*pow(c,vec3(1.0/2.4))-0.055,step(vec3(0.0031308),c));}\nvoid main(){")
            .replace(/texture\(inputBuffer,(vUv\d?)\)\.rgb/g, "sRGBEncode(texture(inputBuffer,$1).rgb)");

    }

    /**
     * Loads the lookup textures. Replaces the Image based loader of the base class.
     */

    protected loadLookupTextures(): void {

        Promise.all([decodeImage(searchImageDataURL, true), decodeImage(areaImageDataURL, false)])
            .then(([searchImage, areaImage]) => {

                const searchTexture = new Texture(searchImage);
                searchTexture.name = "SMAA.Search";
                searchTexture.magFilter = NearestFilter;
                searchTexture.minFilter = NearestFilter;
                searchTexture.generateMipmaps = false;
                searchTexture.flipY = false;
                searchTexture.needsUpdate = true;

                const areaTexture = new Texture(areaImage);
                areaTexture.name = "SMAA.Area";
                areaTexture.magFilter = LinearFilter;
                areaTexture.minFilter = LinearFilter;
                areaTexture.generateMipmaps = false;
                areaTexture.flipY = false;
                areaTexture.needsUpdate = true;

                this.disposables.add(searchTexture);
                this.disposables.add(areaTexture);
                this.weightsMaterial.searchTexture = searchTexture;
                this.weightsMaterial.areaTexture = areaTexture;

            })
            .catch((error) => console.error("Failed to decode the SMAA lookup textures:", error));

    }

}

// The base constructor calls loadTextures(), which is private there, so it can't be overridden in the class body
(SMAAEffect.prototype as unknown as { loadTextures: () => void }).loadTextures =
    (SMAAEffect.prototype as unknown as { loadLookupTextures: () => void }).loadLookupTextures;
