import{i as r}from"./shared-orbitcontrols-IoGp9UkV.js";import{z as h}from"./vendor-three-CbQP5_YZ.js";import"./gainmap-js-DfMKbIFV.js";function n(){}class a extends h{constructor(){super(),this.style={},this.rootProxy=this}get clientWidth(){return this.width}get clientHeight(){return this.height}getRootNode(){return this.rootProxy}setPointerCapture(){}releasePointerCapture(){}getBoundingClientRect(){return{left:this.left,top:this.top,width:this.width,height:this.height,right:this.left+this.width,bottom:this.top+this.height}}handleEvent(t){if(t.type==="size"){this.left=t.left,this.top=t.top,this.width=t.width,this.height=t.height;return}t.preventDefault=n,t.stopPropagation=n,this.dispatchEvent(t)}focus(){}}class c{constructor(){this.targets={},this.handleEvent=this.handleEvent.bind(this)}makeProxy(t){const{id:o}=t,s=new a;this.targets[o]=s}getProxy(t){return this.targets[t]}handleEvent(t){this.targets[t.id].handleEvent(t.data)}}const i=new c;function p(e){const t=i.getProxy(e.canvasId);t.ownerDocument=t,self.document={},r({canvas:e.canvas,inputElement:t,pixelRatio:e.pixelRatio})}function l(e){i.makeProxy(e)}const g={start:p,makeProxy:l,event:i.handleEvent};self.onmessage=function(e){const t=g[e.data.type];if(typeof t!="function")throw new Error("no handler for type: "+e.data.type);t(e.data)};
