import {
	Controls,
	MOUSE,
	Quaternion,
	Spherical,
	TOUCH,
	Vector2,
	Vector3,
	Plane,
	Ray,
	MathUtils
} from 'three';

import { Damper } from './Damper'

// OrbitControls performs orbiting, dollying (zooming), and panning.
// Unlike TrackballControls, it maintains the "up" direction object.up (+Y by default).
//
//    Orbit - left mouse / touch: one-finger move
//    Zoom - middle mouse, or mousewheel / touch: two-finger spread or squish
//    Pan - right mouse, or left mouse + ctrl/meta/shiftKey, or arrow keys / touch: two-finger move

const _changeEvent = { type: 'change' };
const _startEvent = { type: 'start' };
const _endEvent = { type: 'end' };
const _ray = new Ray();
const _plane = new Plane();
const _TILT_LIMIT = Math.cos( 70 * MathUtils.DEG2RAD );
const ZOOM_SENSITIVITY = 0.04;

const _v = new Vector3();
const _twoPI = 2 * Math.PI;

const _STATE = {
	NONE: - 1,
	ROTATE: 0,
	DOLLY: 1,
	PAN: 2,
	TOUCH_ROTATE: 3,
	TOUCH_PAN: 4,
	TOUCH_DOLLY_PAN: 5,
	TOUCH_DOLLY_ROTATE: 6
};
const _EPS = 0.000001;

class OrbitControls extends Controls {

	constructor( object, domElement = null ) {

		super( object, domElement );

		this.state = _STATE.NONE;

		// Set to false to disable this control
		this.enabled = true;

		// "target" sets the location of focus, where the object orbits around
		this.target = new Vector3();
		this._goalTarget = this.target.clone();

		// Sets the 3D cursor (similar to Blender), from which the maxTargetRadius takes effect
		this.cursor = new Vector3();

		// How far you can dolly in and out ( PerspectiveCamera only )
		this.minDistance = 0;
		this.maxDistance = Infinity;

		// How far you can zoom in and out ( OrthographicCamera only )
		this.minZoom = 0;
		this.maxZoom = Infinity;

		// Limit camera target within a spherical area around the cursor
		this.minTargetRadius = 0;
		this.maxTargetRadius = Infinity;

		// How far you can orbit vertically, upper and lower limits.
		// Range is 0 to Math.PI radians.
		this.minPolarAngle = 0; // radians
		this.maxPolarAngle = Math.PI; // radians

		// How far you can orbit horizontally, upper and lower limits.
		// If set, the interval [ min, max ] must be a sub-interval of [ - 2 PI, 2 PI ], with ( max - min < 2 PI )
		this.minAzimuthAngle = - Infinity; // radians
		this.maxAzimuthAngle = Infinity; // radians

		// Set to true to enable damping (inertia)
		// If damping is enabled, you must call controls.update() in your animation loop
		this.enableDamping = false;
		this.dampingFactor = 0.1;
      this.zoomDampingFactor = 0.1;

		// This option actually enables dollying in and out; left as "zoom" for backwards compatibility.
		// Set to false to disable zooming
		this.enableZoom = true;
		this.pinchToZoomSpeed = 0.6;
		this.zoomSensitivity = 1;

		// Set to false to disable rotating
		this.enableRotate = true;
		this.rotateSpeed = 1.0;
		this.keyRotateSpeed = 1.0;

		// Set to false to disable panning
		this.enablePan = true;
		this.panSpeed = 1.0;
		this.screenSpacePanning = true; // if false, pan orthogonal to world-space direction camera.up
		this.keyPanSpeed = 7.0;	// pixels moved per arrow key push
		this.zoomToCursor = false;

		// Set to true to automatically rotate around the target
		// If auto-rotate is enabled, you must call controls.update() in your animation loop
		this.autoRotate = false;
		this.autoRotateSpeed = 2.0; // 30 seconds per orbit when fps is 60

		// The four arrow keys
		this.keys = { LEFT: 'ArrowLeft', UP: 'ArrowUp', RIGHT: 'ArrowRight', BOTTOM: 'ArrowDown' };

		// Mouse buttons
		this.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };

