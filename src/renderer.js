import * as THREE from "three"
import { chooseBackend, normalizeBackend } from "./BackendSelection.js"
import { OrbitControls } from "./OrbitControls.js"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { HDRJPGLoader } from "@monogrid/gainmap-js"
import { DitheringEffect } from "./postprocessing/DitheringEffect.js"
import { TonemappedResolvePass } from "./postprocessing/TonemappedResolvePass.js"
import { TemporalAAPass } from "./postprocessing/TemporalAAPass.js"
import { SMAAEffect } from "./postprocessing/SMAAEffect.js"
import { GrazingSpecularClamp } from "./postprocessing/GrazingSpecularClamp.js"
import { SpecularAntialiasing } from "./postprocessing/SpecularAntialiasing.js"
import { MotionBlurPass } from "./postprocessing/MotionBlurPass.js"
import { VelocityBuffer } from "./postprocessing/VelocityBuffer.js"
import { BoundedBloomEffect } from "./postprocessing/BoundedBloomEffect.js"
import { GT7ToneMappingEffect } from "./postprocessing/GT7ToneMappingEffect.js"
import { RenderPipeline, ClearPass, GeometryPass, EffectPass, ToneMappingEffect, ToneMapping } from "postprocessing"
// import HDRIMAP from "./envmaps/old_bus_depot_4k_blur.jpg?url"
import { easeOutQuart, easeInCubic, easeOutCubic } from "js-easing-functions"

class ThreeSceneManager {
	constructor(data) {
		this.options = data
		this.disposed = false
		this.frameRequest = null
		this.interactionTimer = null
		this.interactionDisposers = []
		this.abortController = new AbortController()
		this.environmentResource = null
		this.backend = normalizeBackend(data.backend ?? 'auto')
		this.backendStatus = { requested: this.backend, selected: null, phase: 'initializing', reason: null }
		this.e_backend = data.e_backend || (() => {})
		this.e_error = data.e_error || (() => {})
		this.canvasBound = false
		this.canvas = data.canvas
		this.inputElement = data.inputElement
		this.modelUrl = data.modelUrl
		// this.modelUrl = artworkModelUrl;
		this.envmapUrl = data.envmapUrl
		// this.envmapUrl = HDRIMAP;
		this.lowPerformanceSettings = {
			disableMSAA: data.lowPerformanceSettings?.disableMSAA ?? false,
			lowResolution: data.lowPerformanceSettings?.lowResolution ?? false,
		}
		this.baseLoadPixelRatio = data.pixelRatio ?? globalThis.devicePixelRatio ?? 1
		this.baseDisplayPixelRatio = globalThis.devicePixelRatio ?? 1
		this.initialRenderPixelRatio = this.lowPerformanceSettings.lowResolution ? this.baseLoadPixelRatio / 2 : this.baseLoadPixelRatio
		this.performantRenderPixelRatio = null
		// this.msaaSamples = this.lowPerformanceSettings.disableMSAA ? 0 : 4;
		// this.msaaSamples = this.lowPerformanceSettings.disableMSAA ? 0 : 0;
		// 4 samples: thin bright edges (e.g. the 2.4mm frame sides) slip between the 2 sample rows of 2x MSAA
		this.msaaSamples = this.lowPerformanceSettings.disableMSAA ? 0 : 4;
		// Tonemapped resolve only pays off with MSAA
		this.resolvePass = null
		this.geometryPass = null
		this.taa = null
		// Optional SMAA after tone mapping; smaaPass.enabled toggles it at runtime
		this.smaa = data.smaa ?? false
		this.smaaPass = null
		// Dims the HDR reflections of edge-on surfaces, which alias into thin bright lines. Always compiled in,
		// grazingClamp.enabled toggles it at runtime.
		this.grazingClamp = new GrazingSpecularClamp({ enabled: data.grazingSpecularClamp ?? false })
		// Widens the roughness where the normal varies within a pixel, the prefiltered alternative to the grazing clamp.
		// Always compiled in, specularAA.enabled toggles it at runtime.
		this.specularAA = new SpecularAntialiasing({ enabled: data.specularAntialiasing ?? true })
		// Motion blur from TAA's per-pixel motion; motionBlurPass.enabled toggles it at runtime
		this.motionBlur = data.motionBlur ?? true
		this.motionBlurPass = null
		// Per-object motion from the geometry pass, for TAA and the motion blur. Every mesh is prepared for it; taa.velocityBuffer
		// switches it on (data.velocityBuffer), otherwise TAA reprojects the model as one rigid body.
		this.velocityBuffer = new VelocityBuffer()
		this.useVelocityBuffer = data.velocityBuffer ?? true
		// Gran Turismo 7 tone mapping. The previous Reinhard stays in the effect chain, disabled, for comparison: enable
		// reinhardToneMapping and disable gt7ToneMapping to go back to it.
		this.gt7ToneMapping = null
		this.reinhardToneMapping = null

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
			stabilizationDuration: data.perfSampling?.stabilityDuration ?? 1.0, // Warm-up period in seconds
			measureDuration: data.perfSampling?.measureDuration ?? 0.5, // Active measurement window in seconds
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
		this.ready = this.initScene()
	}

