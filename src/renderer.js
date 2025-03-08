import * as THREE from "three"
import { OrbitControls } from "./OrbitControls.js"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { HDRJPGLoader } from "@monogrid/gainmap-js"
import { DitheringEffect } from "./postprocessing/DitheringEffect.js"
import envmapSpecularAntialias from "./shaders/envmap_physical_pars_fragment_specular_antialias.glsl?raw"
import lightsFragmentMapsSpecularAntialias from "./shaders/lights_fragment_maps_specular_antialias.glsl?raw"
import { BloomEffect, RenderPipeline, ClearPass, GeometryPass, EffectPass, ToneMappingEffect, ToneMapping } from "postprocessing"
// import HDRIMAP from "./envmaps/old_bus_depot_4k_blur.jpg?url"
import { easeOutQuart, easeInCubic, easeOutCubic } from "js-easing-functions"

class ThreeSceneManager {
	constructor(data) {
		this.canvas = data.canvas
		this.inputElement = data.inputElement
		this.modelUrl = data.modelUrl
		// this.modelUrl = artworkModelUrl;
		this.envmapUrl = data.envmapUrl
		// this.envmapUrl = HDRIMAP;
		this.lowPerformanceSettings = {
			disableAA: data.lowPerformanceSettings?.disableAA ?? false,
			lowResolution: data.lowPerformanceSettings?.lowResolution ?? false,
		}
		this.baseLoadPixelRatio = data.pixelRatio ?? window.devicePixelRatio
		this.initialRenderPixelRatio = this.lowPerformanceSettings.lowResolution ? data.pixelRatio / 2 : this.baseLoadPixelRatio
		this.performantRenderPixelRatio = null
		// this.msaaSamples = this.lowPerformanceSettings.disableAA ? 0 : 4;
		// this.msaaSamples = this.lowPerformanceSettings.disableAA ? 0 : 0;
		this.msaaSamples = this.lowPerformanceSettings.disableAA ? 0 : 2;

		this.pixelRatioVariation = 1 // this to handle screen DPI changes

		this.scene = null
		this.camera = null
	
		this.baseCameraSettings = {
			targetDistance: data.targetDistance || 1.0,
			maxDistance: data.targetDistance / 0.9 || Infinity,
			minDistance: data.minDistance || 0,
			multiplier: this.cameraMultiplier(this.inputElement.clientHeight / this.inputElement.clientWidth) || 1
		}

		this.perfSampling = {
			stabilizationDuration: data.perfSampling.stabilityDuration || 1.0, // Warm-up period in seconds
			measureDuration: data.perfSampling.measureDuration || 0.5, // Active measurement window in seconds
		}

		this.renderer = null
		this.pipeline = null
		this.controls = null
		this.model = null
		this.mixer = null
		this.pickHelper = null
		this.lastResizeTime = 0
		this.throttleResize = 150 // miliseconds

		this.rotationModelParams = {
			easeFunc: easeInCubic,
			duration: 1.5, // Seconds to reach max speed
			maxSpeed: Math.PI / 3, // Radians per second
			startTime: null,
			currentSpeed: 0,
		}

		this.initialModelRotation = null

		this.initDelay = data.initDelay || 0.0;
		this.initDelayInteractive = data.initDelayInteractive || 0.0;

		this.returnModelAnimation = {
			easeFunc: easeOutQuart,
			isActive: false,
			startQuaternion: null,
			targetQuaternion: null,
			startTime: 0,
			duration: 1.5, // Seconds for the return animation
		}

		this.decelerationAnimation = {
			easeFunc: easeOutCubic,
			isActive: false,
			startQuaternion: null,
			targetQuaternion: null,
			startTime: 0,
			duration: 1.0, // Adjust duration as needed
		};

		this.interactionState = {
			startX: 0,
			startY: 0,
			startTime: 0,
			isDragging: false,
			isTouchOrLeftClick: false,
			dragThreshold: 3, // pixels of movement to consider a drag, lower to avoid keen-slider trigger
			clickTimeThreshold: 300, // max milliseconds for a click
		}

		this.isInteractive = false
		this.lastInteractiveToggleTime = 0
		this.throttleInteractiveToggle = 150
		
		this.e_interactivityChange = data.e_interactivityChange || (() => {})
		this.e_ready = data.e_ready || (() => {})
		this.e_loaded = data.e_loaded || (() => {})

		this.clock = new THREE.Clock()

		this.startupMode = data.startup || "auto";
		this.isReady = false; // Assets loaded?
		this.shouldStart = this.startupMode === "auto"; // Should start rendering? By default yes
		this.hasStarted = false; // Has rendering started?
		this.isRendering = false;

		this.hasAborted = false
		this.initScene()
	}