		// Touch fingers
		this.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN };

		// for reset
		this.target0 = this.target.clone();
		this.position0 = this.object.position.clone();
		this.zoom0 = this.object.zoom;

		// the target DOM element for key events
		this._domElementKeyEvents = null;

		// internals

		this._lastPosition = new Vector3();
		this._lastQuaternion = new Quaternion();
		this._lastTargetPosition = new Vector3();

		// so camera.up is the orbit axis
		this._quat = new Quaternion().setFromUnitVectors( object.up, new Vector3( 0, 1, 0 ) );
		this._quatInverse = this._quat.clone().invert();

		// current position in spherical coordinates
		this._spherical = new Spherical();
		this._goalSpherical = new Spherical();
		this._initialSpherical = new Spherical();
		this._sphericalDelta = new Spherical();


		// note: these times are TIME CONSTANTS in MILLISECONDS.
		// They don't actually represent the final timing.
		this.interactiveDecayTimeDampers = {
			radius: 70, 		// zoom using scrol wheel, touchpad
			radiusPinch: 20,	// 2-finger pinch to zoom mobile
			rotation: 58,
			pan: 70,
		}

		// click the object, return camera to init
		this.returnPosDecayTimeDampers = { 
			max: {
				radius: 200, 
				rotation: 200
			},
			min: {
				radius: 50, 
				rotation: 50,
			}
		}

		// Adjust this factor to get the desired “braking” feel
		// smaller number = less distance
		this.stopCameraLerpFactor = 0.3; 

		// this is to avoid decayTimeDamper reset when the
		// camera is still animating back to the returning position
		// and the user activated again the interactivity
		this.firstMove = true;
		this.isMoving = false;

		this.radiusDamper = new Damper(this.interactiveDecayTimeDampers.radius);
		this.thetaDamper = new Damper(this.interactiveDecayTimeDampers.rotation);
		this.phiDamper = new Damper(this.interactiveDecayTimeDampers.rotation);
		
		this.targetXDamper = new Damper(this.interactiveDecayTimeDampers.pan);
		this.targetYDamper = new Damper(this.interactiveDecayTimeDampers.pan);
		this.targetZDamper = new Damper(this.interactiveDecayTimeDampers.pan);

		this._scale = 1;

		this._rotateStart = new Vector2();
		this._rotateEnd = new Vector2();
		this._rotateDelta = new Vector2();

		this._panStart = new Vector2();
		this._panEnd = new Vector2();
		this._panDelta = new Vector2();

		this._dollyStart = new Vector2();
		this._dollyEnd = new Vector2();
		this._dollyDelta = new Vector2();

		this._dollyDirection = new Vector3();
		this._mouse = new Vector2();
		this._performCursorZoom = false;

		this._pointers = [];
		this._pointerPositions = {};

		this._controlActive = false;

		// this._zoomDelta = 0;

		// event listeners

		this._onPointerMove = onPointerMove.bind( this );
		this._onPointerDown = onPointerDown.bind( this );
		this._onPointerUp = onPointerUp.bind( this );
		this._onContextMenu = onContextMenu.bind( this );
		this._onMouseWheel = onMouseWheel.bind( this );
		this._onKeyDown = onKeyDown.bind( this );

		this._onTouchStart = onTouchStart.bind( this );
		this._onTouchMove = onTouchMove.bind( this );

		this._onMouseDown = onMouseDown.bind( this );
		this._onMouseMove = onMouseMove.bind( this );

		this._interceptControlDown = interceptControlDown.bind( this );
		this._interceptControlUp = interceptControlUp.bind( this );

		// https://github.com/google/model-viewer/blob/master/packages/model-viewer/src/three-components/SmoothControls.ts
		this.damperNormalization = {
			sphericalRadius: 1,
			sphericalTheta: Math.PI,
			sphericalPhi: this.maxPolarAngle,
			fov: 1
		}

		// set initial spherical and goalSpherical to be identical
		this._wrapSpherical(this._spherical);
		this._goalSpherical.copy(this._spherical);
		this._initialSpherical.copy(this._spherical);


		if ( this.domElement !== null ) {

			this.connect();

		}


	}

	connect() {

		this.domElement.addEventListener( 'pointerdown', this._onPointerDown );
		this.domElement.addEventListener( 'pointercancel', this._onPointerUp );
		this.domElement.addEventListener( 'pointerout', this._onPointerUp );

		this.domElement.addEventListener( 'contextmenu', this._onContextMenu );
		this.domElement.addEventListener( 'wheel', this._onMouseWheel, { passive: false } );

		const document = this.domElement.getRootNode(); // offscreen canvas compatibility
		document.addEventListener( 'keydown', this._interceptControlDown, { passive: true, capture: true } );

		// this.domElement.style.touchAction = 'none'; // disable touch scroll

	}

	disconnect() {

		this.domElement.removeEventListener( 'pointerdown', this._onPointerDown );
		this.domElement.removeEventListener( 'pointermove', this._onPointerMove );
		this.domElement.removeEventListener( 'pointerup', this._onPointerUp );
		this.domElement.removeEventListener( 'pointercancel', this._onPointerUp );
		this.domElement.removeEventListener( 'pointerout', this._onPointerUp );

		this.domElement.removeEventListener( 'wheel', this._onMouseWheel );
		this.domElement.removeEventListener( 'contextmenu', this._onContextMenu );

		this.stopListenToKeyEvents();

		const document = this.domElement.getRootNode(); // offscreen canvas compatibility
		document.removeEventListener( 'keydown', this._interceptControlDown, { capture: true } );

		// this.domElement.style.touchAction = 'auto';

	}

	dispose() {

		this.disconnect();

	}

	getPolarAngle() {

		return this._spherical.phi;

	}

	getAzimuthalAngle() {

		return this._spherical.theta;

	}

	getDistance() {

		return this.object.position.distanceTo( this.target );

	}

	listenToKeyEvents( domElement ) {

		domElement.addEventListener( 'keydown', this._onKeyDown );
		this._domElementKeyEvents = domElement;

	}

	stopListenToKeyEvents() {

		if ( this._domElementKeyEvents !== null ) {

			this._domElementKeyEvents.removeEventListener( 'keydown', this._onKeyDown );
			this._domElementKeyEvents = null;

		}

	}

	// unused for now
	firstMoveDecay() {
		if (!this.firstMove) return
		this.setDamperDecayTimers(this.interactiveDecayTimeDampers);
		this._goalSpherical.copy(this._spherical);
		this.firstMove = false;
	}

	stopCameraSmooth() {	 
		this.setDamperDecayTimers(this.interactiveDecayTimeDampers);

		// Example: if _spherical.theta is -1.0 and _goalSpherical.theta is -0.4,
		// then the new goal becomes: -1.0 + 0.33 * (0.6) ≈ -0.8.
		this._goalSpherical.theta = this._spherical.theta + (this._goalSpherical.theta - this._spherical.theta) * this.stopCameraLerpFactor;
	 
		this._goalSpherical.phi = this._spherical.phi + (this._goalSpherical.phi - this._spherical.phi) * this.stopCameraLerpFactor;
	 
		this._goalSpherical.radius = this._spherical.radius + (this._goalSpherical.radius - this._spherical.radius) * this.stopCameraLerpFactor;
	 }

	saveState() {

		this.target0.copy( this.target );
		this.position0.copy( this.object.position );
		this.zoom0 = this.object.zoom;

	}

	reset() {

		this.target.copy( this.target0 );
		this._goalTarget.copy( this.target0 );
		this.object.position.copy( this.position0 );
		this.object.zoom = this.zoom0;
  
		this.object.updateProjectionMatrix();
		this.dispatchEvent( _changeEvent );
  
		this.state = _STATE.NONE;

  }

	setDamperDecayTimers(decayTimeDampers) {
		this.radiusDamper.setDecayConstant(decayTimeDampers.radius);
		this.thetaDamper.setDecayConstant(decayTimeDampers.rotation);
		this.phiDamper.setDecayConstant(decayTimeDampers.rotation);
	}

	_wrapSpherical(spherical) {
		_v.copy(this.object.position).sub(this.target);
		_v.applyQuaternion(this._quat);
		spherical.setFromVector3(_v);
	}

	returnToInit() {
		// Update the current spherical coordinates from the current camera position.
		this._wrapSpherical(this._spherical);
		this.isMoving = true;
	 
		// Compute differences from the initial spherical values.
		const deltaRadius = Math.abs(this._spherical.radius - this._initialSpherical.radius);
		const deltaTheta = Math.abs(this._spherical.theta - this._initialSpherical.theta);
		const deltaPhi = Math.abs(this._spherical.phi - this._initialSpherical.phi);
	 
		// Use the maximum of the angular differences for rotation.
		const deltaRotation = Math.max(deltaTheta, deltaPhi);
	 
		// Define time-constant maximum decay times (from your current settings) in milliseconds.
		const maxRadiusDecay = this.returnPosDecayTimeDampers.max.radius;
		const maxRotationDecay = this.returnPosDecayTimeDampers.max.rotation;
	 
		// Define time-constant minimum decay times (when the camera is nearly at the initial state).
		const minRadiusDecay = this.returnPosDecayTimeDampers.min.radius;
		const minRotationDecay = this.returnPosDecayTimeDampers.min.rotation;
	 
		// Normalize differences.
		// For radius, use the initial radius as a baseline (avoid division by zero).
		const normRadius = this._initialSpherical.radius || 1;
		const radiusDiffRatio = Math.min(1, deltaRadius / normRadius);
	 
		// For rotation, assume that PI radians is the maximum meaningful difference.
		const normRotation = Math.PI;
		const rotationDiffRatio = Math.min(1, deltaRotation / normRotation);
	 
		// Compute the new damper decay times by interpolating between the minimum and maximum.
		const newRadiusDecay = minRadiusDecay + (maxRadiusDecay - minRadiusDecay) * radiusDiffRatio;
		const newRotationDecay = minRotationDecay + (maxRotationDecay - minRotationDecay) * rotationDiffRatio;
	 
		this._goalTarget.copy( this.target0 );

		// Set the damper decay times using the newly computed values.
		this.setDamperDecayTimers({
		  radius: newRadiusDecay,
		  rotation: newRotationDecay
		});

		// Now set the goal spherical to the initial spherical state.
		this._goalSpherical.copy(this._initialSpherical);
	 
		// Optionally reset the firstMove flag if your logic requires it.
		this.firstMove = true;
	 }

	getMaxApproximateRotationDecayTimerMS() {
		return Math.max(
			this.phiDamper.getApproximateDecayTime(),
			this.thetaDamper.getApproximateDecayTime(),
		)
	}

	update( deltaTime = 0 ) {
		// console.log(this._goalSpherical, this._spherical)

		// deltaTime is in seconds
		const deltaTimeMS = deltaTime * 1000

		const position = this.object.position;

		// _v.copy( position ).sub( this.target );

		// rotate offset to "y-axis-is-up" space
		// _v.applyQuaternion( this._quat );

		// angle from z-axis around y-axis
		// this converts theta angles
		// this._spherical.setFromVector3( _v );
		

		if ( this.autoRotate && this.state === _STATE.NONE ) {

			this._rotateLeft( this._getAutoRotationAngle( deltaTime ) );

		}

		if ( this.enableDamping ) {

			this._spherical.theta = this.thetaDamper.update(
				this._spherical.theta, this._goalSpherical.theta, deltaTimeMS, this.damperNormalization.sphericalTheta)

			this._spherical.phi = this.phiDamper.update(
				this._spherical.phi, this._goalSpherical.phi, deltaTimeMS, this.damperNormalization.sphericalPhi)
   
         if ( this.object.isPerspectiveCamera || this.object.isOrthographicCamera ) {

				this._spherical.radius = this.radiusDamper.update(
					this._spherical.radius, this._goalSpherical.radius, deltaTimeMS, this.damperNormalization.sphericalRadius)
					
         }

		} else {

			this._spherical.radius = this._goalSpherical.radius;
			this._spherical.theta = this._goalSpherical.theta;
			this._spherical.phi = this._goalSpherical.phi;

		}



		// _goalSpherical should already be properly clamped but just to be safe
   	this._spherical.theta = this._clampAzimuthAngle(this._spherical.theta);
   	this._goalSpherical.theta = this._clampAzimuthAngle(this._goalSpherical.theta);
	   this._spherical.phi = this._clampPolarAngle(this._spherical.phi);

		this._spherical.makeSafe();


		// Clamp _goalTarget to the spherical boundary around the cursor
		_v.copy(this._goalTarget).sub(this.cursor);
		_v.clampLength(this.minTargetRadius, this.maxTargetRadius);
		this._goalTarget.copy(this.cursor).add(_v);

		// Apply damping or copy _goalTarget to target
		if (this.enableDamping) {
			const norm = 1;
			this.target.x = this.targetXDamper.update(this.target.x, this._goalTarget.x, deltaTimeMS, norm);
			this.target.y = this.targetYDamper.update(this.target.y, this._goalTarget.y, deltaTimeMS, norm);
			this.target.z = this.targetZDamper.update(this.target.z, this._goalTarget.z, deltaTimeMS, norm);
		} else {
			this.target.copy(this._goalTarget);
		}

		// Limit the target distance from the cursor to create a sphere around the center of interest
		this.target.sub( this.cursor );
		this.target.clampLength( this.minTargetRadius, this.maxTargetRadius );
		this.target.add( this.cursor );

		let zoomChanged = false;
		// adjust the camera position based on zoom only if we're not zooming to the cursor or if it's an ortho camera
		// we adjust zoom later in these cases
		if ( this.zoomToCursor && this._performCursorZoom || this.object.isOrthographicCamera ) {

			this._spherical.radius = this._clampDistance( this._spherical.radius );

		} else {

			const prevRadius = this._spherical.radius;
			this._spherical.radius = this._clampDistance( this._spherical.radius * this._scale );
			zoomChanged = prevRadius != this._spherical.radius;

		}

		_v.setFromSpherical( this._spherical );

		// rotate offset back to "camera-up-vector-is-up" space
		_v.applyQuaternion( this._quatInverse );

		position.copy( this.target ).add( _v );

		this.object.lookAt( this.target );

		// adjust camera position
		if ( this.zoomToCursor && this._performCursorZoom ) {

			let newRadius = null;
			if ( this.object.isPerspectiveCamera ) {

				// move the camera down the pointer ray
				// this method avoids floating point error
				const prevRadius = _v.length();
				newRadius = this._clampDistance( prevRadius * this._scale );

				const radiusDelta = prevRadius - newRadius;
				this.object.position.addScaledVector( this._dollyDirection, radiusDelta );
				this.object.updateMatrixWorld();

				zoomChanged = !! radiusDelta;

			} else if ( this.object.isOrthographicCamera ) {

				// adjust the ortho camera position based on zoom changes
				const mouseBefore = new Vector3( this._mouse.x, this._mouse.y, 0 );
				mouseBefore.unproject( this.object );

				const prevZoom = this.object.zoom;
				this.object.zoom = Math.max( this.minZoom, Math.min( this.maxZoom, this.object.zoom / this._scale ) );
				this.object.updateProjectionMatrix();

				zoomChanged = prevZoom !== this.object.zoom;

				const mouseAfter = new Vector3( this._mouse.x, this._mouse.y, 0 );
				mouseAfter.unproject( this.object );

				this.object.position.sub( mouseAfter ).add( mouseBefore );
				this.object.updateMatrixWorld();

				newRadius = _v.length();

			} else {

				console.warn( 'WARNING: OrbitControls.js encountered an unknown camera type - zoom to cursor disabled.' );
				this.zoomToCursor = false;

			}

			// handle the placement of the target
			if ( newRadius !== null ) {

				if ( this.screenSpacePanning ) {

					// position the orbit target in front of the new camera position
					this.target.set( 0, 0, - 1 )
						.transformDirection( this.object.matrix )
						.multiplyScalar( newRadius )
						.add( this.object.position );

				} else {

					// get the ray and translation plane to compute target
					_ray.origin.copy( this.object.position );
					_ray.direction.set( 0, 0, - 1 ).transformDirection( this.object.matrix );

					// if the camera is 20 degrees above the horizon then don't adjust the focus target to avoid
					// extremely large values
					if ( Math.abs( this.object.up.dot( _ray.direction ) ) < _TILT_LIMIT ) {

						this.object.lookAt( this.target );

					} else {

						_plane.setFromNormalAndCoplanarPoint( this.object.up, this.target );
						_ray.intersectPlane( _plane, this.target );

					}

				}

			}

		} else if ( this.object.isOrthographicCamera ) {

			const prevZoom = this.object.zoom;
			this.object.zoom = Math.max( this.minZoom, Math.min( this.maxZoom, this.object.zoom / this._scale ) );

			if ( prevZoom !== this.object.zoom ) {

				this.object.updateProjectionMatrix();
				zoomChanged = true;

			}

		}

		if (this._goalSpherical.theta === this._spherical.theta &&
			this._goalSpherical.phi === this._spherical.phi &&
			this._goalSpherical.radius === this._spherical.radius &&
			this.target.equals(this._goalTarget)) {
			this.isMoving = false;
			this._wrapSpherical(this._spherical);
			this._goalSpherical.copy(this._spherical);
		} else {
			this.isMoving = true;
		}

		this._scale = 1;
		this._performCursorZoom = false;

		// update condition is:
		// min(camera displacement, camera rotation in radians)^2 > EPS
		// using small-angle approximation cos(x/2) = 1 - x^2 / 8

		if ( zoomChanged ||
			this._lastPosition.distanceToSquared( this.object.position ) > _EPS ||
			8 * ( 1 - this._lastQuaternion.dot( this.object.quaternion ) ) > _EPS ||
			this._lastTargetPosition.distanceToSquared( this.target ) > _EPS ) {

			this.dispatchEvent( _changeEvent );

			this._lastPosition.copy( this.object.position );
			this._lastQuaternion.copy( this.object.quaternion );
			this._lastTargetPosition.copy( this.target );

			return true;

		}

		return false;

	}

	_wrapAngle(radians) {
		// Wraps to between -pi and pi
		const normalized = (radians + Math.PI) / (2 * Math.PI);
		const wrapped = normalized - Math.floor(normalized);
		return wrapped * 2 * Math.PI - Math.PI;
  }

	_clampAzimuthAngle(theta) {
		const min = this.minAzimuthAngle;
		const max = this.maxAzimuthAngle;
  
		if (!isFinite(min) || !isFinite(max)) return theta;
  
		let adjustedMin = min;
		let adjustedMax = max;
  
		// Normalize min/max to [-π, π]
		if (adjustedMin < -Math.PI) adjustedMin += _twoPI;
		else if (adjustedMin > Math.PI) adjustedMin -= _twoPI;
		
		if (adjustedMax < -Math.PI) adjustedMax += _twoPI;
		else if (adjustedMax > Math.PI) adjustedMax -= _twoPI;
  
		if (adjustedMin <= adjustedMax) {
			 return Math.max(adjustedMin, Math.min(adjustedMax, theta));
		} else {
			 const midpoint = (adjustedMin + adjustedMax) * 0.5;
			 return theta > midpoint ? Math.max(adjustedMin, theta) : Math.min(adjustedMax, theta);
		}
  }

	_clampPolarAngle(phi) {
		return Math.max(this.minPolarAngle, Math.min(this.maxPolarAngle, phi));
	}


	_getAutoRotationAngle( deltaTime ) {

		if ( deltaTime !== null ) {

			return ( _twoPI / 60 * this.autoRotateSpeed ) * deltaTime;

		} else {

			return _twoPI / 60 / 60 * this.autoRotateSpeed;

		}

	}

	_getZoomScale( delta ) {
		const normalizedDelta = Math.abs( delta );
		// const asd = Math.pow(2.0, normalizedDelta ) * this.zoomSensitivity / 10000;
		return normalizedDelta * ZOOM_SENSITIVITY * this.zoomSensitivity / 30;
		// const asd = normalizedDelta * this.zoomSensitivity / 10000;
		// console.log(delta, asd)

	}

	_rotateLeft(angle) {
		// this.firstMoveDecay();
		this._goalSpherical.theta = this._clampAzimuthAngle(this._goalSpherical.theta - angle);
  }

	_rotateUp(angle) {
		// this.firstMoveDecay();
		this._goalSpherical.phi = this._clampPolarAngle(this._goalSpherical.phi - angle);
	}

	_panLeft( distance, objectMatrix ) {

		_v.setFromMatrixColumn( objectMatrix, 0 ); // get X column of objectMatrix
		_v.multiplyScalar( -distance );
		this._goalTarget.add( _v );
		
  }

	_panUp( distance, objectMatrix ) {

		if ( this.screenSpacePanning === true ) {

			_v.setFromMatrixColumn( objectMatrix, 1 );

		} else {

			_v.setFromMatrixColumn( objectMatrix, 0 );
			_v.crossVectors( this.object.up, _v );

		}

		_v.multiplyScalar( distance );

		this._goalTarget.add( _v );

	}

	// deltaX and deltaY are in pixels; right and down are positive
	_pan( deltaX, deltaY ) {

		const element = this.domElement;

		if ( this.object.isPerspectiveCamera ) {

			// this.firstMoveDecay();

			// perspective
			const position = this.object.position;
			_v.copy( position ).sub( this.target );
			let targetDistance = _v.length();

			// half of the fov is center to top of screen
			targetDistance *= Math.tan( ( this.object.fov / 2 ) * Math.PI / 180.0 );

			// we use only clientHeight here so aspect ratio does not distort speed
			this._panLeft( 2 * deltaX * targetDistance / element.clientHeight, this.object.matrix );
			this._panUp( 2 * deltaY * targetDistance / element.clientHeight, this.object.matrix );

		} else if ( this.object.isOrthographicCamera ) {

			// orthographic
			this._panLeft( deltaX * ( this.object.right - this.object.left ) / this.object.zoom / element.clientWidth, this.object.matrix );
			this._panUp( deltaY * ( this.object.top - this.object.bottom ) / this.object.zoom / element.clientHeight, this.object.matrix );

		} else {

			// camera neither orthographic nor perspective
			console.warn( 'WARNING: OrbitControls.js encountered an unknown camera type - pan disabled.' );
			this.enablePan = false;

		}

	}

	_dollyOut( dollyScale, damping = false, pinching = false ) {

		if ( this.object.isPerspectiveCamera || this.object.isOrthographicCamera ) {

			// this.firstMoveDecay();

			// this._scale /= dollyScale;
			// damping ? this._zoomDelta += do llyScale : this._scale /= dollyScale;
			if (pinching) {
				this.radiusDamper.setDecayConstant(this.interactiveDecayTimeDampers.radiusPinch);
				this._goalSpherical.radius = this._clampDistance(this._goalSpherical.radius / dollyScale)
			} else {
				this.radiusDamper.setDecayConstant(this.interactiveDecayTimeDampers.radius);
				this._goalSpherical.radius = this._clampDistance(this._goalSpherical.radius + dollyScale)
			}
			
			if (!damping) this._spherical.radius = this._goalSpherical.radius;

		} else {

			console.warn( 'WARNING: OrbitControls.js encountered an unknown camera type - dolly/zoom disabled.' );
			this.enableZoom = false;

		}

	}

	_dollyIn( dollyScale, damping = false, pinching = false  ) {

		if ( this.object.isPerspectiveCamera || this.object.isOrthographicCamera ) {

			// this.firstMoveDecay();

			if (pinching) {
				this.radiusDamper.setDecayConstant(this.interactiveDecayTimeDampers.radiusPinch);
				this._goalSpherical.radius = this._clampDistance(this._goalSpherical.radius * dollyScale)
			} else {
				this.radiusDamper.setDecayConstant(this.interactiveDecayTimeDampers.radius);
				this._goalSpherical.radius = this._clampDistance(this._goalSpherical.radius - dollyScale)
			}
			
			if (!damping) this._spherical.radius = this._goalSpherical.radius;

		} else {

			console.warn( 'WARNING: OrbitControls.js encountered an unknown camera type - dolly/zoom disabled.' );
			this.enableZoom = false;

		}

	}

	_updateZoomParameters( x, y ) {

		if ( ! this.zoomToCursor ) {

			return;

		}

		this._performCursorZoom = true;

		const rect = this.domElement.getBoundingClientRect();
		const dx = x - rect.left;
		const dy = y - rect.top;
		const w = rect.width;
		const h = rect.height;

		this._mouse.x = ( dx / w ) * 2 - 1;
		this._mouse.y = - ( dy / h ) * 2 + 1;

		this._dollyDirection.set( this._mouse.x, this._mouse.y, 1 ).unproject( this.object ).sub( this.object.position ).normalize();

	}

	_clampDistance( dist ) {

		return Math.max( this.minDistance, Math.min( this.maxDistance, dist ) );

	}

	//
	// event callbacks - update the object state
	//

	_handleMouseDownRotate( event ) {

		this._rotateStart.set( event.clientX, event.clientY );

	}

	_handleMouseDownDolly( event ) {

		this._updateZoomParameters( event.clientX, event.clientX );
		this._dollyStart.set( event.clientX, event.clientY );

	}

	_handleMouseDownPan( event ) {

		this._panStart.set( event.clientX, event.clientY );

	}

	_handleMouseMoveRotate( event ) {
		
		this._rotateEnd.set( event.clientX, event.clientY );

		this._rotateDelta.subVectors( this._rotateEnd, this._rotateStart ).multiplyScalar( this.rotateSpeed );

		const element = this.domElement;

		this._rotateLeft( _twoPI * this._rotateDelta.x / element.clientHeight ); // yes, height

		this._rotateUp( _twoPI * this._rotateDelta.y / element.clientHeight );

		this._rotateStart.copy( this._rotateEnd );


	}

	_handleMouseMoveDolly( event ) {

		this._dollyEnd.set( event.clientX, event.clientY );

		this._dollyDelta.subVectors( this._dollyEnd, this._dollyStart );

		if ( this._dollyDelta.y > 0 ) {

			this._dollyOut( this._getZoomScale( this._dollyDelta.y ), true );

		} else if ( this._dollyDelta.y < 0 ) {

			this._dollyIn( this._getZoomScale( this._dollyDelta.y ), true );

		}

		this._dollyStart.copy( this._dollyEnd );


	}

	_handleMouseMovePan( event ) {


		this._panEnd.set( event.clientX, event.clientY );

		this._panDelta.subVectors( this._panEnd, this._panStart ).multiplyScalar( this.panSpeed );

		this._pan( this._panDelta.x, this._panDelta.y );

		this._panStart.copy( this._panEnd );


	}

	_handleMouseWheel( event ) {

		this._updateZoomParameters( event.clientX, event.clientY );

		if ( event.deltaY < 0 ) {

         // this._zoomDelta += this._getZoomScale( event.deltaY )

			this._dollyIn( this._getZoomScale( event.deltaY ), true );

		} else if ( event.deltaY > 0 ) {

         // this._zoomDelta -= this._getZoomScale( event.deltaY )

			this._dollyOut( this._getZoomScale( event.deltaY ), true );

		}


	}

	_handleKeyDown( event ) {

		if ( this.enabled === false ) return;

		let needsUpdate = false;

		switch ( event.code ) {

			case this.keys.UP:

				if ( event.ctrlKey || event.metaKey || event.shiftKey ) {

					if ( this.enableRotate ) {

						this._rotateUp( _twoPI * this.keyRotateSpeed / this.domElement.clientHeight );

					}

				} else {

					if ( this.enablePan ) {

						this._pan( 0, this.keyPanSpeed );

					}

				}

				needsUpdate = true;
				break;

			case this.keys.BOTTOM:

				if ( event.ctrlKey || event.metaKey || event.shiftKey ) {

					if ( this.enableRotate ) {

						this._rotateUp( - _twoPI * this.keyRotateSpeed / this.domElement.clientHeight );

					}

				} else {

					if ( this.enablePan ) {

						this._pan( 0, - this.keyPanSpeed );

					}

				}

				needsUpdate = true;
				break;

			case this.keys.LEFT:

				if ( event.ctrlKey || event.metaKey || event.shiftKey ) {

					if ( this.enableRotate ) {

						this._rotateLeft( _twoPI * this.keyRotateSpeed / this.domElement.clientHeight );

					}

				} else {

					if ( this.enablePan ) {

						this._pan( this.keyPanSpeed, 0 );

					}

				}

				needsUpdate = true;
				break;

			case this.keys.RIGHT:

				if ( event.ctrlKey || event.metaKey || event.shiftKey ) {

					if ( this.enableRotate ) {

						this._rotateLeft( - _twoPI * this.keyRotateSpeed / this.domElement.clientHeight );

					}

				} else {

					if ( this.enablePan ) {

						this._pan( - this.keyPanSpeed, 0 );

					}

				}

				needsUpdate = true;
				break;

		}

		if ( needsUpdate ) {

			// prevent the browser from scrolling on cursor keys
			event.preventDefault();


		}


	}

	_handleTouchStartRotate( event ) {

		if ( this._pointers.length === 1 ) {

			this._rotateStart.set( event.pageX, event.pageY );

		} else {

			const position = this._getSecondPointerPosition( event );

			const x = 0.5 * ( event.pageX + position.x );
			const y = 0.5 * ( event.pageY + position.y );

			this._rotateStart.set( x, y );

		}

	}

	_handleTouchStartPan( event ) {

		if ( this._pointers.length === 1 ) {

			this._panStart.set( event.pageX, event.pageY );

		} else {

			const position = this._getSecondPointerPosition( event );

			const x = 0.5 * ( event.pageX + position.x );
			const y = 0.5 * ( event.pageY + position.y );

			this._panStart.set( x, y );

		}

	}

	_handleTouchStartDolly( event ) {

		const position = this._getSecondPointerPosition( event );

		const dx = event.pageX - position.x;
		const dy = event.pageY - position.y;

		const distance = Math.sqrt( dx * dx + dy * dy );

		this._dollyStart.set( 0, distance );

	}

	_handleTouchStartDollyPan( event ) {

		if ( this.enableZoom ) this._handleTouchStartDolly( event );

		if ( this.enablePan ) this._handleTouchStartPan( event );

	}

	_handleTouchStartDollyRotate( event ) {

		if ( this.enableZoom ) this._handleTouchStartDolly( event );

		if ( this.enableRotate ) this._handleTouchStartRotate( event );

	}

	_handleTouchMoveRotate( event ) {

		if ( this._pointers.length == 1 ) {

			this._rotateEnd.set( event.pageX, event.pageY );

		} else {

			const position = this._getSecondPointerPosition( event );

			const x = 0.5 * ( event.pageX + position.x );
			const y = 0.5 * ( event.pageY + position.y );

			this._rotateEnd.set( x, y );

		}

		this._rotateDelta.subVectors( this._rotateEnd, this._rotateStart ).multiplyScalar( this.rotateSpeed );

		const element = this.domElement;

		this._rotateLeft( _twoPI * this._rotateDelta.x / element.clientHeight ); // yes, height

		this._rotateUp( _twoPI * this._rotateDelta.y / element.clientHeight );

		this._rotateStart.copy( this._rotateEnd );

	}

	_handleTouchMovePan( event ) {

		if ( this._pointers.length === 1 ) {

			this._panEnd.set( event.pageX, event.pageY );

		} else {

			const position = this._getSecondPointerPosition( event );

			const x = 0.5 * ( event.pageX + position.x );
			const y = 0.5 * ( event.pageY + position.y );

			this._panEnd.set( x, y );

		}

		this._panDelta.subVectors( this._panEnd, this._panStart ).multiplyScalar( this.panSpeed );

		this._pan( this._panDelta.x, this._panDelta.y );

		this._panStart.copy( this._panEnd );

	}

	
	_handleTouchMoveDolly( event ) {

		const position = this._getSecondPointerPosition( event );

		const dx = event.pageX - position.x;
		const dy = event.pageY - position.y;

		const distance = Math.sqrt( dx * dx + dy * dy );

		this._dollyEnd.set( 0, distance );
		this._dollyDelta.set( 0, Math.pow( this._dollyEnd.y / this._dollyStart.y, this.pinchToZoomSpeed ) );

		this._dollyOut( this._dollyDelta.y, false, true );

		this._dollyStart.copy( this._dollyEnd );

		const centerX = ( event.pageX + position.x ) * 0.5;
		const centerY = ( event.pageY + position.y ) * 0.5;

		this._updateZoomParameters( centerX, centerY );

	}

	_handleTouchMoveDollyPan( event ) {

		if ( this.enableZoom ) this._handleTouchMoveDolly( event );

		if ( this.enablePan ) this._handleTouchMovePan( event );

	}

	_handleTouchMoveDollyRotate( event ) {

		if ( this.enableZoom ) this._handleTouchMoveDolly( event );

		if ( this.enableRotate ) this._handleTouchMoveRotate( event );

	}

	// pointers

	_addPointer( event ) {

		this._pointers.push( event.pointerId );

	}

	_removePointer( event ) {

		delete this._pointerPositions[ event.pointerId ];

		for ( let i = 0; i < this._pointers.length; i ++ ) {

			if ( this._pointers[ i ] == event.pointerId ) {

				this._pointers.splice( i, 1 );
				return;

			}

		}

	}

	_isTrackingPointer( event ) {

		for ( let i = 0; i < this._pointers.length; i ++ ) {

			if ( this._pointers[ i ] == event.pointerId ) return true;

		}

		return false;

	}

	_trackPointer( event ) {

		let position = this._pointerPositions[ event.pointerId ];

		if ( position === undefined ) {

			position = new Vector2();
			this._pointerPositions[ event.pointerId ] = position;

		}

		position.set( event.pageX, event.pageY );

	}

	_getSecondPointerPosition( event ) {

		const pointerId = ( event.pointerId === this._pointers[ 0 ] ) ? this._pointers[ 1 ] : this._pointers[ 0 ];

		return this._pointerPositions[ pointerId ];

	}

	//

	_customWheelEvent( event ) {

		const mode = event.deltaMode;

		// minimal wheel event altered to meet delta-zoom demand
		const newEvent = {
			clientX: event.clientX,
			clientY: event.clientY,
			deltaY: event.deltaY,
		};

		newEvent.deltaY *= mode == 1 ? 18 : 1

		// detect if event was triggered by pinching
		if ( event.ctrlKey && ! this._controlActive ) {

			newEvent.deltaY *= 10;

		}

		return newEvent;

	}

}