	// preserves the model in view completely at vertical aspect ratios
	cameraMultiplier(ratio) { 
		return (ratio) <= 1 ? 1.0 : 1.0 + 0.2 * (ratio - 1)  }

	async initScene() {
		this.setupCamera()
		this.setupControls()
		this.setupScene()
		try {
			// Return the stable manager handle before observable initialization callbacks can re-enter its owner.
			await Promise.resolve()
			if (this.disposed) return this
			await this.setupRenderer()
			if (this.disposed) return this
			await this.setupPostProcessing()
			if (this.disposed) return this
			await this.loadAssets()
			if (this.disposed) return this
			if (this.backendStatus.selected === 'webgpu') {
				this.handleResize(true)
				// Compile/upload on a staging canvas before binding the user's canvas.
				this.renderer.backend.device.pushErrorScope('validation')
				this.pipeline.render({ present: false })
				const validationError = await this.renderer.backend.device.popErrorScope()
				await this.renderer.backend.device.queue.onSubmittedWorkDone()
				if (validationError) throw new Error(`WebGPU validation: ${validationError.message}`)
				if (this.nativeErrors.length) throw new Error(this.nativeErrors.join('; '))
				if (this.disposed) return this
				const { CanvasTarget } = await import('three/webgpu')
				this.renderer.setCanvasTarget(new CanvasTarget(this.canvas))
				this.canvasBound = true
				this.handleResize(true)
				this.pipeline.resetHistory()
			}
			this.isReady = true
			this.reportBackend({ phase: 'ready' })
			this.e_ready(true)
			if (this.disposed) return this
			if (this.shouldStart && !this.hasStarted) {
				this.hasStarted = true
				this.startPerformanceSamplingLoop()
			}
		} catch (error) { if (!this.disposed) this.abortLoading(error) }
		return this
	}

	reportBackend(update) {
		this.backendStatus = { ...this.backendStatus, ...update }
		this.e_backend({ ...this.backendStatus })
	}

	handleBackendFailure(error, phase = 'failed') {
		if (this.disposed || this.hasAborted) return
		this.hasAborted = true
		this.pauseRendering()
		this.pipeline?.reset?.()
		this.reportBackend({ phase, reason: String(error?.message ?? error) })
		this.e_error({ message: String(error?.message ?? error), backend: this.backendStatus.selected,
			needsCanvasReplacement: this.canvasBound, recoverable: this.backendStatus.selected === 'webgpu' })
	}

	pauseRendering() {
		const wasRendering = this.isRendering
		this.isRendering = false
		if (this.frameRequest !== null) cancelAnimationFrame(this.frameRequest)
		this.frameRequest = null
		return wasRendering
	}