	// preserves the model in view completely at vertical aspect ratios
	cameraMultiplier(ratio) { 
		return (ratio) <= 1 ? 1.0 : 1.0 + 0.2 * (ratio - 1)  }

	initScene() {
		this.setupRenderer()
		this.setupCamera()
		this.setupControls()
		this.setupScene()
		// this.setupLighting();

		Promise.all([this.setupPostProcessing(), this.loadAssets()])
			.then(() => {
				this.isReady = true;
				this.e_ready(true);
				if ((this.startupMode === "auto") || (this.shouldStart && !this.hasStarted)) {
					this.startPerformanceSamplingLoop();
					this.hasStarted = true;
				}
			})
			.catch((error) => {
				this.abortLoading(error);
			});
	}

	enableRendering() {
		this.shouldStart = true;
		if (this.isReady && !this.hasStarted) {
		  this.startPerformanceSamplingLoop();
		  this.hasStarted = true;
		}
	 }
  
	 disableRendering() {
		this.shouldStart = false;
	 }

	setupRenderer() {
		this.renderer = new THREE.WebGLRenderer({
			powerPreference: "high-performance",
			antialias: false,
			canvas: this.canvas,
			stencil: false,
			depth: false,
		})

		this.renderer.setPixelRatio(this.initialRenderPixelRatio)
		this.renderer.toneMappingExposure = 1.6
	}

	setupCamera() {
		this.camera = new THREE.PerspectiveCamera(50, 2, 0.03, 100)
		console.log(this.baseCameraSettings.multiplier)
		this.camera.position.z = this.baseCameraSettings.targetDistance * this.baseCameraSettings.multiplier
		// this.camera.rotation.y = Math.PI * 0.5;
	}

	setupControls() {
		this.controls = new OrbitControls(this.camera, this.inputElement)
		this.controls.enabled = false
		this.controls.enableDamping = true
		this.controls.target.set(0, 0, 0)
		this.controls.maxDistance = this.baseCameraSettings.maxDistance * this.baseCameraSettings.multiplier
		this.controls.minDistance = this.baseCameraSettings.minDistance * this.baseCameraSettings.multiplier
		this.controls.maxTargetRadius = 0.3;
		this.controls.update()
	}

	setupScene() {
		this.scene = new THREE.Scene()
		this.scene.background = new THREE.Color(0x000000)
		// this.scene.background = new THREE.Color(0xFFFFFF);
	}

	setupLighting() {
		const light = new THREE.DirectionalLight(0xffffff, 10)
		light.position.set(0, 0, 5)
		this.scene.add(light)
	}

	setupPostProcessing() {
		return new Promise((resolve, reject) => {
			this.pipeline = new RenderPipeline(this.renderer)
			this.pipeline.add(new ClearPass())
			this.pipeline.add(
				new GeometryPass(this.scene, this.camera, {
					frameBufferType: THREE.HalfFloatType,
					// frameBufferType: THREE.UnsignedByteType,
					samples: this.msaaSamples,
				})
			)
			const effects = new EffectPass(
				// new SMAAEffect(),
				// new FXAAEffect({
				// 	minEdgeThreshold: 0.012,
				// 	maxEdgeThreshold: 0.325,
				// 	subpixelQuality: 1.0,
				// 	samples: 12,
				// }),
				new BloomEffect({
					luminanceSmoothing: 0.4,
					intensity: 0.3,
					radius: 1,
					luminanceThreshold: 0.1,
					levels: 8,
				}),
				new ToneMappingEffect({
					toneMapping: ToneMapping.REINHARD,
				}),
				 new DitheringEffect()
			)
			this.pipeline.add(effects)

			this.pipeline
				.compile()
				.then(() => resolve())
				.catch((error) => reject("Failed to compile postprocessing pipeline: " + error))
		})
	}

	resetPostProcessing() {
		this.pipeline.dispose()
		this.pipeline = null
		this.setupPostProcessing()
		// this.handleResize(true);
		// ↑ unnecesary, the main render loop already does it.
		// plus, it makes the screen flash
	}

