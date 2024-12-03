import{m as l,n as v,o as P,c as x,p as R,a as y,q as w,r as S,s as b,S as M,t as k,u as F,W as C,b as E,H as c,E as T,v as D,w as L,x as z,G as O,A as H,y as d,L as p,z as _,J as A}from"./vendor-three-7acuM1Fa.js";import{H as j}from"./gainmap-js-Bil_ZXcA.js";const B={uniforms:{tDiffuse:{value:null},resolution:{value:new l},ditherIntensity:{value:.5},ditherPattern:{value:0}},vertexShader:`
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
  `};class G extends v{constructor(e={}){super();const{width:t=800,height:i=600,intensity:s=.5,pattern:n=0}=e,r=B;this.uniforms=P.clone(r.uniforms),this.material=new x({name:r.name,uniforms:this.uniforms,vertexShader:r.vertexShader,fragmentShader:r.fragmentShader}),this.uniforms.resolution.value.set(t,i),this.uniforms.ditherIntensity.value=s,this.uniforms.ditherPattern.value=n,this.fsQuad=new R(this.material)}render(e,t,i,s){this.uniforms.tDiffuse.value=i.texture;const n=e.getSize(new l);this.uniforms.resolution.value.copy(n),this.renderToScreen?(e.setRenderTarget(null),this.fsQuad.render(e)):(e.setRenderTarget(t),this.clear&&e.clear(),this.fsQuad.render(e))}setIntensity(e){this.uniforms.ditherIntensity.value=e}setPattern(e){this.uniforms.ditherPattern.value=e}dispose(){this.material.dispose(),this.fsQuad.dispose()}}var I="/monk-viewer/assets/McLovin-1024x-DrI75Pld.glb",U="/monk-viewer/assets/old_bus_depot_2k_HDR-CghB0eNo.jpg";const V=o=>o.reduce((e,t)=>e+t,0)/o.length;class q{constructor(e){this.canvas=e.canvas,this.inputElement=e.inputElement,this.lowPerformanceMode=e.lowPerformanceMode,this.baseLoadPixelRatio=e.pixelRatio||window.devicePixelRatio,this.initialRenderPixelRatio=this.lowPerformanceMode?e.pixelRatio/2:this.baseLoadPixelRatio,this.performantRenderPixelRatio=null,this.msaaSamples=this.lowPerformanceMode?0:4,this.pixelRatioVariation=1,this.scene=null,this.camera=null,this.renderer=null,this.composer=null,this.controls=null,this.mixer=null,this.pickHelper=null,this.lastResizeTime=null,this.throttleResize=150,this.lastFrame=Date.now(),this.initScene()}initScene(){this.setupRenderer(),this.setupCamera(),this.setupControls(),this.setupScene(),this.setupPostProcessing(),this.setupInteraction(),this.loadAssets()}setupRenderer(){this.renderer=new y({powerPreference:"high-performance",antialias:!0,canvas:this.canvas}),this.renderer.setPixelRatio(this.initialRenderPixelRatio),this.renderer.toneMapping=w,this.renderer.toneMappingExposure=1.5}setupCamera(){this.camera=new S(50,2,.1,100),this.camera.position.z=.8}setupControls(){this.controls=new b(this.camera,this.inputElement),this.controls.enableDamping=!0,this.controls.dampingFactor=.055,this.controls.target.set(0,0,0),this.controls.update()}setupScene(){this.scene=new M,this.scene.background=new k(0)}setupLighting(){const e=new F(16777215,10);e.position.set(0,0,5),this.scene.add(e)}setupPostProcessing(){const e=new C(this.inputElement.clientWidth,this.inputElement.clientHeight,{samples:this.msaaSamples,anisotropy:this.renderer.capabilities.getMaxAnisotropy(),colorSpace:E,type:c});this.composer=new T(this.renderer,e);const t=new D(this.scene,this.camera);this.composer.addPass(t);const i=new L(new l(this.inputElement.clientWidth,this.inputElement.clientHeight),.15,.9,.1);this.composer.addPass(i),this.composer.addPass(new z),this.composer.addPass(new G({intensity:5,pattern:0}))}resetPostProcessing(){this.composer.dispose(),this.composer=null,this.setupPostProcessing(),this.handleResize(!0)}setupInteraction(){this.pickPosition={x:-2,y:-2},this.pickHelper=new W,this.clearPickPosition(),this.inputElement.addEventListener("mousemove",this.setPickPosition.bind(this)),this.inputElement.addEventListener("mouseout",this.clearPickPosition.bind(this)),this.inputElement.addEventListener("mouseleave",this.clearPickPosition.bind(this)),this.inputElement.addEventListener("contextmenu",()=>{console.log("hi")}),this.setupTouchEvents()}setupTouchEvents(){this.inputElement.addEventListener("touchstart",e=>{e.preventDefault(),this.setPickPosition(e.touches[0])},{passive:!1}),this.inputElement.addEventListener("touchmove",e=>{this.setPickPosition(e.touches[0])}),this.inputElement.addEventListener("touchend",()=>{this.clearPickPosition()})}loadAssets(){this.loadArtworkModel(),this.loadHDREnvironment()}loadArtworkModel(){new O().load(I,async t=>{const i=t.scene;i.scale.set(1,1,1),this.optimizeModelTextures(i),await this.renderer.compileAsync(i,this.camera,this.scene),this.mixer=new H(i),this.mixer.clipAction(t.animations[0]),this.scene.add(i),this.startPerformanceSamplingLoop()})}optimizeModelTextures(e){e.traverse(t=>{t.isMesh&&(this.applyTextureOptimization(t.material.map),this.applyTextureOptimization(t.material.normalMap),this.applyTextureOptimization(t.material.roughnessMap),this.applyTextureOptimization(t.material.metalnessMap))})}applyTextureOptimization(e){e&&(e.minFilter=d,e.magFilter=p,e.anisotropy=this.renderer.capabilities.getMaxAnisotropy(),e.generateMipmaps=!0)}loadHDREnvironment(){new j(this.renderer).load(U,t=>{const i=t.renderTarget.texture;this.configureHDRTexture(i),this.scene.environment=i,this.scene.environment.mapping=_,t.dispose()})}configureHDRTexture(e){e.type=c,e.minFilter=d,e.magFilter=p,e.generateMipmaps=!0,e.needsUpdate=!0}startPerformanceSamplingLoop(){let e=0,t=0;const i=[],s=5,n=r=>{r*=.001;const m=Date.now();if(this.handleResize(),this.updateScene(r,m),this.composer.render(),t++,r>=e+.1){const u=t/(r-e);if(i.push(u),e=r,t=0,i.length>=s){const a=V(i.slice(3)),f=75;if(console.log("maxfps: ",a),console.log("fpssamples: ",i),a<50&&this.msaaSamples>0&&(this.msaaSamples=0,this.resetPostProcessing()),a<30){const g=a/f,h=Math.sqrt(this.initialRenderPixelRatio**2.6*g);this.performantRenderPixelRatio=Math.max(.8,Math.min(h,this.initialRenderPixelRatio)),console.log(h)}this.startRenderLoop();return}}requestAnimationFrame(n)};requestAnimationFrame(n)}startRenderLoop(){let e=0,t=0;const i=s=>{s*=.001;const n=Date.now();if(t++,s>=e+1){const r=t/(s-e);console.log(r),e=s,t=0}this.handleResize(),this.updateScene(s,n),this.composer.render(),requestAnimationFrame(i)};requestAnimationFrame(i)}handleResize(e=!1){const{clientWidth:t,clientHeight:i,pixelRatio:s}=this.inputElement;this.pixelRatioVariation=s/this.baseLoadPixelRatio;const n=this.performantRenderPixelRatio?this.performantRenderPixelRatio*this.pixelRatioVariation:this.initialRenderPixelRatio?this.initialRenderPixelRatio*this.pixelRatioVariation:window.devicePixelRatio,r=Date.now();(e||this.needsResize(r,t,i,n))&&(this.updateRendererSize(t,i,n),this.lastResizeTime=r,this.camera.aspect=t/i,this.camera.updateProjectionMatrix())}needsResize(e,t,i,s){if(e-this.lastResizeTime<this.throttleResize)return!1;const n=this.renderer.domElement;return n.width!==Math.floor(t*s)||n.height!==Math.floor(i*s)||s!==this.renderer.getPixelRatio()}updateRendererSize(e,t,i){this.renderer.setPixelRatio(i||1),this.renderer.setSize(e,t,!1),this.composer.setPixelRatio(this.renderer.getPixelRatio()),this.composer.setSize(e,t)}updateScene(e,t){const i=(t-this.lastFrame)/1e3;this.mixer&&this.mixer.update(i),this.controls.update(),this.lastFrame=t}getCanvasRelativePosition(e){const t=this.inputElement.getBoundingClientRect();return{x:e.clientX-t.left,y:e.clientY-t.top}}setPickPosition(e){const t=this.getCanvasRelativePosition(e);this.pickPosition.x=t.x/this.inputElement.clientWidth*2-1,this.pickPosition.y=t.y/this.inputElement.clientHeight*-2+1}clearPickPosition(){this.pickPosition.x=-1e5,this.pickPosition.y=-1e5}}class W{constructor(){this.raycaster=new A,this.pickedObject=null,this.pickedObjectSavedColor=0}pick(e,t,i,s){this.pickedObject&&(this.pickedObject.material.emissive.setHex(this.pickedObjectSavedColor),this.pickedObject=void 0),this.raycaster.setFromCamera(e,i);const n=this.raycaster.intersectObjects(t.children);n.length&&(this.pickedObject=n[0].object,this.pickedObjectSavedColor=this.pickedObject.material.emissive.getHex(),this.pickedObject.material.emissive.setHex(s*8%2>1?16776960:16711680))}}function J(o){return new q(o)}export{J as i};
