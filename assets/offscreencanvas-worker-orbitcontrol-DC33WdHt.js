import{i as s}from"./shared-orbitcontrols-Db0Hb6vF.js";import{Q as h}from"./vendor-three-boZRr3xs.js";import"./gainmap-js-Ck5yehxf.js";import"./postprocessing-DQpmCyup.js";function n(){}class c extends h{constructor(){super(),this.style={},this.rootProxy=this}get clientWidth(){return this.width}get clientHeight(){return this.height}getRootNode(){return this.rootProxy}setPointerCapture(){}releasePointerCapture(){}getBoundingClientRect(){return{left:this.left,top:this.top,width:this.width,height:this.height,right:this.left+this.width,bottom:this.top+this.height}}handleEvent(t){if(t.type==="size"){this.left=t.left,this.top=t.top,this.width=t.width,this.height=t.height,this.pixelRatio=t.pixelRatio;return}t.preventDefault=n,t.stopPropagation=n,this.dispatchEvent(t)}focus(){}}class l{constructor(){this.targets={},this.handleEvent=this.handleEvent.bind(this)}makeProxy(t){const{id:o}=t,r=new c;this.targets[o]=r}getProxy(t){return this.targets[t]}handleEvent(t){this.targets[t.id].handleEvent(t.data)}}const i=new l;function p(e){const t=i.getProxy(e.canvasId);t.ownerDocument=t,self.document={},s({canvas:e.canvas,inputElement:t,pixelRatio:e.pixelRatio,lowPerformanceSettings:e.lowPerformanceSettings})}function a(e){i.makeProxy(e)}const g={start:p,makeProxy:a,event:i.handleEvent};self.onmessage=function(e){const t=g[e.data.type];if(typeof t!="function")throw new Error("no handler for type: "+e.data.type);t(e.data)};