	setupInteraction() {
		this.inputElement.addEventListener("contextmenu", (e) => e.preventDefault())

		// Mouse events
		this.inputElement.addEventListener("mousedown", this.handleInputStart.bind(this))
		this.inputElement.addEventListener("mousemove", this.handleInputMove.bind(this))
		this.inputElement.addEventListener("mouseup", this.handleInputEnd.bind(this))

		// Touch events
		this.inputElement.addEventListener("touchstart", this.handleInputStart.bind(this))
		this.inputElement.addEventListener("touchmove", this.handleInputMove.bind(this))
		this.inputElement.addEventListener("touchend", this.handleInputEnd.bind(this))
	}

	handleInputStart(event) {
		// Prevent default for touch events and when it is intereactive to avoid scrolling
		if (event.type === "touchstart" && this.isInteractive) event.preventDefault()

		let pos
		let isTouchOrLeftClick = false

		// Get position and type of click
		if (event.type.startsWith("touch")) {
			pos = {
				x: event.touches[0].clientX,
				y: event.touches[0].clientY,
			}
			isTouchOrLeftClick = true
		} else {
			pos = {
				x: event.clientX,
				y: event.clientY,
			}
			if (event.button === 0) isTouchOrLeftClick = true
		}

		// Store starting position and time
		this.interactionState.startX = pos.x
		this.interactionState.startY = pos.y
		this.interactionState.startTime = performance.now()
		this.interactionState.isTouchOrLeftClick = isTouchOrLeftClick
		this.interactionState.isDragging = false
	}

	handleInputMove(event) {
		// If we're not tracking an interaction, exit
		if (this.interactionState.startTime === 0) return

		// Get current position
		const pos = event.type.startsWith("touch")
			? { x: event.touches[0].clientX, y: event.touches[0].clientY }
			: { x: event.clientX, y: event.clientY }

		// Calculate distance moved
		const dx = pos.x - this.interactionState.startX
		const dy = pos.y - this.interactionState.startY
		const distance = Math.sqrt(dx * dx + dy * dy)

		// If we've moved beyond threshold, mark as dragging
		if (distance > this.interactionState.dragThreshold) {
			this.interactionState.isDragging = true
		}
	}

	handleInputEnd() {
		// Calculate how long the interaction lasted
		const duration = performance.now() - this.interactionState.startTime

		// If it was a short click/touch + not a drag + touch or left click, trigger
		if (
			duration < this.interactionState.clickTimeThreshold &&
			!this.interactionState.isDragging &&
			this.interactionState.isTouchOrLeftClick
		) {
			this.toggleInteractiveMode()
		}

		// Reset tracking state
		this.interactionState.startTime = 0
		this.interactionState.isDragging = false
	}

	toggleInteractiveMode() {
		if (!this.canInteract()) return
		const now = performance.now()
		const cameraRotationDecay = this.controls.getMaxApproximateRotationDecayTimerMS() / 1000
		// Only toggle if 500ms have passed since the last toggle
		if (now - this.lastInteractiveToggleTime < this.throttleInteractiveToggle) {
			return
		}
		this.lastInteractiveToggleTime = now

		this.isInteractive = !this.isInteractive
		this.e_interactivityChange(this.isInteractive)

		if (this.isInteractive) {
			this.controls.enabled = true;
			this.controls.stopCameraSmooth();
			this.controls._goalSpherical.radius = this.baseCameraSettings.targetDistance * this.baseCameraSettings.multiplier * 0.9;
			this.startReturnModelAnimation();
		} else {
			// Exiting interactive mode: partial deceleration
			this.controls.enabled = false;

			if (this.returnModelAnimation.isActive) {
				// Start deceleration to 20% towards initial from current position
				this.decelerationAnimation.startQuaternion = this.model.quaternion.clone();
				this.decelerationAnimation.targetQuaternion = this.model.quaternion.clone().slerp(
					this.initialModelRotation, // Target 20% closer to initial
					0.5 // Adjust this value (0.2 = 20% towards initial)
				);
				this.decelerationAnimation.startTime = this.clock.getElapsedTime();
				this.decelerationAnimation.isActive = true;
			}

			this.returnModelAnimation.isActive = false;

			// Delay auto-rotation until after deceleration
			const delay = Math.pow(Math.max(cameraRotationDecay - 0.55, 0), 0.3);
			const decelerationDelay = this.decelerationAnimation.isActive ? this.decelerationAnimation.duration - 0.4 : 0;
			this.rotationModelParams.startTime = this.clock.getElapsedTime() + delay + decelerationDelay;

			this.controls.returnToInit();
		}
	}

