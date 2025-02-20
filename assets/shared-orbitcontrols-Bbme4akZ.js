var k=Object.defineProperty;var j=(i,t,e)=>t in i?k(i,t,{enumerable:!0,configurable:!0,writable:!0,value:e}):i[t]=e;var b=(i,t,e)=>j(i,typeof t!="symbol"?t+"":t,e);import{a6 as C,V as m,a7 as g,a8 as f,a9 as T,aa as E,n as d,ab as v,ac as z,ad as F,a as N,$ as I,S as U,p as Y,ae as H,H as M,af as Z,ag as K,ah as w,L as x,ai as q,aj as X}from"./vendor-three-N7lV2Ffk.js";import{H as W}from"./gainmap-js-DCWFOtnI.js";import{R as V,C as B,G,E as Q,B as $,T as J,a as tt}from"./postprocessing-DUWFfstC.js";/* @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const et=.001,it=50;class S{constructor(t=it){b(this,"velocity",0);b(this,"naturalFrequency",0);this.setDecayTime(t)}setDecayTime(t){this.naturalFrequency=1/Math.max(et,t)}update(t,e,s,o){const a=2e-4*this.naturalFrequency;if(t==null||o===0||t===e&&this.velocity===0)return e;if(s<0)return t;const r=t-e,l=this.velocity+this.naturalFrequency*r,c=r+s*l,_=Math.exp(-this.naturalFrequency*s),u=(l-this.naturalFrequency*c)*_,P=-this.naturalFrequency*(u+l*_);return Math.abs(u)<a*Math.abs(o)&&P*r>=0?(this.velocity=0,e):(this.velocity=u,e+c*_)}}const A={type:"change"},D={type:"start"},L={type:"end"},y=new v,O=new z,st=Math.cos(70*F.DEG2RAD),ot=.04,h=new m,p=2*Math.PI,n={NONE:-1,ROTATE:0,DOLLY:1,PAN:2,TOUCH_ROTATE:3,TOUCH_PAN:4,TOUCH_DOLLY_PAN:5,TOUCH_DOLLY_ROTATE:6},R=1e-6;class at extends C{constructor(t,e=null){super(t,e),this.state=n.NONE,this.enabled=!0,this.target=new m,this.cursor=new m,this.minDistance=0,this.maxDistance=1/0,this.minZoom=0,this.maxZoom=1/0,this.minTargetRadius=0,this.maxTargetRadius=1/0,this.minPolarAngle=0,this.maxPolarAngle=Math.PI,this.minAzimuthAngle=-1/0,this.maxAzimuthAngle=1/0,this.enableDamping=!1,this.dampingFactor=.1,this.zoomDampingFactor=.1,this.enableZoom=!0,this.zoomSpeed=.1,this.zoomSensitivity=1,this.enableRotate=!0,this.rotateSpeed=1,this.keyRotateSpeed=1,this.enablePan=!0,this.panSpeed=1,this.screenSpacePanning=!0,this.keyPanSpeed=7,this.zoomToCursor=!1,this.autoRotate=!1,this.autoRotateSpeed=2,this.keys={LEFT:"ArrowLeft",UP:"ArrowUp",RIGHT:"ArrowRight",BOTTOM:"ArrowDown"},this.mouseButtons={LEFT:g.ROTATE,MIDDLE:g.DOLLY,RIGHT:g.PAN},this.touches={ONE:f.ROTATE,TWO:f.DOLLY_PAN},this.target0=this.target.clone(),this.position0=this.object.position.clone(),this.zoom0=this.object.zoom,this._domElementKeyEvents=null,this._lastPosition=new m,this._lastQuaternion=new T,this._lastTargetPosition=new m,this._quat=new T().setFromUnitVectors(t.up,new m(0,1,0)),this._quatInverse=this._quat.clone().invert(),this._spherical=new E,this._goalSpherical=new E,this._sphericalDelta=new E,this.radiusDamper=new S(70),this.thetaDamper=new S(70),this.phiDamper=new S(70),this._scale=1,this._panOffset=new m,this._rotateStart=new d,this._rotateEnd=new d,this._rotateDelta=new d,this._panStart=new d,this._panEnd=new d,this._panDelta=new d,this._dollyStart=new d,this._dollyEnd=new d,this._dollyDelta=new d,this._dollyDirection=new m,this._mouse=new d,this._performCursorZoom=!1,this._pointers=[],this._pointerPositions={},this._controlActive=!1,this._onPointerMove=ht.bind(this),this._onPointerDown=nt.bind(this),this._onPointerUp=rt.bind(this),this._onContextMenu=_t.bind(this),this._onMouseWheel=pt.bind(this),this._onKeyDown=dt.bind(this),this._onTouchStart=mt.bind(this),this._onTouchMove=ut.bind(this),this._onMouseDown=lt.bind(this),this._onMouseMove=ct.bind(this),this._interceptControlDown=ft.bind(this),this._interceptControlUp=gt.bind(this),this.damperNormalization={sphericalRadius:this.maximumRadius,sphericalTheta:Math.PI,sphericalPhi:this.maxPolarAngle,fov:1},h.copy(this.object.position).sub(this.target),h.applyQuaternion(this._quat),this._spherical.setFromVector3(h),this._goalSpherical.copy(this._spherical),this.domElement!==null&&this.connect()}connect(){this.domElement.addEventListener("pointerdown",this._onPointerDown),this.domElement.addEventListener("pointercancel",this._onPointerUp),this.domElement.addEventListener("pointerout",this._onPointerUp),this.domElement.addEventListener("contextmenu",this._onContextMenu),this.domElement.addEventListener("wheel",this._onMouseWheel,{passive:!1}),this.domElement.getRootNode().addEventListener("keydown",this._interceptControlDown,{passive:!0,capture:!0}),this.domElement.style.touchAction="none"}disconnect(){this.domElement.removeEventListener("pointerdown",this._onPointerDown),this.domElement.removeEventListener("pointermove",this._onPointerMove),this.domElement.removeEventListener("pointerup",this._onPointerUp),this.domElement.removeEventListener("pointercancel",this._onPointerUp),this.domElement.removeEventListener("pointerout",this._onPointerUp),this.domElement.removeEventListener("wheel",this._onMouseWheel),this.domElement.removeEventListener("contextmenu",this._onContextMenu),this.stopListenToKeyEvents(),this.domElement.getRootNode().removeEventListener("keydown",this._interceptControlDown,{capture:!0}),this.domElement.style.touchAction="auto"}dispose(){this.disconnect()}getPolarAngle(){return this._spherical.phi}getAzimuthalAngle(){return this._spherical.theta}getDistance(){return this.object.position.distanceTo(this.target)}listenToKeyEvents(t){t.addEventListener("keydown",this._onKeyDown),this._domElementKeyEvents=t}stopListenToKeyEvents(){this._domElementKeyEvents!==null&&(this._domElementKeyEvents.removeEventListener("keydown",this._onKeyDown),this._domElementKeyEvents=null)}saveState(){this.target0.copy(this.target),this.position0.copy(this.object.position),this.zoom0=this.object.zoom}reset(){this.target.copy(this.target0),this.object.position.copy(this.position0),this.object.zoom=this.zoom0,this.object.updateProjectionMatrix(),this.dispatchEvent(A),this.state=n.NONE}update(t=0){console.log(this._spherical.theta,this._goalSpherical.theta);const e=t*1e3,s=this.object.position;this.autoRotate&&this.state===n.NONE&&this._rotateLeft(this._getAutoRotationAngle(t)),this.enableDamping?(this._spherical.theta=this.thetaDamper.update(this._spherical.theta,this._goalSpherical.theta,e,this.damperNormalization.sphericalTheta),this._spherical.phi=this.phiDamper.update(this._spherical.phi,this._goalSpherical.phi,e,this.damperNormalization.sphericalPhi),(this.object.isPerspectiveCamera||this.object.isOrthographicCamera)&&(this._spherical.radius=this.radiusDamper.update(this._spherical.radius,this._goalSpherical.radius,e,this.damperNormalization.sphericalRadius))):(this._spherical.radius=this._goalSpherical.radius,this._spherical.theta=this._goalSpherical.theta,this._spherical.phi=this._goalSpherical.phi),this._goalSpherical.theta===this._spherical.theta&&this._goalSpherical.phi===this._spherical.phi&&this._goalSpherical.radius===this._spherical.radius&&(h.copy(this.object.position).sub(this.target),h.applyQuaternion(this._quat),this._spherical.setFromVector3(h),this._goalSpherical.copy(this._spherical)),this._spherical.theta=this._clampAzimuthAngle(this._spherical.theta),this._goalSpherical.theta=this._clampAzimuthAngle(this._goalSpherical.theta),this._spherical.phi=this._clampPolarAngle(this._spherical.phi),this._spherical.makeSafe(),this.enableDamping===!0?this.target.addScaledVector(this._panOffset,this.dampingFactor):this.target.add(this._panOffset),this.target.sub(this.cursor),this.target.clampLength(this.minTargetRadius,this.maxTargetRadius),this.target.add(this.cursor);let o=!1;if(this.zoomToCursor&&this._performCursorZoom||this.object.isOrthographicCamera)this._spherical.radius=this._clampDistance(this._spherical.radius);else{const a=this._spherical.radius;this._spherical.radius=this._clampDistance(this._spherical.radius*this._scale),o=a!=this._spherical.radius}if(h.setFromSpherical(this._spherical),h.applyQuaternion(this._quatInverse),s.copy(this.target).add(h),this.object.lookAt(this.target),this.enableDamping===!0?this._panOffset.multiplyScalar(1-this.dampingFactor):(this._sphericalDelta.set(0,0,0),this._panOffset.set(0,0,0)),this.zoomToCursor&&this._performCursorZoom){let a=null;if(this.object.isPerspectiveCamera){const r=h.length();a=this._clampDistance(r*this._scale);const l=r-a;this.object.position.addScaledVector(this._dollyDirection,l),this.object.updateMatrixWorld(),o=!!l}else if(this.object.isOrthographicCamera){const r=new m(this._mouse.x,this._mouse.y,0);r.unproject(this.object);const l=this.object.zoom;this.object.zoom=Math.max(this.minZoom,Math.min(this.maxZoom,this.object.zoom/this._scale)),this.object.updateProjectionMatrix(),o=l!==this.object.zoom;const c=new m(this._mouse.x,this._mouse.y,0);c.unproject(this.object),this.object.position.sub(c).add(r),this.object.updateMatrixWorld(),a=h.length()}else console.warn("WARNING: OrbitControls.js encountered an unknown camera type - zoom to cursor disabled."),this.zoomToCursor=!1;a!==null&&(this.screenSpacePanning?this.target.set(0,0,-1).transformDirection(this.object.matrix).multiplyScalar(a).add(this.object.position):(y.origin.copy(this.object.position),y.direction.set(0,0,-1).transformDirection(this.object.matrix),Math.abs(this.object.up.dot(y.direction))<st?this.object.lookAt(this.target):(O.setFromNormalAndCoplanarPoint(this.object.up,this.target),y.intersectPlane(O,this.target))))}else if(this.object.isOrthographicCamera){const a=this.object.zoom;this.object.zoom=Math.max(this.minZoom,Math.min(this.maxZoom,this.object.zoom/this._scale)),a!==this.object.zoom&&(this.object.updateProjectionMatrix(),o=!0)}return this._scale=1,this._performCursorZoom=!1,o||this._lastPosition.distanceToSquared(this.object.position)>R||8*(1-this._lastQuaternion.dot(this.object.quaternion))>R||this._lastTargetPosition.distanceToSquared(this.target)>R?(this.dispatchEvent(A),this._lastPosition.copy(this.object.position),this._lastQuaternion.copy(this.object.quaternion),this._lastTargetPosition.copy(this.target),!0):!1}_wrapAngle(t){const e=(t+Math.PI)/(2*Math.PI);return(e-Math.floor(e))*2*Math.PI-Math.PI}_clampAzimuthAngle(t){const e=this.minAzimuthAngle,s=this.maxAzimuthAngle;if(!isFinite(e)||!isFinite(s))return t;let o=e,a=s;if(o<-Math.PI?o+=p:o>Math.PI&&(o-=p),a<-Math.PI?a+=p:a>Math.PI&&(a-=p),o<=a)return Math.max(o,Math.min(a,t));{const r=(o+a)*.5;return t>r?Math.max(o,t):Math.min(a,t)}}_clampPolarAngle(t){return Math.max(this.minPolarAngle,Math.min(this.maxPolarAngle,t))}_getAutoRotationAngle(t){return t!==null?p/60*this.autoRotateSpeed*t:p/60/60*this.autoRotateSpeed}_getZoomScale(t){return Math.abs(t)*ot*this.zoomSensitivity/30}_rotateLeft(t){this._goalSpherical.theta=this._clampAzimuthAngle(this._goalSpherical.theta-t)}_rotateUp(t){this._goalSpherical.phi=this._clampPolarAngle(this._goalSpherical.phi-t)}_panLeft(t,e){h.setFromMatrixColumn(e,0),h.multiplyScalar(-t),this._panOffset.add(h)}_panUp(t,e){this.screenSpacePanning===!0?h.setFromMatrixColumn(e,1):(h.setFromMatrixColumn(e,0),h.crossVectors(this.object.up,h)),h.multiplyScalar(t),this._panOffset.add(h)}_pan(t,e){const s=this.domElement;if(this.object.isPerspectiveCamera){const o=this.object.position;h.copy(o).sub(this.target);let a=h.length();a*=Math.tan(this.object.fov/2*Math.PI/180),this._panLeft(2*t*a/s.clientHeight,this.object.matrix),this._panUp(2*e*a/s.clientHeight,this.object.matrix)}else this.object.isOrthographicCamera?(this._panLeft(t*(this.object.right-this.object.left)/this.object.zoom/s.clientWidth,this.object.matrix),this._panUp(e*(this.object.top-this.object.bottom)/this.object.zoom/s.clientHeight,this.object.matrix)):(console.warn("WARNING: OrbitControls.js encountered an unknown camera type - pan disabled."),this.enablePan=!1)}_dollyOut(t,e=!1){this.object.isPerspectiveCamera||this.object.isOrthographicCamera?e?this._goalSpherical.radius=this._clampDistance(this._goalSpherical.radius+t):this._scale/=t:(console.warn("WARNING: OrbitControls.js encountered an unknown camera type - dolly/zoom disabled."),this.enableZoom=!1)}_dollyIn(t,e=!1){this.object.isPerspectiveCamera||this.object.isOrthographicCamera?e?this._goalSpherical.radius=this._clampDistance(this._goalSpherical.radius-t):this._scale*=t:(console.warn("WARNING: OrbitControls.js encountered an unknown camera type - dolly/zoom disabled."),this.enableZoom=!1)}_updateZoomParameters(t,e){if(!this.zoomToCursor)return;this._performCursorZoom=!0;const s=this.domElement.getBoundingClientRect(),o=t-s.left,a=e-s.top,r=s.width,l=s.height;this._mouse.x=o/r*2-1,this._mouse.y=-(a/l)*2+1,this._dollyDirection.set(this._mouse.x,this._mouse.y,1).unproject(this.object).sub(this.object.position).normalize()}_clampDistance(t){return Math.max(this.minDistance,Math.min(this.maxDistance,t))}_handleMouseDownRotate(t){this._rotateStart.set(t.clientX,t.clientY)}_handleMouseDownDolly(t){this._updateZoomParameters(t.clientX,t.clientX),this._dollyStart.set(t.clientX,t.clientY)}_handleMouseDownPan(t){this._panStart.set(t.clientX,t.clientY)}_handleMouseMoveRotate(t){this._rotateEnd.set(t.clientX,t.clientY),this._rotateDelta.subVectors(this._rotateEnd,this._rotateStart).multiplyScalar(this.rotateSpeed);const e=this.domElement;this._rotateLeft(p*this._rotateDelta.x/e.clientHeight),this._rotateUp(p*this._rotateDelta.y/e.clientHeight),this._rotateStart.copy(this._rotateEnd)}_handleMouseMoveDolly(t){this._dollyEnd.set(t.clientX,t.clientY),this._dollyDelta.subVectors(this._dollyEnd,this._dollyStart),this._dollyDelta.y>0?this._dollyOut(this._getZoomScale(this._dollyDelta.y),!0):this._dollyDelta.y<0&&this._dollyIn(this._getZoomScale(this._dollyDelta.y),!0),this._dollyStart.copy(this._dollyEnd)}_handleMouseMovePan(t){this._panEnd.set(t.clientX,t.clientY),this._panDelta.subVectors(this._panEnd,this._panStart).multiplyScalar(this.panSpeed),this._pan(this._panDelta.x,this._panDelta.y),this._panStart.copy(this._panEnd)}_handleMouseWheel(t){this._updateZoomParameters(t.clientX,t.clientY),t.deltaY<0?this._dollyIn(this._getZoomScale(t.deltaY),!0):t.deltaY>0&&this._dollyOut(this._getZoomScale(t.deltaY),!0)}_handleKeyDown(t){let e=!1;switch(t.code){case this.keys.UP:t.ctrlKey||t.metaKey||t.shiftKey?this.enableRotate&&this._rotateUp(p*this.keyRotateSpeed/this.domElement.clientHeight):this.enablePan&&this._pan(0,this.keyPanSpeed),e=!0;break;case this.keys.BOTTOM:t.ctrlKey||t.metaKey||t.shiftKey?this.enableRotate&&this._rotateUp(-p*this.keyRotateSpeed/this.domElement.clientHeight):this.enablePan&&this._pan(0,-this.keyPanSpeed),e=!0;break;case this.keys.LEFT:t.ctrlKey||t.metaKey||t.shiftKey?this.enableRotate&&this._rotateLeft(p*this.keyRotateSpeed/this.domElement.clientHeight):this.enablePan&&this._pan(this.keyPanSpeed,0),e=!0;break;case this.keys.RIGHT:t.ctrlKey||t.metaKey||t.shiftKey?this.enableRotate&&this._rotateLeft(-p*this.keyRotateSpeed/this.domElement.clientHeight):this.enablePan&&this._pan(-this.keyPanSpeed,0),e=!0;break}e&&t.preventDefault()}_handleTouchStartRotate(t){if(this._pointers.length===1)this._rotateStart.set(t.pageX,t.pageY);else{const e=this._getSecondPointerPosition(t),s=.5*(t.pageX+e.x),o=.5*(t.pageY+e.y);this._rotateStart.set(s,o)}}_handleTouchStartPan(t){if(this._pointers.length===1)this._panStart.set(t.pageX,t.pageY);else{const e=this._getSecondPointerPosition(t),s=.5*(t.pageX+e.x),o=.5*(t.pageY+e.y);this._panStart.set(s,o)}}_handleTouchStartDolly(t){const e=this._getSecondPointerPosition(t),s=t.pageX-e.x,o=t.pageY-e.y,a=Math.sqrt(s*s+o*o);this._dollyStart.set(0,a)}_handleTouchStartDollyPan(t){this.enableZoom&&this._handleTouchStartDolly(t),this.enablePan&&this._handleTouchStartPan(t)}_handleTouchStartDollyRotate(t){this.enableZoom&&this._handleTouchStartDolly(t),this.enableRotate&&this._handleTouchStartRotate(t)}_handleTouchMoveRotate(t){if(this._pointers.length==1)this._rotateEnd.set(t.pageX,t.pageY);else{const s=this._getSecondPointerPosition(t),o=.5*(t.pageX+s.x),a=.5*(t.pageY+s.y);this._rotateEnd.set(o,a)}this._rotateDelta.subVectors(this._rotateEnd,this._rotateStart).multiplyScalar(this.rotateSpeed);const e=this.domElement;this._rotateLeft(p*this._rotateDelta.x/e.clientHeight),this._rotateUp(p*this._rotateDelta.y/e.clientHeight),this._rotateStart.copy(this._rotateEnd)}_handleTouchMovePan(t){if(this._pointers.length===1)this._panEnd.set(t.pageX,t.pageY);else{const e=this._getSecondPointerPosition(t),s=.5*(t.pageX+e.x),o=.5*(t.pageY+e.y);this._panEnd.set(s,o)}this._panDelta.subVectors(this._panEnd,this._panStart).multiplyScalar(this.panSpeed),this._pan(this._panDelta.x,this._panDelta.y),this._panStart.copy(this._panEnd)}_handleTouchMoveDolly(t){const e=this._getSecondPointerPosition(t),s=t.pageX-e.x,o=t.pageY-e.y,a=Math.sqrt(s*s+o*o);this._dollyEnd.set(0,a),this._dollyDelta.set(0,Math.pow(this._dollyEnd.y/this._dollyStart.y,this.zoomSpeed)),this._dollyOut(this._dollyDelta.y),this._dollyStart.copy(this._dollyEnd);const r=(t.pageX+e.x)*.5,l=(t.pageY+e.y)*.5;this._updateZoomParameters(r,l)}_handleTouchMoveDollyPan(t){this.enableZoom&&this._handleTouchMoveDolly(t),this.enablePan&&this._handleTouchMovePan(t)}_handleTouchMoveDollyRotate(t){this.enableZoom&&this._handleTouchMoveDolly(t),this.enableRotate&&this._handleTouchMoveRotate(t)}_addPointer(t){this._pointers.push(t.pointerId)}_removePointer(t){delete this._pointerPositions[t.pointerId];for(let e=0;e<this._pointers.length;e++)if(this._pointers[e]==t.pointerId){this._pointers.splice(e,1);return}}_isTrackingPointer(t){for(let e=0;e<this._pointers.length;e++)if(this._pointers[e]==t.pointerId)return!0;return!1}_trackPointer(t){let e=this._pointerPositions[t.pointerId];e===void 0&&(e=new d,this._pointerPositions[t.pointerId]=e),e.set(t.pageX,t.pageY)}_getSecondPointerPosition(t){const e=t.pointerId===this._pointers[0]?this._pointers[1]:this._pointers[0];return this._pointerPositions[e]}_customWheelEvent(t){const e=t.deltaMode,s={clientX:t.clientX,clientY:t.clientY,deltaY:t.deltaY};return s.deltaY*=e==1?18:1,t.ctrlKey&&!this._controlActive&&(s.deltaY*=10),s}}function nt(i){this.enabled!==!1&&(this._pointers.length===0&&(this.domElement.setPointerCapture(i.pointerId),this.domElement.addEventListener("pointermove",this._onPointerMove),this.domElement.addEventListener("pointerup",this._onPointerUp)),!this._isTrackingPointer(i)&&(this._addPointer(i),i.pointerType==="touch"?this._onTouchStart(i):this._onMouseDown(i)))}function ht(i){this.enabled!==!1&&(i.pointerType==="touch"?this._onTouchMove(i):this._onMouseMove(i))}function rt(i){switch(this._removePointer(i),this._pointers.length){case 0:this.domElement.releasePointerCapture(i.pointerId),this.domElement.removeEventListener("pointermove",this._onPointerMove),this.domElement.removeEventListener("pointerup",this._onPointerUp),this.dispatchEvent(L),this.state=n.NONE;break;case 1:const t=this._pointers[0],e=this._pointerPositions[t];this._onTouchStart({pointerId:t,pageX:e.x,pageY:e.y});break}}function lt(i){let t;switch(i.button){case 0:t=this.mouseButtons.LEFT;break;case 1:t=this.mouseButtons.MIDDLE;break;case 2:t=this.mouseButtons.RIGHT;break;default:t=-1}switch(t){case g.DOLLY:if(this.enableZoom===!1)return;this._handleMouseDownDolly(i),this.state=n.DOLLY;break;case g.ROTATE:if(i.ctrlKey||i.metaKey||i.shiftKey){if(this.enablePan===!1)return;this._handleMouseDownPan(i),this.state=n.PAN}else{if(this.enableRotate===!1)return;this._handleMouseDownRotate(i),this.state=n.ROTATE}break;case g.PAN:if(i.ctrlKey||i.metaKey||i.shiftKey){if(this.enableRotate===!1)return;this._handleMouseDownRotate(i),this.state=n.ROTATE}else{if(this.enablePan===!1)return;this._handleMouseDownPan(i),this.state=n.PAN}break;default:this.state=n.NONE}this.state!==n.NONE&&this.dispatchEvent(D)}function ct(i){switch(this.state){case n.ROTATE:if(this.enableRotate===!1)return;this._handleMouseMoveRotate(i);break;case n.DOLLY:if(this.enableZoom===!1)return;this._handleMouseMoveDolly(i);break;case n.PAN:if(this.enablePan===!1)return;this._handleMouseMovePan(i);break}}function pt(i){this.enabled===!1||this.enableZoom===!1||this.state!==n.NONE||(i.preventDefault(),this.dispatchEvent(D),this._handleMouseWheel(this._customWheelEvent(i)),this.dispatchEvent(L))}function dt(i){this.enabled!==!1&&this._handleKeyDown(i)}function mt(i){switch(this._trackPointer(i),this._pointers.length){case 1:switch(this.touches.ONE){case f.ROTATE:if(this.enableRotate===!1)return;this._handleTouchStartRotate(i),this.state=n.TOUCH_ROTATE;break;case f.PAN:if(this.enablePan===!1)return;this._handleTouchStartPan(i),this.state=n.TOUCH_PAN;break;default:this.state=n.NONE}break;case 2:switch(this.touches.TWO){case f.DOLLY_PAN:if(this.enableZoom===!1&&this.enablePan===!1)return;this._handleTouchStartDollyPan(i),this.state=n.TOUCH_DOLLY_PAN;break;case f.DOLLY_ROTATE:if(this.enableZoom===!1&&this.enableRotate===!1)return;this._handleTouchStartDollyRotate(i),this.state=n.TOUCH_DOLLY_ROTATE;break;default:this.state=n.NONE}break;default:this.state=n.NONE}this.state!==n.NONE&&this.dispatchEvent(D)}function ut(i){switch(this._trackPointer(i),this.state){case n.TOUCH_ROTATE:if(this.enableRotate===!1)return;this._handleTouchMoveRotate(i);break;case n.TOUCH_PAN:if(this.enablePan===!1)return;this._handleTouchMovePan(i);break;case n.TOUCH_DOLLY_PAN:if(this.enableZoom===!1&&this.enablePan===!1)return;this._handleTouchMoveDollyPan(i);break;case n.TOUCH_DOLLY_ROTATE:if(this.enableZoom===!1&&this.enableRotate===!1)return;this._handleTouchMoveDollyRotate(i);break;default:this.state=n.NONE}}function _t(i){this.enabled!==!1&&i.preventDefault()}function ft(i){i.key==="Control"&&(this._controlActive=!0,this.domElement.getRootNode().addEventListener("keyup",this._interceptControlUp,{passive:!0,capture:!0}))}function gt(i){i.key==="Control"&&(this._controlActive=!1,this.domElement.getRootNode().removeEventListener("keyup",this._interceptControlUp,{passive:!0,capture:!0}))}class yt{constructor(t){var e,s;this.canvas=t.canvas,this.inputElement=t.inputElement,this.modelUrl=t.modelUrl,this.envmapUrl=t.envmapUrl,this.lowPerformanceSettings={disableAA:((e=t.lowPerformanceSettings)==null?void 0:e.disableAA)??!1,lowResolution:((s=t.lowPerformanceSettings)==null?void 0:s.lowResolution)??!1},this.baseLoadPixelRatio=t.pixelRatio??window.devicePixelRatio,this.initialRenderPixelRatio=this.lowPerformanceSettings.lowResolution?t.pixelRatio/2:this.baseLoadPixelRatio,this.performantRenderPixelRatio=null,this.msaaSamples=this.lowPerformanceSettings.disableAA?0:4,this.pixelRatioVariation=1,this.scene=null,this.camera=null,this.cameraSettings={targetDistance:t.targetDistance,maxDistance:t.targetDistance/.9,minDistance:t.minDistance},this.renderer=null,this.pipeline=null,this.controls=null,this.mixer=null,this.pickHelper=null,this.lastResizeTime=null,this.throttleResize=150,this.lastFrame=performance.now(),this.hasAborted=!1,this.initScene()}initScene(){this.setupRenderer(),this.setupCamera(),this.setupControls(),this.setupScene(),this.setupPostProcessing(),this.setupInteraction(),this.loadAssets().then(()=>{this.startPerformanceSamplingLoop()}).catch(t=>{this.abortLoading(t)})}setupRenderer(){this.renderer=new N({powerPreference:"high-performance",antialias:!0,canvas:this.canvas,stencil:!1,depth:!1}),this.renderer.setPixelRatio(this.initialRenderPixelRatio),this.renderer.toneMappingExposure=1.3}setupCamera(){this.camera=new I(50,2,.1,100),this.camera.position.z=this.cameraSettings.targetDistance}setupControls(){this.controls=new at(this.camera,this.inputElement),this.controls.enableDamping=!0,this.controls.dampingFactor=.055,this.controls.target.set(0,0,0),this.controls.maxDistance=this.cameraSettings.maxDistance,this.controls.minDistance=this.cameraSettings.minDistance,this.controls.decayTime=100,this.controls.update()}setupScene(){this.scene=new U,this.scene.background=new Y(0)}setupLighting(){const t=new H(16777215,10);t.position.set(0,0,5),this.scene.add(t)}setupPostProcessing(){this.pipeline=new V(this.renderer),this.pipeline.add(new B),this.pipeline.add(new G(this.scene,this.camera,{frameBufferType:M,samples:this.msaaSamples})),this.pipeline.add(new Q(new $({luminanceSmoothing:.4,intensity:.2,radius:1,luminanceThreshold:.1,levels:8}),new J({toneMapping:tt.REINHARD})))}resetPostProcessing(){this.pipeline.dispose(),this.pipeline=null,this.setupPostProcessing()}setupInteraction(){this.pickPosition={x:-2,y:-2},this.pickHelper=new Pt,this.clearPickPosition(),this.inputElement.addEventListener("mousemove",this.setPickPosition.bind(this)),this.inputElement.addEventListener("mouseout",this.clearPickPosition.bind(this)),this.inputElement.addEventListener("mouseleave",this.clearPickPosition.bind(this)),this.inputElement.addEventListener("contextmenu",()=>{console.log("hi")}),this.setupTouchEvents()}setupTouchEvents(){this.inputElement.addEventListener("touchstart",t=>{t.preventDefault(),this.setPickPosition(t.touches[0])},{passive:!1}),this.inputElement.addEventListener("touchmove",t=>{this.setPickPosition(t.touches[0])}),this.inputElement.addEventListener("touchend",()=>{this.clearPickPosition()})}abortLoading(t){console.error("Aborting scene loading:",t),this.hasAborted=!0}loadAssets(){return Promise.all([this.loadArtworkModel(),this.loadHDREnvironment()])}loadArtworkModel(){return new Promise((t,e)=>{new Z().load(this.modelUrl,async o=>{if(this.hasAborted)return;const a=o.scene;a.scale.set(1,1,1),this.optimizeModelTextures(a),await this.renderer.compileAsync(a,this.camera,this.scene),this.mixer=new K(a),this.mixer.clipAction(o.animations[0]),this.scene.add(a),t()},void 0,o=>{e("Failed to load artwork model: "+o)})})}optimizeModelTextures(t){t.traverse(e=>{e.isMesh&&(this.applyTextureOptimization(e.material.map),this.applyTextureOptimization(e.material.normalMap),this.applyTextureOptimization(e.material.roughnessMap),this.applyTextureOptimization(e.material.metalnessMap))})}applyTextureOptimization(t){t&&(t.minFilter=w,t.magFilter=x,t.anisotropy=this.renderer.capabilities.getMaxAnisotropy(),t.generateMipmaps=!0)}loadHDREnvironment(){return new Promise((t,e)=>{new W(this.renderer).load(this.envmapUrl,o=>{const a=o.renderTarget.texture;this.configureHDRTexture(a),this.scene.environment=a,this.scene.environment.mapping=q,o.dispose(),t()},void 0,o=>{e("Failed to load HDR environment: "+o)})})}configureHDRTexture(t){t.type=M,t.minFilter=w,t.magFilter=x,t.generateMipmaps=!0,t.needsUpdate=!0}startPerformanceSamplingLoop(){let s=null,o=0,a=!1;const r=c=>{if(console.log(`Applying quality settings for FPS: ${c.toFixed(1)}`),c<50&&this.msaaSamples>0&&(this.msaaSamples=0,this.resetPostProcessing()),c<30){const u=Math.min(c/75,1),P=Math.sqrt(this.initialRenderPixelRatio**2.8*u);this.performantRenderPixelRatio=Math.max(.8,Math.min(P,this.initialRenderPixelRatio))}this.startRenderLoop()},l=()=>{const c=performance.now();if(this.handleResize(),this.updateScene(c),this.pipeline.render(c),!s){s=c,requestAnimationFrame(l);return}if(!a&&c-s<400){requestAnimationFrame(l);return}a||(a=!0,s=c,o=0),o++;const _=c-s;if(_>=500){const u=o/(_/1e3);console.log(`Measured FPS: ${u.toFixed(1)}`),r(u)}else requestAnimationFrame(l)};requestAnimationFrame(l)}startRenderLoop(){const t=e=>{const s=performance.now();this.handleResize(),this.updateScene(s),this.pipeline.render(s),requestAnimationFrame(t)};requestAnimationFrame(t)}getWorkingPixelRatio(){return this.performantRenderPixelRatio?this.performantRenderPixelRatio*this.pixelRatioVariation:this.initialRenderPixelRatio?this.initialRenderPixelRatio*this.pixelRatioVariation:window.devicePixelRatio}handleResize(t=!1){const{clientWidth:e,clientHeight:s,pixelRatio:o}=this.inputElement;this.pixelRatioVariation=o/this.baseLoadPixelRatio;const a=this.getWorkingPixelRatio(),r=performance.now();(t||this.needsResize(r,e,s,a))&&(this.updateRendererSize(e,s,a),this.lastResizeTime=r,this.camera.aspect=e/s,this.camera.updateProjectionMatrix())}needsResize(t,e,s,o){if(t-this.lastResizeTime<this.throttleResize)return!1;const a=this.renderer.domElement;return a.width!==Math.floor(e*o)||a.height!==Math.floor(s*o)||o!==this.renderer.getPixelRatio()}updateRendererSize(t,e,s){this.renderer.setPixelRatio(s||1),this.renderer.setSize(t,e,!1),this.pipeline.setSize(t,e,!1),this.pipeline.setPixelRatio(this.renderer.getPixelRatio())}updateScene(t){const e=(t-this.lastFrame)/1e3;this.mixer&&this.mixer.update(e),this.controls.update(e),this.lastFrame=t}getCanvasRelativePosition(t){const e=this.inputElement.getBoundingClientRect();return{x:t.clientX-e.left,y:t.clientY-e.top}}setPickPosition(t){const e=this.getCanvasRelativePosition(t);this.pickPosition.x=e.x/this.inputElement.clientWidth*2-1,this.pickPosition.y=e.y/this.inputElement.clientHeight*-2+1}clearPickPosition(){this.pickPosition.x=-1e5,this.pickPosition.y=-1e5}}class Pt{constructor(){this.raycaster=new X,this.pickedObject=null,this.pickedObjectSavedColor=0}pick(t,e,s,o){this.pickedObject&&(this.pickedObject.material.emissive.setHex(this.pickedObjectSavedColor),this.pickedObject=void 0),this.raycaster.setFromCamera(t,s);const a=this.raycaster.intersectObjects(e.children);a.length&&(this.pickedObject=a[0].object,this.pickedObjectSavedColor=this.pickedObject.material.emissive.getHex(),this.pickedObject.material.emissive.setHex(o*8%2>1?16776960:16711680))}}function Dt(i){return new yt(i)}export{Dt as i};
