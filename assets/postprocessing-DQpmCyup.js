import{m as s,n,o as d,c as h,p as l}from"./vendor-three-boZRr3xs.js";const u={name:"DitheringShader",uniforms:{tDiffuse:{value:null},resolution:{value:new s},ditherIntensity:{value:.5},ditherPattern:{value:0}},vertexShader:`
     varying vec2 vUv;
 
     void main() {
       vUv = uv;
       gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
     }
   `,fragmentShader:`
     uniform sampler2D tDiffuse;
     uniform vec2 resolution;
     uniform float ditherIntensity;
     uniform float ditherPattern;
     varying vec2 vUv;
 
     // Bayer matrix for ordered dithering
     const mat4 bayerMatrix = mat4(
       0.0/16.0,  8.0/16.0,  2.0/16.0, 10.0/16.0,
       12.0/16.0, 4.0/16.0, 14.0/16.0,  6.0/16.0,
       3.0/16.0, 11.0/16.0,  1.0/16.0,  9.0/16.0,
       15.0/16.0, 7.0/16.0, 13.0/16.0,  5.0/16.0
     );
 
     // Random function based on shader toy example
     float rand(vec2 co) {
       return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
     }
 
     // Noise-based dithering
     vec3 noiseDithering(vec3 color, vec2 fragCoord) {
       float grid_position = rand(fragCoord);
       vec3 dither_shift_RGB = vec3(0.25 / 255.0, -0.25 / 255.0, 0.25 / 255.0);
       dither_shift_RGB = mix(2.0 * dither_shift_RGB, -2.0 * dither_shift_RGB, grid_position);
       return color + dither_shift_RGB * ditherIntensity;
     }
 
     // Ordered dithering using Bayer matrix
     vec3 orderedDithering(vec3 color, vec2 fragCoord) {
       // Get Bayer matrix value for this pixel
       ivec2 pixelCoord = ivec2(fragCoord);
       float bayerValue = bayerMatrix[pixelCoord.x % 4][pixelCoord.y % 4];
       
       // Add noise based on Bayer matrix and intensity
       vec3 ditheredColor = color + (bayerValue - 0.5) * ditherIntensity * 0.1;
       return ditheredColor;
     }
 
     void main() {
       vec4 texel = texture2D(tDiffuse, vUv);
       
       // Select dithering method based on ditherPattern
       vec3 ditheredColor;
       if (ditherPattern == 0.0) {
         // Noise-based dithering (default)
         ditheredColor = noiseDithering(texel.rgb, gl_FragCoord.xy);
       } else {
         // Ordered dithering
         ditheredColor = orderedDithering(texel.rgb, gl_FragCoord.xy);
       }
 
       gl_FragColor = vec4(ditheredColor, texel.a);
     }
   `};class c extends n{constructor(e={}){super();const{width:r=800,height:i=600,intensity:a=.5,pattern:o=0}=e,t=u;this.uniforms=d.clone(t.uniforms),this.material=new h({name:t.name,uniforms:this.uniforms,vertexShader:t.vertexShader,fragmentShader:t.fragmentShader}),this.uniforms.resolution.value.set(r,i),this.uniforms.ditherIntensity.value=a,this.uniforms.ditherPattern.value=o,this.fsQuad=new l(this.material)}render(e,r,i,a){this.uniforms.tDiffuse.value=i.texture;const o=e.getSize(new s);this.uniforms.resolution.value.copy(o),this.renderToScreen?(e.setRenderTarget(null),this.fsQuad.render(e)):(e.setRenderTarget(r),this.clear&&e.clear(),this.fsQuad.render(e))}setIntensity(e){this.uniforms.ditherIntensity.value=e}setPattern(e){this.uniforms.ditherPattern.value=e}dispose(){this.material.dispose(),this.fsQuad.dispose()}}export{c as D};
