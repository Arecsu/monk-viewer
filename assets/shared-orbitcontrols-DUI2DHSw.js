import{a as g,m as R,n as x,o as v,S as f,p as k,q as w,W as E,b as F,H as h,E as M,r as b,s as S,t as L,u as y,G as T,A as z,v as p,L as m,w as H,x as O}from"./vendor-three-B2nca_jY.js";import{H as C}from"./gainmap-js-DC9a5eKy.js";var j="/monk-viewer/assets/McLovin-1024x-DrI75Pld.glb",A="/monk-viewer/assets/old_bus_depot_2k_HDR-CghB0eNo.jpg";class D{constructor(e){this.canvas=e.canvas,this.inputElement=e.inputElement,this.initialPixelRatio=e.pixelRatio||window.devicePixelRatio,this.customPixelRatio=null,this.scene=null,this.camera=null,this.renderer=null,this.composer=null,this.controls=null,this.mixer=null,this.pickHelper=null,this.lastResizeTime=null,this.throttleResize=150,this.lastFrame=Date.now(),this.initScene()}initScene(){this.setupRenderer(),this.setupCamera(),this.setupControls(),this.setupScene(),this.setupPostProcessing(),this.setupInteraction(),this.loadAssets()}setupRenderer(){this.renderer=new g({powerPreference:"high-performance",antialias:!0,canvas:this.canvas}),this.renderer.setPixelRatio(this.initialPixelRatio),this.renderer.toneMapping=R,this.renderer.toneMappingExposure=1.5}setupCamera(){this.camera=new x(50,2,.1,100),this.camera.position.z=.8}setupControls(){this.controls=new v(this.camera,this.inputElement),this.controls.enableDamping=!0,this.controls.dampingFactor=.055,this.controls.target.set(0,0,0),this.controls.update()}setupScene(){this.scene=new f,this.scene.background=new k(0)}setupLighting(){const e=new w(16777215,10);e.position.set(0,0,5),this.scene.add(e)}setupPostProcessing(){const e=new E(this.inputElement.clientWidth,this.inputElement.clientHeight,{samples:8,anisotropy:this.renderer.capabilities.getMaxAnisotropy(),colorSpace:F,type:h});this.composer=new M(this.renderer,e);const t=new b(this.scene,this.camera);this.composer.addPass(t);const i=new S(new L(this.inputElement.clientWidth,this.inputElement.clientHeight),.12,.9,.1);this.composer.addPass(i);const s=new y;this.composer.addPass(s)}setupInteraction(){this.pickPosition={x:-2,y:-2},this.pickHelper=new q,this.clearPickPosition(),this.inputElement.addEventListener("mousemove",this.setPickPosition.bind(this)),this.inputElement.addEventListener("mouseout",this.clearPickPosition.bind(this)),this.inputElement.addEventListener("mouseleave",this.clearPickPosition.bind(this)),this.inputElement.addEventListener("contextmenu",()=>{console.log("hi")}),this.setupTouchEvents()}setupTouchEvents(){this.inputElement.addEventListener("touchstart",e=>{e.preventDefault(),this.setPickPosition(e.touches[0])},{passive:!1}),this.inputElement.addEventListener("touchmove",e=>{this.setPickPosition(e.touches[0])}),this.inputElement.addEventListener("touchend",()=>{this.clearPickPosition()})}loadAssets(){this.loadArtworkModel(),this.loadHDREnvironment()}loadArtworkModel(){new T().load(j,async t=>{const i=t.scene;i.scale.set(1,1,1),this.optimizeModelTextures(i),await this.renderer.compileAsync(i,this.camera,this.scene),this.mixer=new z(i),this.mixer.clipAction(t.animations[0]),this.scene.add(i),this.startPerformanceSamplingLoop()})}optimizeModelTextures(e){e.traverse(t=>{t.isMesh&&(this.applyTextureOptimization(t.material.map),this.applyTextureOptimization(t.material.normalMap),this.applyTextureOptimization(t.material.roughnessMap),this.applyTextureOptimization(t.material.metalnessMap))})}applyTextureOptimization(e){e&&(e.minFilter=p,e.magFilter=m,e.anisotropy=this.renderer.capabilities.getMaxAnisotropy(),e.generateMipmaps=!0)}loadHDREnvironment(){new C(this.renderer).load(A,t=>{const i=t.renderTarget.texture;console.log(t),this.configureHDRTexture(i),this.scene.environment=i,this.scene.environment.mapping=H,t.dispose()})}configureHDRTexture(e){e.type=h,e.minFilter=p,e.magFilter=m,e.generateMipmaps=!0,e.needsUpdate=!0}startPerformanceSamplingLoop(){let e=0,t=0;const i=[],s=3,n=a=>{a*=.001;const c=Date.now();if(this.handleResize(c),this.updateScene(a,c),this.composer.render(),t++,a>=e+.1){const d=t/(a-e);if(i.push(d),e=a,t=0,i.length>=s){const r=Math.max(...i),u=75;if(console.log(r),r>50){this.startRenderLoop();return}const P=r/u,l=Math.sqrt(this.initialPixelRatio**1*P);this.customPixelRatio=Math.max(.8,Math.min(l,this.initialPixelRatio)),console.log(l),this.startRenderLoop();return}}requestAnimationFrame(n)};requestAnimationFrame(n)}startRenderLoop(){const e=t=>{t*=.001;const i=Date.now();this.handleResize(i),this.updateScene(t,i),this.composer.render(),requestAnimationFrame(e)};requestAnimationFrame(e)}handleResize(e){const{clientWidth:t,clientHeight:i,pixelRatio:s}=this.inputElement,n=this.customPixelRatio||s||this.initialPixelRatio||window.devicePixelRatio;this.needsResize(e,t,i,n)&&(this.updateRendererSize(t,i,n),this.lastResizeTime=e,this.camera.aspect=t/i,this.camera.updateProjectionMatrix())}needsResize(e,t,i,s){if(e-this.lastResizeTime<this.throttleResize)return!1;const n=this.renderer.domElement;return n.width!==Math.floor(t*s)||n.height!==Math.floor(i*s)||s!==this.renderer.getPixelRatio()}updateRendererSize(e,t,i){this.renderer.setPixelRatio(i||1),this.renderer.setSize(e,t,!1),this.composer.setPixelRatio(this.renderer.getPixelRatio()),this.composer.setSize(e,t)}updateScene(e,t){const i=(t-this.lastFrame)/1e3;this.mixer&&this.mixer.update(i),this.controls.update(),this.lastFrame=t}getCanvasRelativePosition(e){const t=this.inputElement.getBoundingClientRect();return{x:e.clientX-t.left,y:e.clientY-t.top}}setPickPosition(e){const t=this.getCanvasRelativePosition(e);this.pickPosition.x=t.x/this.inputElement.clientWidth*2-1,this.pickPosition.y=t.y/this.inputElement.clientHeight*-2+1}clearPickPosition(){this.pickPosition.x=-1e5,this.pickPosition.y=-1e5}}class q{constructor(){this.raycaster=new O,this.pickedObject=null,this.pickedObjectSavedColor=0}pick(e,t,i,s){this.pickedObject&&(this.pickedObject.material.emissive.setHex(this.pickedObjectSavedColor),this.pickedObject=void 0),this.raycaster.setFromCamera(e,i);const n=this.raycaster.intersectObjects(t.children);n.length&&(this.pickedObject=n[0].object,this.pickedObjectSavedColor=this.pickedObject.material.emissive.getHex(),this.pickedObject.material.emissive.setHex(s*8%2>1?16776960:16711680))}}function B(o){return new D(o)}export{B as i};