function onPointerDown( event ) {


	if ( this.enabled === false ) return;

	if ( this._pointers.length === 0 ) {

		this.domElement.setPointerCapture( event.pointerId );

		this.domElement.addEventListener( 'pointermove', this._onPointerMove );
		this.domElement.addEventListener( 'pointerup', this._onPointerUp );

	}

	//

	if ( this._isTrackingPointer( event ) ) return;

	//

	this._addPointer( event );

	if ( event.pointerType === 'touch' ) {

		this._onTouchStart( event );

	} else {

		this._onMouseDown( event );

	}

}

function onPointerMove( event ) {

	if ( this.enabled === false ) return;

	if ( event.pointerType === 'touch' ) {

		this._onTouchMove( event );

	} else {

		this._onMouseMove( event );

	}

}

function onPointerUp( event ) {

	this._removePointer( event );

	switch ( this._pointers.length ) {

		case 0:

			this.domElement.releasePointerCapture( event.pointerId );

			this.domElement.removeEventListener( 'pointermove', this._onPointerMove );
			this.domElement.removeEventListener( 'pointerup', this._onPointerUp );

			this.dispatchEvent( _endEvent );

			this.state = _STATE.NONE;

			break;

		case 1:

			const pointerId = this._pointers[ 0 ];
			const position = this._pointerPositions[ pointerId ];

			// minimal placeholder event - allows state correction on pointer-up
			this._onTouchStart( { pointerId: pointerId, pageX: position.x, pageY: position.y } );

			break;

	}

}