	startReturnModelAnimation() {
		if (!this.model || !this.initialModelRotation) return
		if (this.model.quaternion.equals(this.initialModelRotation)) return

		this.returnModelAnimation.isActive = true
		this.returnModelAnimation.startQuaternion = this.model.quaternion.clone()
		this.returnModelAnimation.targetQuaternion = this.initialModelRotation.clone()
		this.returnModelAnimation.startTime = this.clock.getElapsedTime()
	}

	abortLoading(error) {
		console.error("Aborting scene loading:", error)
		this.hasAborted = true
		// Optionally: hide the canvas, show an error message, etc.
		// this.canvas.style.display = "none";
	}

	loadAssets() {
		return Promise.all([this.loadArtworkModel(), this.loadHDREnvironment()])
	}

	loadArtworkModel() {
		return new Promise((resolve, reject) => {
			const loader = new GLTFLoader()
			loader.load(
				this.modelUrl,
				async (gltf) => {
					if (this.hasAborted) return
					this.model = gltf.scene
					// model.rotation.y -= 0.6;
					// model.rotation.x += 0.25;
					// model.rotation.z -= 0.4;
					this.model.scale.set(1, 1, 1)
					this.initialModelRotation = this.model.quaternion.clone()

				this.model.traverse((child) => {
					if (child.material) {
						child.material.needsUpdate = true
						child.material.onBeforeCompile = (shader) => {
							// shader.vertexShader = ModShader2;
							// shader.fragmentShader = ModShader;
							shader.fragmentShader = shader.fragmentShader
								.replace(
									"#include <envmap_physical_pars_fragment>",
									envmapSpecularAntialias
								)
								.replace(
									"#include <lights_fragment_maps>",
									lightsFragmentMapsSpecularAntialias
								)
						};
					}
				});

					this.optimizeModelTextures(this.model)

					await this.renderer.compileAsync(this.model, this.camera, this.scene)

					// this.mixer = new THREE.AnimationMixer(this.model)
					// const action = this.mixer.clipAction(gltf.animations[0])
					// action.play();

					this.scene.add(this.model)
					resolve()
				},
				undefined,
				(error) => {
					reject("Failed to load artwork model: " + error)
				}
			)
		})
	}

	optimizeModelTextures(model) {
		model.traverse((child) => {
			if (child.isMesh) {
				//  child.receiveShadow = true;
				this.applyTextureOptimization(child.material.map)
				this.applyTextureOptimization(child.material.normalMap)
				this.applyTextureOptimization(child.material.roughnessMap)
				this.applyTextureOptimization(child.material.metalnessMap)
			}
		})
	}

	applyTextureOptimization(texture) {
		if (texture) {
			texture.minFilter = THREE.LinearMipmapLinearFilter
			texture.magFilter = THREE.LinearFilter
			texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy()
			texture.generateMipmaps = true
		}
	}

	loadHDREnvironment() {
		return new Promise((resolve, reject) => {
			const loader = new HDRJPGLoader(this.renderer)
			loader.load(
				this.envmapUrl,
				(hdri) => {
					const hdrTexture = hdri.renderTarget.texture
					this.configureHDRTexture(hdrTexture)
					// this.scene.backgroundBlurriness = 0.8;
					this.scene.environment = hdrTexture
					// this.scene.environmentRotation = new THREE.Euler(0.0, -2.37, 0.0);
					// this.scene.environmentRotation = new THREE.Euler(-5.045, -2.37, 1.0);

					// this.scene.background = hdrTexture

					// this.scene.backgroundIntensity = 0.4;

					// Create cube render target

					hdri.dispose()
					resolve()
				},
				undefined,
				(error) => {
					reject("Failed to load HDR environment: " + error)
				}
			)
		})
	}

	configureHDRTexture(texture) {
		texture.mapping = THREE.EquirectangularReflectionMapping
		texture.type = THREE.HalfFloatType
		texture.minFilter = THREE.LinearMipmapLinearFilter
		texture.magFilter = THREE.LinearFilter
		texture.generateMipmaps = true
		texture.needsUpdate = true
	}