	resumeRendering() {
		if (this.disposed || this.hasAborted || this.isRendering || !this.isReady) return
		this.isRendering = true
		this.startRenderLoop()
	}

	scheduleFrame(callback) {
		if (!this.disposed && this.isRendering && this.frameRequest === null) this.frameRequest = requestAnimationFrame(() => {
			this.frameRequest = null
			try { callback() } catch (error) { this.handleBackendFailure(error) }
		})
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

	async setupRenderer() {
		const choice = chooseBackend(this.backend)
		this.reportBackend({ ...choice, phase: 'initializing' })
		if (choice.selected === 'webgpu') {
			let native
			try {
				const GPU = await import('three/webgpu')
				if (this.disposed) return
				const staging = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas')
				native = new GPU.WebGPURenderer({ canvas: staging, antialias: false, depth: false, stencil: false,
					powerPreference: 'high-performance', trackTimestamp: true })
				// r186 installs an implicit WebGL fallback; ours is a separate, observable reference pipeline.
				native._getFallback = null
				await native.init()
				if (this.disposed) { native.dispose(); return }
				if (!native.backend.isWebGPUBackend) throw new Error('Native WebGPU backend required')
				this.nativeErrors = []
				native.onError = info => { this.nativeErrors.push(info.message); if (this.isReady) this.handleBackendFailure(new Error(info.message)) }
				native.onDeviceLost = info => this.handleBackendFailure(new Error(info.message), 'device-lost')
				this.renderer = native
				this.renderer.setPixelRatio(this.initialRenderPixelRatio)
				this.renderer.toneMapping = GPU.NoToneMapping
				this.renderer.toneMappingExposure = 1.6
				this.camera.coordinateSystem = native.coordinateSystem
				this.camera.updateProjectionMatrix()
				return
			} catch (error) {
				native?.dispose()
				if (this.disposed) return
				this.reportBackend({ selected: 'webgl', phase: 'initializing', reason: `webgpu-init-failed: ${error.message}` })
			}
		}
		this.renderer = new THREE.WebGLRenderer({
			powerPreference: "high-performance",
			antialias: false,
			canvas: this.canvas,
			stencil: false,
			depth: false,
		})

		this.canvasBound = true
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

	async setupPostProcessing() {
		if (this.backendStatus.selected === 'webgpu') {
			const { WebGpuPipeline } = await import('./webgpu/WebGpuPipeline.js')
			if (this.disposed) return
			this.pipeline = new WebGpuPipeline(this)
			await this.pipeline.compile()
			return
		}
		return new Promise((resolve, reject) => {
			this.pipeline = new RenderPipeline(this.renderer)
			// Smooths what MSAA quantizes into steps, e.g. sub-pixel edges sliding across pixel rows.
			// The settings are aa-lab.html's "modern" preset: 1px jitter over 8 Halton positions, a sharp Gaussian
			// reconstruction filter (k 5), a 3x3 variance clamp clipped towards the current colour, history validated by
			// depth and by motion, thin feature locks, edge-adaptive blend and sample confidence. Jitter compensation stays
			// off: with it, still frames keep the 1px jitter visible.
			this.taa = new TemporalAAPass({
				exposure: this.renderer.toneMappingExposure,
				backgroundFastPath: true,
				blend: 0.15,
				neighbourhood: 9,
				clipTowardsCurrent: true,
				depthRejection: true,
				motionRejection: true,
				thinFeatureLocks: true,
				lockFrames: 4,
				lockMaxSpeed: 12,
				edgeAdaptiveBlend: true,
				sampleConfidence: true,
			})
			this.taa.trackedObject = this.model
			this.pipeline.add(this.taa.jitterPass)
			const clearPass = new ClearPass()
			this.pipeline.add(clearPass)
			// geometryPass.samples can be changed at runtime, the resolve pass works without MSAA too
			this.geometryPass = new GeometryPass(this.scene, this.camera, {
				frameBufferType: THREE.HalfFloatType,
				// frameBufferType: THREE.UnsignedByteType,
				samples: this.msaaSamples,
			})
			this.pipeline.add(this.geometryPass)
			this.velocityBuffer.register(this.geometryPass, clearPass)
			if (this.useVelocityBuffer) this.taa.velocityBuffer = this.velocityBuffer
			if (this.msaaSamples > 0) {
				// Resolve MSAA in tonemapped space so bright HDR edges get antialiased
				// The reactive mask keeps the glass's reflections and scratches out of the thin feature locks
				this.resolvePass = new TonemappedResolvePass({ exposure: this.renderer.toneMappingExposure, reactiveMask: true })
				this.taa.reactiveMask = this.resolvePass.reactiveMask
				clearPass.clearValues.color = this.resolvePass.encodeColor(this.scene.background)
				this.pipeline.add(this.resolvePass)
			}
			this.pipeline.add(this.taa)
			this.motionBlurPass = new MotionBlurPass(this.taa, { shutter: 0.8 })
			this.motionBlurPass.enabled = this.motionBlur
			this.pipeline.add(this.motionBlurPass)
			const bloom = new BoundedBloomEffect(this.taa, {
				luminanceSmoothing: 0.4,
				intensity: 0.3,
				radius: 1,
				luminanceThreshold: 0.1,
				levels: 8,
			})
			bloom.motionBlurSource = this.motionBlurPass
			// Graded in aa-lab.html. GT maps 1.0 to 100 cd/m² against a 250 cd/m² SDR white, so it needs more exposure than
			// Reinhard. The softer shoulder (hardness below 0, never clips) keeps the detail in the brightest reflections.
			this.gt7ToneMapping = new GT7ToneMappingEffect({
				exposure: 5.15,
				contrast: 1.0,
				blackPoint: -0.02,
				shadowToe: 1.37,
				toeLength: 0.25,
				shoulderStart: 0.37,
				highlightHardness: -0.08,
				chromaPreservation: 0.36,
				saturation: 1.0,
				vibrance: 0.1,
			})
			this.reinhardToneMapping = new ToneMappingEffect({ toneMapping: ToneMapping.REINHARD })
			this.reinhardToneMapping.enabled = false
			const effects = new EffectPass(
				// new SMAAEffect(),
				// new FXAAEffect({
				// 	minEdgeThreshold: 0.012,
				// 	maxEdgeThreshold: 0.325,
				// 	subpixelQuality: 1.0,
				// 	samples: 12,
				// }),
				bloom,
				this.gt7ToneMapping,
				this.reinhardToneMapping,
				 new DitheringEffect()
			)
			if (this.smaa) {
				// SMAA wants display-referred input, so it runs in its own pass after tone mapping. The sRGB8 buffer in
				// between quantizes like the canvas, so with smaaPass disabled the output is unchanged. Set before add():
				// replacing the output of the last pass trips the pipeline's output rerouting.
				effects.autoSyncDefaultBuffers = false
				effects.output.defaultBuffer = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, colorSpace: THREE.SRGBColorSpace })
				this.pipeline.add(effects)
				this.smaaPass = new EffectPass(new SMAAEffect())
				this.pipeline.add(this.smaaPass)
			} else {
				this.pipeline.add(effects)
			}

			this.pipeline
				.compile()
				.then(() => resolve())
				.catch((error) => reject("Failed to compile postprocessing pipeline: " + error))
		})
	}