function onMouseDown( event ) {

	let mouseAction;

	switch ( event.button ) {

		case 0:

			mouseAction = this.mouseButtons.LEFT;
			break;

		case 1:

			mouseAction = this.mouseButtons.MIDDLE;
			break;

		case 2:

			mouseAction = this.mouseButtons.RIGHT;
			break;

		default:

			mouseAction = - 1;

	}

	switch ( mouseAction ) {

		case MOUSE.DOLLY:

			if ( this.enableZoom === false ) return;

			this._handleMouseDownDolly( event );

			this.state = _STATE.DOLLY;

			break;

		case MOUSE.ROTATE:

			if ( event.ctrlKey || event.metaKey || event.shiftKey ) {

				if ( this.enablePan === false ) return;

				this._handleMouseDownPan( event );

				this.state = _STATE.PAN;

			} else {

				if ( this.enableRotate === false ) return;

				this._handleMouseDownRotate( event );

				this.state = _STATE.ROTATE;

			}

			break;

		case MOUSE.PAN:

			if ( event.ctrlKey || event.metaKey || event.shiftKey ) {

				if ( this.enableRotate === false ) return;

				this._handleMouseDownRotate( event );

				this.state = _STATE.ROTATE;

			} else {

				if ( this.enablePan === false ) return;

				this._handleMouseDownPan( event );

				this.state = _STATE.PAN;

			}

			break;

		default:

			this.state = _STATE.NONE;

	}

	if ( this.state !== _STATE.NONE ) {

		this.dispatchEvent( _startEvent );

	}

}