	startPerformanceSamplingLoop() {
		const stabilizationTime = this.perfSampling.stabilizationDuration
		const measureDuration = this.perfSampling.measureDuration

		let frameCount = 0
		let isMeasuring = false

		const applyQualitySettings = (fps) => {
			console.log(`Applying quality settings for FPS: ${fps.toFixed(1)}`)

			// Disable MSAA if FPS is low
			// if (fps < 55 && this.msaaSamples > 0) {
				// this.msaaSamples = 0
				// this.resetPostProcessing()
			// }

			// Adjust render resolution
			if (fps < 54) {
				const targetFPS = 75
				const fpsRatio = Math.min(fps / targetFPS, 1)
				const potentialPixelRatio = Math.sqrt(this.initialRenderPixelRatio ** 2.0 * fpsRatio)

				this.performantRenderPixelRatio = Math.max(0.8, Math.min(potentialPixelRatio, this.initialRenderPixelRatio))
			}
		}

		const measureFrame = () => {
			// Capture current time first for consistent
			// performance.now() gives a better perceived
			// FPS timing than rAF which might be off-sync sometimes

			// Update scene with current time
			if (!this.isRendering) return;
			this.handleResize()
			this.updateScene()
			this.pipeline.render()
			// this.renderer.render(this.scene, this.camera);

			// Warm-up phase
			if (!isMeasuring && this.clock.getElapsedTime() < stabilizationTime) {
				requestAnimationFrame(measureFrame)
				return
			}

			// Start measurement
			if (!isMeasuring) {
				isMeasuring = true
				frameCount = 0
			}
			
			frameCount++
			
			const elapsed = this.clock.getElapsedTime() - stabilizationTime
			if (elapsed >= measureDuration) {
				const actualFPS = frameCount / elapsed
				console.log(`Measured FPS: ${actualFPS.toFixed(1)}`)
				applyQualitySettings(actualFPS)
				this.startRenderLoop()
			} else {
				requestAnimationFrame(measureFrame)
			}
		}

		// Set timer to start counting the animation from there
		this.clock.start()
		this.setupInteraction()
		this.e_loaded(true)
		this.isRendering = true
		setTimeout(() => // signal to change cursor in main.ts
			this.e_interactivityChange(this.isInteractive), 
			this.initDelayInteractive * 1000
		)
		requestAnimationFrame(measureFrame)
	}

	startRenderLoop() {
		// this.clock.start()
		// this.setupInteraction()
		// this.e_loaded(true)
		// setTimeout(() => // signal to change cursor in main.ts
		// 	this.e_interactivityChange(this.isInteractive), 
		// 	this.initDelayInteractive * 1000
		// )
		const render = () => {
			if (!this.isRendering) return;
			this.handleResize()
			this.updateScene()
			this.pipeline.render()
			// this.renderer.render(this.scene, this.camera);
			requestAnimationFrame(render)
		}
		requestAnimationFrame(render)
	}

	getWorkingPixelRatio() {
		if (this.performantRenderPixelRatio) {
			return this.performantRenderPixelRatio * this.pixelRatioVariation
		}
		if (this.initialRenderPixelRatio) {
			return this.initialRenderPixelRatio * this.pixelRatioVariation
		}
		return window.devicePixelRatio
	}

	handleResize(forceResize = false) {
		if (!this.renderer) return; // Exit early if renderer is disposed
		
		const { clientWidth: width, clientHeight: height, pixelRatio } = this.inputElement;
		this.pixelRatioVariation = (pixelRatio / this.baseLoadPixelRatio) || 1;
		const workingPixelRatio = this.getWorkingPixelRatio();
		const now = performance.now();

		if (forceResize || this.needsResize(now, width, height, workingPixelRatio)) {
			 this.updateRendererSize(width, height, workingPixelRatio);
			 this.lastResizeTime = now;
			 this.camera.aspect = width / height;
			 this.camera.updateProjectionMatrix();

			 // Calculate multiplier based on height-to-width ratio
			 const ratio = height / width;
			 this.baseCameraSettings.multiplier = this.cameraMultiplier(ratio);

			//  console.log(this.baseCameraSettings.multiplier)
			//  this.controls._goalSpherical.radius = this.controls._goalSpherical.radius * this.baseCameraSettings.multiplier;
			this.camera.position.z = this.baseCameraSettings.targetDistance * this.baseCameraSettings.multiplier;
			 this.controls.maxDistance = this.baseCameraSettings.maxDistance * this.baseCameraSettings.multiplier;
			 this.controls.minDistance = this.baseCameraSettings.minDistance * this.baseCameraSettings.multiplier;
		}
  }

	needsResize(now, width, height, workingPixelRatio) {
		if (now - this.lastResizeTime < this.throttleResize) return false

		const canvas = this.renderer.domElement
		return (
			canvas.width !== Math.floor(width * workingPixelRatio) ||
			canvas.height !== Math.floor(height * workingPixelRatio) ||
			workingPixelRatio !== this.renderer.getPixelRatio()
		)
	}

