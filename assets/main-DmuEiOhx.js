import{i as d}from"./shared-orbitcontrols-BaOcArx8.js";import"./vendor-three-QULdiVbE.js";import"./gainmap-js-BoBawWPE.js";import"./postprocessing-DZHiS1EQ.js";(function(){const o=document.createElement("link").relList;if(o&&o.supports&&o.supports("modulepreload"))return;for(const t of document.querySelectorAll('link[rel="modulepreload"]'))i(t);new MutationObserver(t=>{for(const n of t)if(n.type==="childList")for(const s of n.addedNodes)s.tagName==="LINK"&&s.rel==="modulepreload"&&i(s)}).observe(document,{childList:!0,subtree:!0});function r(t){const n={};return t.integrity&&(n.integrity=t.integrity),t.referrerPolicy&&(n.referrerPolicy=t.referrerPolicy),t.crossOrigin==="use-credentials"?n.credentials="include":t.crossOrigin==="anonymous"?n.credentials="omit":n.credentials="same-origin",n}function i(t){if(t.ep)return;t.ep=!0;const n=r(t);fetch(t.href,n)}})();const c=a(["ctrlKey","metaKey","shiftKey","button","pointerType","clientX","clientY","pointerId","pageX","pageY"]),f=a(["deltaX","deltaY"]),p=a(["ctrlKey","metaKey","shiftKey","keyCode"]);function h(e,o){e.preventDefault(),f(e,o)}function m(e){e.preventDefault()}function y(e,o,r){for(const i of o)r[i]=e[i]}function a(e){return function(r,i){const t={type:r.type};y(r,e,t),i(t)}}function l(e,o){e.preventDefault();const r=[],i={type:e.type,touches:r};for(let t=0;t<e.touches.length;++t){const n=e.touches[t];r.push({pageX:n.pageX,pageY:n.pageY,clientX:n.clientX,clientY:n.clientY})}o(i)}const g={37:!0,38:!0,39:!0,40:!0};function v(e,o){const{keyCode:r}=e;g[r]&&(e.preventDefault(),p(e,o))}let w=0;class O{constructor(o,r,i){this.id=w++,this.worker=r,this.element=o;const t=n=>{this.worker.postMessage({type:"event",id:this.id,data:n})};r.postMessage({type:"makeProxy",id:this.id}),this.resizeObserver=new ResizeObserver(n=>{requestAnimationFrame(()=>{const s=this.element.getBoundingClientRect();t({type:"size",left:s.left,top:s.top,width:this.element.clientWidth,height:this.element.clientHeight})})}),this.sendSize(t),this.resizeObserver.observe(o);for(const[n,s]of Object.entries(i))o.addEventListener(n,function(u){s(u,t)})}sendSize(o){const r=this.element.getBoundingClientRect();o({type:"size",left:r.left,top:r.top,width:this.element.clientWidth,height:this.element.clientHeight})}disconnect(){this.resizeObserver&&this.resizeObserver.disconnect()}}function b(e){const o=e.transferControlToOffscreen(),r=new Worker(new URL("/monk-viewer/assets/offscreencanvas-worker-orbitcontrol-BQN2AFJS.js",import.meta.url),{type:"module"}),i=window.devicePixelRatio||1,t={contextmenu:m,mousedown:c,mousemove:c,mouseup:c,pointerdown:c,pointermove:c,pointerup:c,touchstart:l,touchmove:l,touchend:l,wheel:h,keydown:v},n=new O(e,r,t);r.postMessage({type:"start",canvas:o,canvasId:n.id,pixelRatio:i},[o]),console.log("using OffscreenCanvas")}function P(e){d({canvas:e,inputElement:e}),console.log("using regular canvas")}function E(){const e=document.querySelector("#c");e.transferControlToOffscreen?b(e):P(e)}E();
