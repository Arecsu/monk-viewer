import{a as I,l as q,Y as U,G as X,Z as Y,S as J,_ as Z,$,a0 as K,H as E,a1 as Q,a2 as V,u as ee,L as te,a3 as ne}from"./vendor-three-QULdiVbE.js";import{H as ae}from"./gainmap-js-BoBawWPE.js";import{E as ie,R as se,S as oe,a as ce,b as re,B as de,T as le,c as pe,H as me,d as x,e as fe,F as ue,f as h}from"./postprocessing-DZHiS1EQ.js";const he="/monk-viewer/assets/McLovin-1024x-DrI75Pld.glb",ge="/monk-viewer/assets/old_bus_depot_2k_HDR-CghB0eNo.jpg";function Me(L){const{canvas:P,inputElement:a,pixelRatio:R}=L,s=new I({antialias:!1,canvas:P});s.setPixelRatio(R||1),s.outputColorSpace=q,s.toneMapping=U,s.toneMappingExposure=1.5;const y=50,H=2,D=.1,k=100,o=new X(y,H,D,k);o.position.z=.8;const l=new Y(o,a);l.enableDamping=!0,l.dampingFactor=.055,l.target.set(0,0,0),l.update();const p=new J,A=16777215,O=1;new Z(A,O).position.set(-10,5,40);let f,g=Date.now(),w;new $().load(he,async function(t){const n=t.scene;n.scale.set(1,1,1),n.traverse(i=>{if(i.isMesh){const c=m=>{m&&(m.minFilter=ee,m.magFilter=te,m.anisotropy=s.capabilities.getMaxAnisotropy(),m.generateMipmaps=!0)};c(i.material.map),c(i.material.normalMap),c(i.material.roughnessMap),c(i.material.metalnessMap)}}),await s.compileAsync(n,o,p),f=new K(n),f.clipAction(t.animations[0]).play(),p.add(n),requestAnimationFrame(F)}),new ae(s).load(ge,function(t){const n=t.renderTarget.texture;n.type=E,n.needsUpdate=!0,p.environment=n,p.environment.mapping=Q,t.dispose()});const r=new ie(s,{frameBufferType:E});r.addPass(new se(p,o));const b=new oe({preset:ce.HIGH,edgeDetectionMode:re.COLOR});b.edgeDetectionMaterial.edgeDetectionThreshold=.001,b.edgeDetectionMaterial.localContrastAdaptationFactor=2;const C=new de({luminanceThreshold:.5,luminanceSmoothing:.1,mipmapBlur:1,intensity:.8,radius:.7}),S=new le({mode:pe.REINHARD,resolution:256,whitePoint:10,middleGrey:.8,minLuminance:.01,averageLuminance:.1,adaptationRate:1});new me({hue:0,saturation:0,blendFunction:x.NORMAL});const j=new fe({brightness:0,contrast:.1,blendFunction:x.NORMAL}),T=new ue;r.addPass(new h(o,T));const v=new h(o,C);v.dithering=!0,r.addPass(v),r.addPass(new h(o,S,j));const B=1,G=1,z=1;new V(B,G,z);class N{constructor(){this.raycaster=new ne,this.pickedObject=null,this.pickedObjectSavedColor=0}pick(t,n,d,i){this.pickedObject&&(this.pickedObject.material.emissive.setHex(this.pickedObjectSavedColor),this.pickedObject=void 0),this.raycaster.setFromCamera(t,d);const c=this.raycaster.intersectObjects(n.children);c.length&&(this.pickedObject=c[0].object,this.pickedObjectSavedColor=this.pickedObject.material.emissive.getHex(),this.pickedObject.material.emissive.setHex(i*8%2>1?16776960:16711680))}}new N;function W(e){const t=e.domElement,n=a.clientWidth,d=a.clientHeight,i=t.width!==n||t.height!==d;return i&&(e.setSize(n,d,!1),r.setSize(n,d)),i}function F(e){W(s)&&(o.aspect=a.clientWidth/a.clientHeight,o.updateProjectionMatrix()),w=(Date.now()-g)/1e3,f&&f.update(w),l.update(),r.render(),g=Date.now(),requestAnimationFrame(F)}function _(e){const t=a.getBoundingClientRect();return{x:e.clientX-t.left,y:e.clientY-t.top}}function u(e){const t=_(e);t.x/a.clientWidth*2-1,t.y/a.clientHeight*-2+1}function M(){}a.addEventListener("mousemove",u),a.addEventListener("mouseout",M),a.addEventListener("mouseleave",M),a.addEventListener("touchstart",e=>{e.preventDefault(),u(e.touches[0])},{passive:!1}),a.addEventListener("touchmove",e=>{u(e.touches[0])}),a.addEventListener("touchend",e=>{})}export{Me as i};