	updateRendererSize(width, height, workingPixelRatio) {
		this.renderer.setPixelRatio(workingPixelRatio || 1)
		this.renderer.setSize(width, height, false)
		this.pipeline.setSize(width, height, false)
		this.pipeline.setPixelRatio(this.renderer.getPixelRatio())
		// this.pipeline.setPixelRatio(2.0);
		// this.pipeline.setSize
	}

	canAnimate() {
		return (this.clock.elapsedTime - this.initDelay >= 0)
	}

	canInteract() {
		return (this.clock.elapsedTime - this.initDelayInteractive >= 0)
	}

	updateScene() {
		const dt = this.clock.getDelta()
		// Optionally: console.log(dt);
		if (this.model && this.canAnimate()) {
			if (this.isInteractive) {
				if (this.returnModelAnimation.isActive) {
					this.updateReturnModelAnimation();
				}
			} else {
				if (this.decelerationAnimation.isActive) {
					this.updateDecelerationAnimation();
				} else {
					this.autoRotateModel(dt);
				}
			}
		}
		// if (this.mixer) this.mixer.update(dt)
		// if (this.isInteractive) this.controls.update(dt);
		this.controls.update(dt)
	}

	updateDecelerationAnimation() {
		const elapsed = this.clock.getElapsedTime() - this.decelerationAnimation.startTime;
		const t = Math.min(elapsed, this.decelerationAnimation.duration);
		const easedT = this.decelerationAnimation.easeFunc(t, 0, 1, this.decelerationAnimation.duration);

		this.model.quaternion.copy(
			this.decelerationAnimation.startQuaternion.clone().slerp(this.decelerationAnimation.targetQuaternion, easedT)
		);

		if (t >= this.decelerationAnimation.duration) {
			this.decelerationAnimation.isActive = false;
		}
	}


	updateReturnModelAnimation() {
		const elapsed = this.clock.getElapsedTime() - this.returnModelAnimation.startTime
		const t = Math.min(elapsed, this.returnModelAnimation.duration)
		const easedT = this.returnModelAnimation.easeFunc(t, 0, 1, this.returnModelAnimation.duration)

		// Directly copy and slerp in one step:
		this.model.quaternion.copy(
			this.returnModelAnimation.startQuaternion.clone().slerp(this.returnModelAnimation.targetQuaternion, easedT)
		)

		if (t >= this.returnModelAnimation.duration) this.returnModelAnimation.isActive = false
	}

	autoRotateModel(dt) {
		if (!this.rotationModelParams.startTime) {
			this.rotationModelParams.startTime = this.clock.getElapsedTime()
		}

		if (this.clock.getElapsedTime() < this.rotationModelParams.startTime) return

		const t = Math.min(this.clock.getElapsedTime() - this.rotationModelParams.startTime, this.rotationModelParams.duration)
		this.rotationModelParams.currentSpeed =
			this.rotationModelParams.easeFunc(t, 0, 1, this.rotationModelParams.duration) * this.rotationModelParams.maxSpeed

		this.model.rotateY(-this.rotationModelParams.currentSpeed * dt)
	}

	dispose() {
		this.isRendering = false; // Stop the render loop first

		if (this.renderer) {
		  this.renderer.dispose();
		  if (this.renderer.forceContextLoss) this.renderer.forceContextLoss(); // Force WebGL context loss if supported
		  this.renderer = null;
		}
  
		// Dispose of the post-processing pipeline
		if (this.pipeline) {
		  this.pipeline.dispose();
		  this.pipeline = null;
		}
  
		if (this.scene && this.scene.environment) {
		  this.scene.environment.dispose();
		  this.scene.environment = null;
		}
  
		if (this.scene) {
		  this.scene.traverse((object) => {
			 if (object.geometry) {
				object.geometry.dispose();
			 }
			 if (object.material) {
				if (Array.isArray(object.material)) {
				  object.material.forEach((mat) => mat.dispose());
				} else {
				  object.material.dispose();
				}
			 }
			 if (object.texture) {
				object.texture.dispose();
			 }
		  });
		  this.scene = null;
		}
  
		if (this.controls) {
		  this.controls.dispose();
		  this.controls = null;
		}
  
		if (this.mixer) {
		  this.mixer.stopAllAction();
		  this.mixer = null;
		}
  
		// Clear references
		this.camera = null;
		this.model = null;
		this.initialModelRotation = null;
	 }
}

// Initialization function
export function init(data) {
	return new ThreeSceneManager(data)
}
