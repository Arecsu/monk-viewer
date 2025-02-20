import { Uniform } from "three";
import { Effect } from "postprocessing";

import fragmentShader from "./dithering.frag?raw";

/**
 * VignetteEffect options.
 *
 * @category Effects
 */

export interface DitheringEffectOptions {

	/**
	 * The Vignette offset.
	 *
	 * @defaultValue 5.0
	 */

	intensity?: number;


}

/**
 * A vignette effect.
 *
 * @category Effects
 */

export class DitheringEffect extends Effect {

	/**
	 * Constructs a new vignette effect.
	 *
	 * @param options - The options.
	 */

	constructor({
		intensity = 3.0,
	}: DitheringEffectOptions = {}) {

		super("DitheringEffectOptions");

		this.fragmentShader = fragmentShader

		const uniforms = this.input.uniforms;
		uniforms.set("intensity", new Uniform(intensity / 1000));

	}

}