import { Uniform } from "three";
import { Effect, LightenBlendFunction } from "postprocessing";
import type { BlendFunction } from "postprocessing";

import fragmentShader from "./noise.frag?raw";

export interface NoiseEffectOptions {
   intensity?: number;
   speed?: number;
   mean?: number;
   variance?: number;
   blendMode?: (new (...args: any[]) => BlendFunction)
}

export class NoiseEffect extends Effect {
   constructor({
       intensity = 0.0025,
       speed = 2.0,
       mean = 0.5,
       variance = 0.2,
       blendMode = LightenBlendFunction
   }: NoiseEffectOptions = {}) {
       super("NoiseEffect");

       this.fragmentShader = fragmentShader;
       this.blendMode.blendFunction = new blendMode();
       const uniforms = this.input.uniforms;
         uniforms.set("intensity", new Uniform(intensity));
         uniforms.set("speed", new Uniform(speed));
         uniforms.set("mean", new Uniform(mean));
         uniforms.set("variance", new Uniform(variance));
   }

   get intensity() { return this.input.uniforms.get("intensity")!.value; }
   set intensity(value) { this.input.uniforms.get("intensity")!.value = value; }

   get speed() { return this.input.uniforms.get("speed")!.value; }
   set speed(value) { this.input.uniforms.get("speed")!.value = value; }

   get mean() { return this.input.uniforms.get("mean")!.value; }
   set mean(value) { this.input.uniforms.get("mean")!.value = value; }

   get variance() { return this.input.uniforms.get("variance")!.value; }
   set variance(value) { this.input.uniforms.get("variance")!.value = value; }

}