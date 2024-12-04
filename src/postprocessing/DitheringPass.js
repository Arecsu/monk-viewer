import {
   ShaderMaterial,
   UniformsUtils,
   Vector2
} from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { DitheringShader } from './DitheringShader.js';

class DitheringPass extends Pass {
   constructor(options = {}) {
       super();

       const {
           width = 800, 
           height = 600,
           intensity = 0.5,  // Default intensity
           pattern = 0       // Default to noise-based dithering
       } = options;

       const shader = DitheringShader;

       this.uniforms = UniformsUtils.clone(shader.uniforms);

       this.material = new ShaderMaterial({
           name: shader.name,
           uniforms: this.uniforms,
           vertexShader: shader.vertexShader,
           fragmentShader: shader.fragmentShader
       });

       // Set initial parameters
       this.uniforms.resolution.value.set(width, height);
       this.uniforms.ditherIntensity.value = intensity;
       this.uniforms.ditherPattern.value = pattern;

       this.fsQuad = new FullScreenQuad(this.material);
   }

   render(renderer, writeBuffer, readBuffer, deltaTime /*, maskActive */) {
       this.uniforms['tDiffuse'].value = readBuffer.texture;

       const size = renderer.getSize(new Vector2());
       this.uniforms.resolution.value.copy(size);

       if (this.renderToScreen) {
           renderer.setRenderTarget(null);
           this.fsQuad.render(renderer);
       } else {
           renderer.setRenderTarget(writeBuffer);
           if (this.clear) renderer.clear();
           this.fsQuad.render(renderer);
       }
   }

   // Methods to adjust dithering parameters
   setIntensity(intensity) {
       this.uniforms.ditherIntensity.value = intensity;
   }

   setPattern(pattern) {
       this.uniforms.ditherPattern.value = pattern;
   }

   dispose() {
       this.material.dispose();
       this.fsQuad.dispose();
   }
}

export { DitheringPass };