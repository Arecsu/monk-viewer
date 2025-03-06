var g=Object.defineProperty;var v=(s,i,t)=>i in s?g(s,i,{enumerable:!0,configurable:!0,writable:!0,value:t}):s[i]=t;var l=(s,i,t)=>v(s,typeof i!="symbol"?i+"":i,t);import{i as y}from"./renderer-CGY_ZVOK.js";import"./vendor-three-BBAo10n7.js";import"./gainmap-js-tLnfN5Uc.js";import"./postprocessing-CJEqnmHP.js";(function(){const i=document.createElement("link").relList;if(i&&i.supports&&i.supports("modulepreload"))return;for(const n of document.querySelectorAll('link[rel="modulepreload"]'))e(n);new MutationObserver(n=>{for(const o of n)if(o.type==="childList")for(const c of o.addedNodes)c.tagName==="LINK"&&c.rel==="modulepreload"&&e(c)}).observe(document,{childList:!0,subtree:!0});function t(n){const o={};return n.integrity&&(o.integrity=n.integrity),n.referrerPolicy&&(o.referrerPolicy=n.referrerPolicy),n.crossOrigin==="use-credentials"?o.credentials="include":n.crossOrigin==="anonymous"?o.credentials="omit":o.credentials="same-origin",o}function e(n){if(n.ep)return;n.ep=!0;const o=t(n);fetch(n.href,o)}})();const A=/android/i.test(navigator.userAgent),b=/iPad|iPhone|iPod/.test(navigator.userAgent)&&!window.MSStream||/Mac/.test(navigator.userAgent)&&navigator.maxTouchPoints>1,w=!!(window.webkit&&window.webkit.messageHandlers),O=(()=>{if(b){if(w)return!!/CriOS\/|EdgiOS\/|FxiOS\/|GSA\/|DuckDuckGo\//.test(navigator.userAgent);{const s=document.createElement("a");return!!(s.relList&&s.relList.supports&&s.relList.supports("ar"))}}return!1})(),k=A&&!/firefox|OculusBrowser/i.test(navigator.userAgent);let d="none";O?d="quick-look":k&&(d="scene-viewer");function f(s){return Math.min(window.devicePixelRatio||1,s)}const u=class u{constructor(i,t,e,n){l(this,"id",u.nextId++);l(this,"worker");l(this,"element");l(this,"resizeObserver");l(this,"limitPixelRatio");this.worker=t,this.element=i,this.limitPixelRatio=n;const o=r=>{this.worker.postMessage({type:"event",id:this.id,data:r})};this.worker.postMessage({type:"makeProxy",id:this.id});const c=()=>{const r=this.element.getBoundingClientRect();o({type:"size",left:r.left,top:r.top,width:this.element.clientWidth,height:this.element.clientHeight,pixelRatio:f(this.limitPixelRatio)})};this.resizeObserver=new ResizeObserver(()=>{requestAnimationFrame(c)}),c(),this.resizeObserver.observe(i),this.attachHandlers(e,o)}attachHandlers(i,t){Object.entries(i).forEach(([e,n])=>{this.element.addEventListener(e,o=>{const c=n(o);t(c)})})}disconnect(){this.resizeObserver.disconnect()}};l(u,"nextId",0);let p=u;function a(s){return i=>s(i)}function R(s){return i=>{const t={type:i.type};return s.forEach(e=>{e in i&&(t[e]=i[e])}),t}}const I=s=>{const i=R(["ctrlKey","metaKey","shiftKey","button","pointerType","clientX","clientY","pointerId","pageX","pageY"]),t=e=>({type:e.type,touches:Array.from(e.touches).map(n=>({pageX:n.pageX,pageY:n.pageY,clientX:n.clientX,clientY:n.clientY}))});return{contextmenu:a(e=>(e.preventDefault(),{type:e.type})),click:a(i),mousedown:a(i),mousemove:a(i),mouseup:a(i),mouseleave:a(i),pointerdown:a(i),pointermove:a(i),pointerup:a(i),pointerout:a(i),wheel:a(e=>(s.isInteractive&&e.preventDefault(),{type:e.type,deltaX:e.deltaX,deltaY:e.deltaY})),touchstart:a(t),touchend:a(t),touchmove:a(e=>(s.isInteractive&&e.preventDefault(),t(e))),keydown:a(e=>({type:e.type,key:e.key,ctrlKey:e.ctrlKey,metaKey:e.metaKey,shiftKey:e.shiftKey}))}};function L(){const s=/Macintosh(?!.*KHTML).*Gecko/i.test(navigator.userAgent),i=/Android(?!.*KHTML).*Gecko/i.test(navigator.userAgent),t=/Android/i.test(navigator.userAgent);return s||i?{disableAA:!0,lowResolution:!0}:t?{disableAA:!0,lowResolution:!1}:{disableAA:!1,lowResolution:!1}}class E extends HTMLElement{constructor(){super();l(this,"canvas");l(this,"commonOptions");l(this,"isInteractive",!1);l(this,"limitPixelRatio",/Android/i.test(navigator.userAgent)?2:1/0);this.canvas=document.createElement("canvas");const t=this.isValidURL(this.getAttribute("model")||""),e=this.isValidURL(this.getAttribute("envmap")||""),n=parseFloat(this.getAttribute("target-distance")||"0.8"),o=parseFloat(this.getAttribute("min-distance")||"0.1"),c=parseFloat(this.getAttribute("max-distance")||"1.0"),r=parseFloat(this.getAttribute("init-delay")||"0.0"),m=parseFloat(this.getAttribute("init-delay-interactive")||"0.0"),h={stabilityDuration:parseFloat(this.getAttribute("perf-stability-duration")||"1.0"),measureDuration:parseFloat(this.getAttribute("perf-measure-duration")||"0.5")};this.commonOptions={pixelRatio:f(this.limitPixelRatio),modelUrl:t,envmapUrl:e,minDistance:o,targetDistance:n,maxDistance:c,initDelay:r,initDelayInteractive:m,lowPerformanceSettings:L(),perfSampling:h}}addARLink(){if(d==="none")return;const t=d==="quick-look"?"model-usdz":"model-glb",e=this.isValidURL(this.getAttribute(t)||"");if(!e)return;const n=this.getAttribute("model-title")||document.title||"model",c=this.getAttribute("ar-vertical")==="true"?"true":"false",r=document.createElement("a");if(r.textContent="AR",r.classList.add("ar-link"),d==="quick-look")r.setAttribute("rel","ar"),r.setAttribute("href",e);else if(d==="scene-viewer"){const m=window.location.href,h=`intent://arvr.google.com/scene-viewer/1.2?file=${encodeURIComponent(e)}&mode=ar_only&enable_vertical_placement=${c}&title=${encodeURIComponent(n)}#Intent;scheme=https;package=com.google.android.googlequicksearchbox;action=android.intent.action.VIEW;S.browser_fallback_url=${encodeURIComponent(m)};end;`;r.setAttribute("href",h)}this.appendChild(r)}connectedCallback(){this.appendChild(this.canvas),this.logAttributes(),this.initScene(),this.addARLink()}logAttributes(){console.log("Model URL:",this.commonOptions.modelUrl),console.log("Max distance:",this.commonOptions.maxDistance),console.log("Target distance:",this.commonOptions.targetDistance),console.log("Min distance:",this.commonOptions.minDistance),console.log("Envmap URL:",this.commonOptions.envmapUrl)}isValidURL(t){if(!t)return null;try{return new URL(t,document.baseURI).href}catch{return null}}handleInteractivityChange(t){this.isInteractive=t,t?(this.setAttribute("interactive","true"),this.style.cursor="move"):(this.setAttribute("interactive","false"),this.style.cursor="pointer"),this.dispatchEvent(new CustomEvent("interactivity",{detail:{state:t}}))}handleOnLoaded(t){this.setAttribute("loaded","true"),this.dispatchEvent(new CustomEvent("loaded",{detail:{state:t}}))}startWorker(t){const e=t.transferControlToOffscreen(),n=new Worker(new URL("/monk-viewer/assets/offscreencanvas-worker-DFsjsEfD.js",import.meta.url),{type:"module"}),o=I(this),c=new p(t,n,o,this.limitPixelRatio);n.postMessage({type:"start",canvas:e,canvasId:c.id,...this.commonOptions},[e]),n.onmessage=r=>{switch(r.data.type){case"interactivity":this.handleInteractivityChange(r.data.state);break;case"loaded":this.handleOnLoaded(r.data.state);break}}}initScene(){if(this.canvas){if(!(this.commonOptions.modelUrl&&this.commonOptions.envmapUrl)){console.warn("No valid model or envmap found. Scene won't be initialized.");return}this.canvas.transferControlToOffscreen!==void 0?this.startWorker(this.canvas):y({canvas:this.canvas,inputElement:this.canvas,...this.commonOptions,e_interactivityChange:t=>this.handleInteractivityChange(t),e_loaded:t=>this.handleOnLoaded(t)})}}}customElements.define("monk-view",E);
