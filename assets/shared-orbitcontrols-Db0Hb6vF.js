import{a as R,q as g,r as x,s as f,S as w,t as v,u as S,W as k,b as E,H as c,E as b,v as M,w as F,m as L,x as y,y as z,G as A,A as T,z as p,L as m,J as H,K as O}from"./vendor-three-boZRr3xs.js";import{H as C}from"./gainmap-js-Ck5yehxf.js";import{D}from"./postprocessing-DQpmCyup.js";var j="/monk-viewer/assets/McLovin-1024x-DrI75Pld.glb",W="/monk-viewer/assets/old_bus_depot_2k_HDR-CghB0eNo.jpg";const q=o=>o.reduce((e,t)=>e+t,0)/o.length;class G{constructor(e){var t,i;this.canvas=e.canvas,this.inputElement=e.inputElement,this.lowPerformanceSettings={disableMSAA:((t=e.lowPerformanceSettings)==null?void 0:t.disableMSAA)??!1,lowResolution:((i=e.lowPerformanceSettings)==null?void 0:i.lowResolution)??!1},this.baseLoadPixelRatio=e.pixelRatio??window.devicePixelRatio,this.initialRenderPixelRatio=this.lowPerformanceSettings.lowResolution?e.pixelRatio/2:this.baseLoadPixelRatio,this.performantRenderPixelRatio=null,this.msaaSamples=this.lowPerformanceSettings.disableMSAA?0:4,this.pixelRatioVariation=1,this.scene=null,this.camera=null,this.renderer=null,this.composer=null,this.controls=null,this.mixer=null,this.pickHelper=null,this.lastResizeTime=null,this.throttleResize=150,this.lastFrame=Date.now(),this.initScene()}initScene(){this.setupRenderer(),this.setupCamera(),this.setupControls(),this.setupScene(),this.setupPostProcessing(),this.setupInteraction(),this.loadAssets()}setupRenderer(){this.renderer=new R({powerPreference:"high-performance",antialias:!0,canvas:this.canvas}),this.renderer.setPixelRatio(this.initialRenderPixelRatio),this.renderer.toneMapping=g,this.renderer.toneMappingExposure=1.5}setupCamera(){this.camera=new x(50,2,.1,100),this.camera.position.z=.8}setupControls(){this.controls=new f(this.camera,this.inputElement),this.controls.enableDamping=!0,this.controls.dampingFactor=.055,this.controls.target.set(0,0,0),this.controls.update()}setupScene(){this.scene=new w,this.scene.background=new v(0)}setupLighting(){const e=new S(16777215,10);e.position.set(0,0,5),this.scene.add(e)}setupPostProcessing(){const e=new k(this.inputElement.clientWidth,this.inputElement.clientHeight,{samples:this.msaaSamples,anisotropy:this.renderer.capabilities.getMaxAnisotropy(),colorSpace:E,type:c});this.composer=new b(this.renderer,e);const t=new M(this.scene,this.camera);this.composer.addPass(t);const i=new F(new L(this.inputElement.clientWidth,this.inputElement.clientHeight),.12,.9,.1);this.composer.addPass(i);const s=this.getWorkingPixelRatio(),n=new y(this.inputElement.clientWidth*s,this.inputElement.clientHeight*s);this.composer.addPass(n);const a=new z;this.composer.addPass(a);const l=new D({ditherIntensity:1,ditherPattern:0});this.composer.addPass(l)}resetPostProcessing(){this.composer.dispose(),this.composer=null,this.setupPostProcessing(),this.handleResize(!0)}setupInteraction(){this.pickPosition={x:-2,y:-2},this.pickHelper=new I,this.clearPickPosition(),this.inputElement.addEventListener("mousemove",this.setPickPosition.bind(this)),this.inputElement.addEventListener("mouseout",this.clearPickPosition.bind(this)),this.inputElement.addEventListener("mouseleave",this.clearPickPosition.bind(this)),this.inputElement.addEventListener("contextmenu",()=>{console.log("hi")}),this.setupTouchEvents()}setupTouchEvents(){this.inputElement.addEventListener("touchstart",e=>{e.preventDefault(),this.setPickPosition(e.touches[0])},{passive:!1}),this.inputElement.addEventListener("touchmove",e=>{this.setPickPosition(e.touches[0])}),this.inputElement.addEventListener("touchend",()=>{this.clearPickPosition()})}loadAssets(){this.loadArtworkModel(),this.loadHDREnvironment()}loadArtworkModel(){new A().load(j,async t=>{const i=t.scene;i.scale.set(1,1,1),this.optimizeModelTextures(i),await this.renderer.compileAsync(i,this.camera,this.scene),this.mixer=new T(i),this.mixer.clipAction(t.animations[0]),this.scene.add(i),this.startPerformanceSamplingLoop()})}optimizeModelTextures(e){e.traverse(t=>{t.isMesh&&(this.applyTextureOptimization(t.material.map),this.applyTextureOptimization(t.material.normalMap),this.applyTextureOptimization(t.material.roughnessMap),this.applyTextureOptimization(t.material.metalnessMap))})}applyTextureOptimization(e){e&&(e.minFilter=p,e.magFilter=m,e.anisotropy=this.renderer.capabilities.getMaxAnisotropy(),e.generateMipmaps=!0)}loadHDREnvironment(){new C(this.renderer).load(W,t=>{const i=t.renderTarget.texture;this.configureHDRTexture(i),this.scene.environment=i,this.scene.environment.mapping=H,t.dispose()})}configureHDRTexture(e){e.type=c,e.minFilter=p,e.magFilter=m,e.generateMipmaps=!0,e.needsUpdate=!0}startPerformanceSamplingLoop(){let e=0,t=0;const i=[],s=5,n=a=>{a*=.001;const l=Date.now();if(this.handleResize(),this.updateScene(a,l),this.composer.render(),t++,a>=e+.1){const d=t/(a-e);if(i.push(d),e=a,t=0,i.length>=s){const r=q(i.slice(3)),u=75;if(console.log("maxfps: ",r),console.log("fpssamples: ",i),r<50&&this.msaaSamples>0&&(this.msaaSamples=0,this.resetPostProcessing()),r<30){const P=r/u,h=Math.sqrt(this.initialRenderPixelRatio**2.6*P);this.performantRenderPixelRatio=Math.max(.8,Math.min(h,this.initialRenderPixelRatio)),console.log(h)}this.startRenderLoop();return}}requestAnimationFrame(n)};requestAnimationFrame(n)}startRenderLoop(){let e=0,t=0;const i=s=>{s*=.001;const n=Date.now();if(t++,s>=e+1){const a=t/(s-e);console.log(a),e=s,t=0}this.handleResize(),this.updateScene(s,n),this.composer.render(),requestAnimationFrame(i)};requestAnimationFrame(i)}getWorkingPixelRatio(){return this.performantRenderPixelRatio?this.performantRenderPixelRatio*this.pixelRatioVariation:this.initialRenderPixelRatio?this.initialRenderPixelRatio*this.pixelRatioVariation:window.devicePixelRatio}handleResize(e=!1){const{clientWidth:t,clientHeight:i,pixelRatio:s}=this.inputElement;this.pixelRatioVariation=s/this.baseLoadPixelRatio;const n=this.getWorkingPixelRatio(),a=Date.now();(e||this.needsResize(a,t,i,n))&&(this.updateRendererSize(t,i,n),this.lastResizeTime=a,this.camera.aspect=t/i,this.camera.updateProjectionMatrix())}needsResize(e,t,i,s){if(e-this.lastResizeTime<this.throttleResize)return!1;const n=this.renderer.domElement;return n.width!==Math.floor(t*s)||n.height!==Math.floor(i*s)||s!==this.renderer.getPixelRatio()}updateRendererSize(e,t,i){this.renderer.setPixelRatio(i||1),this.renderer.setSize(e,t,!1),this.composer.setPixelRatio(this.renderer.getPixelRatio()),this.composer.setSize(e,t)}updateScene(e,t){const i=(t-this.lastFrame)/1e3;this.mixer&&this.mixer.update(i),this.controls.update(),this.lastFrame=t}getCanvasRelativePosition(e){const t=this.inputElement.getBoundingClientRect();return{x:e.clientX-t.left,y:e.clientY-t.top}}setPickPosition(e){const t=this.getCanvasRelativePosition(e);this.pickPosition.x=t.x/this.inputElement.clientWidth*2-1,this.pickPosition.y=t.y/this.inputElement.clientHeight*-2+1}clearPickPosition(){this.pickPosition.x=-1e5,this.pickPosition.y=-1e5}}class I{constructor(){this.raycaster=new O,this.pickedObject=null,this.pickedObjectSavedColor=0}pick(e,t,i,s){this.pickedObject&&(this.pickedObject.material.emissive.setHex(this.pickedObjectSavedColor),this.pickedObject=void 0),this.raycaster.setFromCamera(e,i);const n=this.raycaster.intersectObjects(t.children);n.length&&(this.pickedObject=n[0].object,this.pickedObjectSavedColor=this.pickedObject.material.emissive.getHex(),this.pickedObject.material.emissive.setHex(s*8%2>1?16776960:16711680))}}function U(o){return new G(o)}export{U as i};