function onMouseMove( event ) {

	switch ( this.state ) {

		case _STATE.ROTATE:

			if ( this.enableRotate === false ) return;

			this._handleMouseMoveRotate( event );

			break;

		case _STATE.DOLLY:

			if ( this.enableZoom === false ) return;

			this._handleMouseMoveDolly( event );

			break;

		case _STATE.PAN:

			if ( this.enablePan === false ) return;

			this._handleMouseMovePan( event );

			break;

	}

}

function onMouseWheel( event ) {

	if ( this.enabled === false || this.enableZoom === false || this.state !== _STATE.NONE ) return;

	event.preventDefault();

	this.dispatchEvent( _startEvent );

	this._handleMouseWheel( this._customWheelEvent( event ) );

	this.dispatchEvent( _endEvent );

}

function onKeyDown( event ) {

	if ( this.enabled === false ) return;

	this._handleKeyDown( event );

}

function onTouchStart( event ) {

	this._trackPointer( event );

	switch ( this._pointers.length ) {

		case 1:

			switch ( this.touches.ONE ) {

				case TOUCH.ROTATE:

					if ( this.enableRotate === false ) return;

					this._handleTouchStartRotate( event );

					this.state = _STATE.TOUCH_ROTATE;

					break;

				case TOUCH.PAN:

					if ( this.enablePan === false ) return;

					this._handleTouchStartPan( event );

					this.state = _STATE.TOUCH_PAN;

					break;

				default:

					this.state = _STATE.NONE;

			}

			break;

		case 2:

			switch ( this.touches.TWO ) {

				case TOUCH.DOLLY_PAN:

					if ( this.enableZoom === false && this.enablePan === false ) return;

					this._handleTouchStartDollyPan( event );

					this.state = _STATE.TOUCH_DOLLY_PAN;

					break;

				case TOUCH.DOLLY_ROTATE:

					if ( this.enableZoom === false && this.enableRotate === false ) return;

					this._handleTouchStartDollyRotate( event );

					this.state = _STATE.TOUCH_DOLLY_ROTATE;

					break;

				default:

					this.state = _STATE.NONE;

			}

			break;

		default:

			this.state = _STATE.NONE;

	}

	if ( this.state !== _STATE.NONE ) {

		this.dispatchEvent( _startEvent );

	}

}