	async resetPostProcessing() {
		const resume = this.pauseRendering()
		try {
			this.pipeline?.dispose()
			this.pipeline = null
			await this.setupPostProcessing()
			if (this.disposed) return
			if (this.backendStatus.selected === 'webgpu' && this.model) this.pipeline.prepare(this.model)
			this.handleResize(true)
		} catch (error) { this.handleBackendFailure(error) }
		finally { if (resume) this.resumeRendering() }
	}

	setupInteraction() {
		if (this.interactionDisposers.length) return
		const listen = (type, listener) => {
			this.inputElement.addEventListener(type, listener)
			this.interactionDisposers.push(() => this.inputElement.removeEventListener(type, listener))
		}
		listen('contextmenu', event => event.preventDefault())
		for (const type of ['mousedown', 'touchstart']) listen(type, this.handleInputStart.bind(this))
		for (const type of ['mousemove', 'touchmove']) listen(type, this.handleInputMove.bind(this))
		for (const type of ['mouseup', 'touchend']) listen(type, this.handleInputEnd.bind(this))
	}

	handleInputStart(event) {
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
		this.handleBackendFailure(error)
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
					try {
					if (this.hasAborted || this.disposed) { disposeObject(gltf.scene); resolve(); return }
					this.model = gltf.scene
					// model.rotation.y -= 0.6;
					// model.rotation.x += 0.25;
					// model.rotation.z -= 0.4;
					this.model.scale.set(1, 1, 1)
					this.initialModelRotation = this.model.quaternion.clone()

				this.model.traverse((child) => {
					if (child.material) {
						child.material.needsUpdate = true
					}
				});
				// First: it gives every mesh its own material, which the other patches then apply to
				if (this.backendStatus.selected === 'webgpu') {
					this.pipeline.prepare(this.model)
				} else {
					this.velocityBuffer.prepare(this.model)
					this.resolvePass?.prepare(this.model)
					this.grazingClamp.prepare(this.model)
					this.specularAA.prepare(this.model)
				}
				if (this.taa) this.taa.trackedObject = this.model

					this.optimizeModelTextures(this.model)

					if (this.backendStatus.selected !== 'webgpu') await this.renderer.compileAsync(this.model, this.camera, this.scene)
					if (this.disposed) { disposeObject(this.model); resolve(); return }

					// this.mixer = new THREE.AnimationMixer(this.model)
					// const action = this.mixer.clipAction(gltf.animations[0])
					// action.play();

					this.scene.add(this.model)
					resolve()
					} catch (error) { reject(error) }
				},
				undefined,
				(error) => {
					reject("Failed to load artwork model: " + error)
				}
			)
		})
	}

	optimizeModelTextures(model) {
		if (this.backendStatus.selected === 'webgpu') { this.optimizeNativeTextures?.(this.renderer, model); return }
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

	async loadHDREnvironment() {
		if (this.backendStatus.selected === 'webgpu') {
			const { loadWebGpuEnvironment, optimizeWebGpuTextures } = await import('./webgpu/Environment.js')
			this.optimizeNativeTextures = optimizeWebGpuTextures
			const resource = await loadWebGpuEnvironment(this.renderer, this.envmapUrl, { signal: this.abortController.signal })
			if (this.disposed) { resource.dispose(); return }
			this.environmentResource = resource
			this.scene.environment = resource.texture
			if (this.model) optimizeWebGpuTextures?.(this.renderer, this.model)
			return
		}
		return new Promise((resolve, reject) => {
			const loader = new HDRJPGLoader(this.renderer)
			loader.load(
				this.envmapUrl,
				(hdri) => {
					if (this.disposed) { hdri.dispose(); resolve(); return }
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
		// Clock time at which the warm-up before a measurement ends
		let warmupEnd = stabilizationTime
		let measureStart = 0

		// Returns false when the settings changed enough to need another measurement
		const applyQualitySettings = (fps) => {
			console.log(`Applying quality settings for FPS: ${fps.toFixed(1)}`)

			// Drop MSAA first: TAA alone is the best quality per millisecond, MSAA costs ~30% of the frame
			if (fps < 54 && this.geometryPass?.samples > 0) {
				console.log("Disabling MSAA")
				this.geometryPass.samples = 0
				this.taa?.reset()
				return false
			}

			// Adjust render resolution
			if (fps < 54) {
				const targetFPS = 75
				const fpsRatio = Math.min(fps / targetFPS, 1)
				const potentialPixelRatio = Math.sqrt(this.initialRenderPixelRatio ** 2.0 * fpsRatio)

				this.performantRenderPixelRatio = Math.max(0.8, Math.min(potentialPixelRatio, this.initialRenderPixelRatio))
			}

			return true
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
			if (!isMeasuring && this.clock.getElapsedTime() < warmupEnd) {
				this.scheduleFrame(measureFrame)
				return
			}

			// Start measurement
			if (!isMeasuring) {
				isMeasuring = true
				frameCount = 0
				measureStart = this.clock.getElapsedTime()
			}
			
			frameCount++
			
			const elapsed = this.clock.getElapsedTime() - measureStart
			if (elapsed >= measureDuration) {
				const actualFPS = frameCount / elapsed
				console.log(`Measured FPS: ${actualFPS.toFixed(1)}`)
				if (applyQualitySettings(actualFPS)) {
					this.startRenderLoop()
				} else {
					// Measure again with the new settings, after the buffers are recreated
					isMeasuring = false
					warmupEnd = this.clock.getElapsedTime() + 0.2
					this.scheduleFrame(measureFrame)
				}
			} else {
				this.scheduleFrame(measureFrame)
			}
		}

		// Set timer to start counting the animation from there
		this.clock.start()
		this.setupInteraction()
		this.e_loaded(true)
		if (this.disposed) return
		this.isRendering = true
		this.interactionTimer = setTimeout(() => // signal to change cursor in main.ts
			this.e_interactivityChange(this.isInteractive), 
			this.initDelayInteractive * 1000
		)
		this.scheduleFrame(measureFrame)
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
			this.scheduleFrame(render)
		}
		if (this.frameRequest === null) this.scheduleFrame(render)
	}

	resetHistory() {
		if (this.backendStatus.selected === 'webgpu') { this.pipeline?.resetHistory(); return }
		this.taa?.reset()
		this.velocityBuffer.initialized = false
	}

	getWorkingPixelRatio() {
		if (this.performantRenderPixelRatio) {
			return this.performantRenderPixelRatio * this.pixelRatioVariation
		}
		if (this.initialRenderPixelRatio) {
			return this.initialRenderPixelRatio * this.pixelRatioVariation
		}
		return globalThis.devicePixelRatio ?? 1
	}

	handleResize(forceResize = false) {
		if (!this.renderer) return; // Exit early if renderer is disposed
		
		const { clientWidth: width, clientHeight: height, pixelRatio } = this.inputElement;
		if (!(width > 0 && height > 0)) return;
		this.pixelRatioVariation = pixelRatio ? pixelRatio / this.baseLoadPixelRatio :
			(globalThis.devicePixelRatio ?? 1) / this.baseDisplayPixelRatio;
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
		width = Math.max(1, width); height = Math.max(1, height)
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
		if (this.disposed) return
		this.disposed = true
		this.pauseRendering()
		this.abortController.abort()
		clearTimeout(this.interactionTimer)
		for (const remove of this.interactionDisposers.splice(0)) remove()
		this.pipeline?.dispose()
		this.pipeline = null
		this.environmentResource?.dispose()
		if (this.environmentResource && this.scene) this.scene.environment = null
		this.environmentResource = null
		this.reportBackend({ phase: 'disposed' })

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
		  disposeObject(this.scene);
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

function disposeObject(root) {
	const textures = new Set(), materials = new Set(), geometries = new Set()
	root?.traverse(object => {
		if (object.geometry) geometries.add(object.geometry)
		for (const material of (Array.isArray(object.material) ? object.material : [object.material])) if (material) {
			materials.add(material)
			for (const value of Object.values(material)) if (value?.isTexture) textures.add(value)
		}
	})
	textures.forEach(texture => texture.dispose())
	materials.forEach(material => material.dispose())
	geometries.forEach(geometry => geometry.dispose())
}

// Initialization function
export function init(data) {
	return new ThreeSceneManager(data)
}