function onTouchMove( event ) {

	this._trackPointer( event );

	switch ( this.state ) {

		case _STATE.TOUCH_ROTATE:

			if ( this.enableRotate === false ) return;

			this._handleTouchMoveRotate( event );


			break;

		case _STATE.TOUCH_PAN:

			if ( this.enablePan === false ) return;

			this._handleTouchMovePan( event );


			break;

		case _STATE.TOUCH_DOLLY_PAN:

			if ( this.enableZoom === false && this.enablePan === false ) return;

			this._handleTouchMoveDollyPan( event );


			break;

		case _STATE.TOUCH_DOLLY_ROTATE:

			if ( this.enableZoom === false && this.enableRotate === false ) return;

			this._handleTouchMoveDollyRotate( event );


			break;

		default:

			this.state = _STATE.NONE;

	}

}

function onContextMenu( event ) {

	if ( this.enabled === false ) return;

	event.preventDefault();

}

function interceptControlDown( event ) {

	if ( event.key === 'Control' ) {

		this._controlActive = true;

		const document = this.domElement.getRootNode(); // offscreen canvas compatibility

		document.addEventListener( 'keyup', this._interceptControlUp, { passive: true, capture: true } );

	}

}

function interceptControlUp( event ) {

	if ( event.key === 'Control' ) {

		this._controlActive = false;

		const document = this.domElement.getRootNode(); // offscreen canvas compatibility

		document.removeEventListener( 'keyup', this._interceptControlUp, { passive: true, capture: true } );

	}

}

export { OrbitControls };