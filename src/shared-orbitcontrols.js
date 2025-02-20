import * as THREE from "three";
// import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { OrbitControls } from "./OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { HDRJPGLoader } from "@monogrid/gainmap-js";
// import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
// import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
// import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
// import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
// import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
// import { FXAAShader } from "three/addons/shaders/FXAAShader.js";
// import { SMAAPass } from "./postprocessing/SMAAPass.js"
// import { TAARenderPass } from 'three/addons/postprocessing/TAARenderPass.js';
// import { DitheringPass } from "./postprocessing/DitheringPass.js";
import ModShader from "./mod3_meshphysical_complete.glsl?raw"
// import ModShader2 from "./meshphysical_vertex.glsl?raw"

import { BloomEffect, RenderPipeline, ClearPass, GeometryPass, EffectPass, ToneMappingEffect, ToneMapping } from "postprocessing";
// import { SMAAEffect, SMAAPreset } from "postprocessing"

// import artworkModelUrl from "./McLovin-1024x.glb?url";
import artworkModelUrl from "./McLovin-1024x-2.glb?url";
// import artworkModelUrl from "./McLovin-1024x-bevel.glb?url";
// import HDRIMAP from "./old_bus_depot_2k_HDR.jpg?url";
// import HDRIMAP from "./hanger_exterior_cloudy_4k.jpg?url";


function median(numbers) {
	const sorted = Array.from(numbers).sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);

	if (sorted.length % 2 === 0) {
		 return (sorted[middle - 1] + sorted[middle]) / 2;
	}

	return sorted[middle];
}

const getAverage = (array) =>
	array.reduce((sum, currentValue) => sum + currentValue, 0) / array.length;

class ThreeSceneManager {
	constructor(data) {
		this.canvas = data.canvas;
		this.inputElement = data.inputElement;
		this.modelUrl = data.modelUrl;
		// this.modelUrl = artworkModelUrl;
		this.envmapUrl = data.envmapUrl;
		this.lowPerformanceSettings = {
			 disableAA: data.lowPerformanceSettings?.disableAA ?? false,
			 lowResolution: data.lowPerformanceSettings?.lowResolution ?? false
		};
		this.baseLoadPixelRatio = data.pixelRatio ?? window.devicePixelRatio;
		this.initialRenderPixelRatio = this.lowPerformanceSettings.lowResolution ? data.pixelRatio / 2 : this.baseLoadPixelRatio;
		this.performantRenderPixelRatio = null;
		this.msaaSamples = this.lowPerformanceSettings.disableAA ? 0 : 4;

		this.pixelRatioVariation = 1; // this to handle screen DPI changes
         
		this.scene = null;
		this.camera = null;

		this.cameraSettings = {
			targetDistance: data.targetDistance,
			maxDistance: data.targetDistance / 0.9,
			minDistance: data.minDistance
		}

		this.renderer = null;
		this.pipeline = null;
		this.controls = null;
		this.mixer = null;
		this.pickHelper = null;
		this.lastResizeTime = null;
		this.throttleResize = 150; // miliseconds

		this.lastFrame = performance.now();
		this.hasAborted = false;
		this.initScene();

	}

	initScene() {
		this.setupRenderer();
		this.setupCamera();
		this.setupControls();
		this.setupScene();
		//   this.setupLighting();
		this.setupPostProcessing();
		this.setupInteraction();
		this.loadAssets()
			.then(() => {
				this.startPerformanceSamplingLoop();
				// this.startRenderLoop();
			})
			.catch((error) => {
				this.abortLoading(error);
			});
	}

	setupRenderer() {
		this.renderer = new THREE.WebGLRenderer({
			powerPreference: "high-performance",
			antialias: true,
			canvas: this.canvas,
			stencil: false,
			depth: false,
		});

		this.renderer.setPixelRatio(this.initialRenderPixelRatio);
		// this.renderer.toneMapping = THREE.ReinhardToneMapping;
		// this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
		// this.renderer.toneMapping = THREE.CineonToneMapping;
		// this.renderer.toneMapping = THREE.NoToneMapping
		// this.renderer.toneMapping = THREE.NeutralToneMapping;
		// this.renderer.toneMapping = THREE.AgXToneMapping;
		this.renderer.toneMappingExposure = 1.3;
	}

	setupCamera() {
		this.camera = new THREE.PerspectiveCamera(50, 2, 0.1, 100);
		this.camera.position.z = this.cameraSettings.targetDistance;
		// this.camera.rotation.y = Math.PI * 0.5;
	}

	setupControls() {
		this.controls = new OrbitControls(this.camera, this.inputElement);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.055;
		this.controls.target.set(0, 0, 0);
		this.controls.maxDistance = this.cameraSettings.maxDistance;
		this.controls.minDistance = this.cameraSettings.minDistance;
		this.controls.decayTime = 100;
		this.controls.update();
	}

	setupScene() {
		this.scene = new THREE.Scene();
		this.scene.background = new THREE.Color(0x000000);
		// this.scene.background = new THREE.Color(0xFFFFFF);
	}

	setupLighting() {
		const light = new THREE.DirectionalLight(0xFFFFFF, 10);
		light.position.set(0, 0, 5);
		this.scene.add(light);
	}

	setupPostProcessing() {
		this.pipeline = new RenderPipeline(this.renderer);
		this.pipeline.add(new ClearPass());
		this.pipeline.add(new GeometryPass(
			this.scene, this.camera, 
			{ 
				frameBufferType: THREE.HalfFloatType, 
				samples: this.msaaSamples,
			}));
		this.pipeline.add(new EffectPass(
			new BloomEffect(
				{
					luminanceSmoothing: 0.4,
					intensity: 0.2,
					radius: 1,
					luminanceThreshold: 0.1,
					levels: 8
				}
			),
			new ToneMappingEffect(
				{
					toneMapping: ToneMapping.REINHARD
					// toneMapping: ToneMapping.ACES_FILMIC
					// toneMapping: ToneMapping.AGX
				}
			),
			/*
			new SMAAEffect(
				{
					preset: SMAAPreset.HIGH
				}
			)
			*/
		));
	}

	resetPostProcessing() {
		this.pipeline.dispose();
		this.pipeline = null;
		this.setupPostProcessing();
		// this.handleResize(true); 
		// ↑ unnecesary, the main render loop already does it.
		// plus, it makes the screen flash
	}

	setupInteraction() {
		this.pickPosition = { x: -2, y: -2 };
		this.pickHelper = new PickHelper();
		this.clearPickPosition();

		this.inputElement.addEventListener(
			"mousemove",
			this.setPickPosition.bind(this),
		);
		this.inputElement.addEventListener(
			"mouseout",
			this.clearPickPosition.bind(this),
		);
		this.inputElement.addEventListener(
			"mouseleave",
			this.clearPickPosition.bind(this),
		);
		this.inputElement.addEventListener("contextmenu", () => {
			console.log("hi");
		});

		this.setupTouchEvents();
	}

	setupTouchEvents() {
		this.inputElement.addEventListener("touchstart", (event) => {
			event.preventDefault();
			this.setPickPosition(event.touches[0]);
		}, { passive: false });

		this.inputElement.addEventListener("touchmove", (event) => {
			this.setPickPosition(event.touches[0]);
		});

		this.inputElement.addEventListener("touchend", () => {
			this.clearPickPosition();
		});
	}

	abortLoading(error) {
		console.error("Aborting scene loading:", error);
		this.hasAborted = true;
		// Optionally: hide the canvas, show an error message, etc.
		// this.canvas.style.display = "none";
	}
  

	loadAssets() {
		return Promise.all([
			this.loadArtworkModel(),
			this.loadHDREnvironment()
		]);
	}

	loadArtworkModel() {
		return new Promise((resolve, reject) => {
			const loader = new GLTFLoader();
			loader.load(this.modelUrl, async (gltf) => {
				if (this.hasAborted) return;
				const model = gltf.scene;
				// model.rotation.y -= 0.6;
				// model.rotation.x += 0.25;
				// model.rotation.z -= 0.4;
				model.scale.set(1, 1, 1);

				/*
				model.traverse((child) => {
					if (child.material) {
						child.material.needsUpdate = true
						child.material.onBeforeCompile = (shader) => {
							// shader.vertexShader = ModShader2;
							shader.fragmentShader = ModShader;
						};
					}
				});
				*/
				

				this.optimizeModelTextures(model);

				await this.renderer.compileAsync(model, this.camera, this.scene);

				this.mixer = new THREE.AnimationMixer(model);
				const action = this.mixer.clipAction(gltf.animations[0]);
				// action.play();

				this.scene.add(model);
				resolve();
			},      
			undefined,
			(error) => {
				reject("Failed to load artwork model: " + error);
			});
		});
	}

	optimizeModelTextures(model) {
		model.traverse((child) => {
			if (child.isMesh) {
				//  child.receiveShadow = true;
				this.applyTextureOptimization(child.material.map);
				this.applyTextureOptimization(child.material.normalMap);
				this.applyTextureOptimization(child.material.roughnessMap);
				this.applyTextureOptimization(child.material.metalnessMap);
			}
		});
	}

	applyTextureOptimization(texture) {
		if (texture) {
			texture.minFilter = THREE.LinearMipmapLinearFilter;
			texture.magFilter = THREE.LinearFilter;
			texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
			texture.generateMipmaps = true;
		}
	}

	loadHDREnvironment() {
		return new Promise((resolve, reject) => {
			const loader = new HDRJPGLoader(this.renderer);
			loader.load(this.envmapUrl, (hdri) => {
				const hdrTexture = hdri.renderTarget.texture;
				this.configureHDRTexture(hdrTexture);
				// this.scene.background = hdrTexture
				// this.scene.backgroundBlurriness = 0.8
				// this.scene.backgroundIntensity = 0.4
				this.scene.environment = hdrTexture;
				// this.scene.environmentRotation = new THREE.Euler(0.0, -2.37, 0.0);
				// this.scene.environmentRotation = new THREE.Euler(-5.045, -2.37, 1.0);
				this.scene.environment.mapping = THREE.EquirectangularReflectionMapping;
				hdri.dispose();
				resolve();
			},
			undefined,
			(error) => {
				reject("Failed to load HDR environment: " + error);
			});
		});
	}

	configureHDRTexture(texture) {
		texture.type = THREE.HalfFloatType;
		texture.minFilter = THREE.LinearMipmapLinearFilter;
		texture.magFilter = THREE.LinearFilter;
		texture.generateMipmaps = true;
		texture.needsUpdate = true;
	}

	startPerformanceSamplingLoop() {
		const stabilizationTime = 400; // Warm-up period
		const measureDuration = 500;   // Active measurement window
		
		let startTime = null;
		let frameCount = 0;
		let isMeasuring = false;
  
		const applyQualitySettings = (fps) => {
			 console.log(`Applying quality settings for FPS: ${fps.toFixed(1)}`);
  
			 // Disable MSAA if FPS is low
			 if (fps < 50 && this.msaaSamples > 0) {
				  this.msaaSamples = 0;
				  this.resetPostProcessing();
			//  }
  
			// Adjust render resolution
			//  if (fps < 40) {
				  const targetFPS = 75;
				  const fpsRatio = Math.min(fps / targetFPS, 1);
				  const potentialPixelRatio = Math.sqrt((this.initialRenderPixelRatio ** 2.0) * fpsRatio);
				  
				  this.performantRenderPixelRatio = Math.max(
						0.8,
						Math.min(potentialPixelRatio, this.initialRenderPixelRatio)
				  );
			 }
  
			 // Restart normal rendering
			 this.startRenderLoop();
		};
  
		const measureFrame = () => {
			 // Capture current time first for consistent timing
			 const now = performance.now();
			 
			 // Update scene with current time
			 this.handleResize();
			 this.updateScene(now);
			 this.pipeline.render(now);
  
			 // Initialization phase
			 if (!startTime) {
				  startTime = now;
				  requestAnimationFrame(measureFrame);
				  return;
			 }
  
			 // Warm-up phase
			 if (!isMeasuring && (now - startTime) < stabilizationTime) {
				  requestAnimationFrame(measureFrame);
				  return;
			 }
  
			 // Start measurement
			 if (!isMeasuring) {
				  isMeasuring = true;
				  startTime = now;
				  frameCount = 0;
			 }
  
			 // Count frames during measurement
			 frameCount++;
  
			 // Final calculation
			 const elapsed = now - startTime;
			 if (elapsed >= measureDuration) {
				  const actualFPS = frameCount / (elapsed / 1000);
				  console.log(`Measured FPS: ${actualFPS.toFixed(1)}`);
				  applyQualitySettings(actualFPS);
			 } else {
				  requestAnimationFrame(measureFrame);
			 }
		};
  
		requestAnimationFrame(measureFrame);
  }

	startRenderLoop() {
		let prevTime = 0;
		let frames = 0;
		const maxSamples = 5;

		const render = (time) => {
			time *= 0.001;
			const now = performance.now();

			frames++;

			if (time >= prevTime + 1) { // 0.1 second has passed
				const fps = frames / (time - prevTime);
				// console.log(fps)
				prevTime = time;
				frames = 0;
			}

			this.handleResize();
			this.updateScene(now);

			// this.renderer.render(this.scene, this.camera);
			this.pipeline.render(now);

			requestAnimationFrame(render);
		};
		requestAnimationFrame(render);
	}

	getWorkingPixelRatio() {
		if (this.performantRenderPixelRatio) {
			 return this.performantRenderPixelRatio * this.pixelRatioVariation;
		} 
		if (this.initialRenderPixelRatio) {
			 return this.initialRenderPixelRatio * this.pixelRatioVariation;
		}
		return window.devicePixelRatio;
  }

	handleResize(forceResize = false) {
		const { clientWidth: width, clientHeight: height, pixelRatio } = this.inputElement;
		this.pixelRatioVariation = (pixelRatio / this.baseLoadPixelRatio) ?? 1;
		const workingPixelRatio = this.getWorkingPixelRatio();
		const now = performance.now();

		if (forceResize || this.needsResize(now, width, height, workingPixelRatio)) {
			this.updateRendererSize(width, height, workingPixelRatio);
			this.lastResizeTime = now;
			this.camera.aspect = width / height;
			this.camera.updateProjectionMatrix();
		}
	}

	needsResize(now, width, height, workingPixelRatio) {
		if (now - this.lastResizeTime < this.throttleResize) return false;

		const canvas = this.renderer.domElement;
		return ( 
			canvas.width !== Math.floor(width * workingPixelRatio) ||
			canvas.height !== Math.floor(height * workingPixelRatio) ||
			workingPixelRatio !== this.renderer.getPixelRatio()
		);
	}

	updateRendererSize(width, height, workingPixelRatio) {
		this.renderer.setPixelRatio(workingPixelRatio || 1);
		this.renderer.setSize(width, height, false);
		this.pipeline.setSize(width, height, false);
		this.pipeline.setPixelRatio(this.renderer.getPixelRatio());
		// this.pipeline.setPixelRatio(2.0);
		// this.pipeline.setSize
	}

	updateScene(now) {
		const dt = (now - this.lastFrame) / 1000;
		if (this.mixer) this.mixer.update(dt);
		this.controls.update(dt);
		this.lastFrame = now;
	}

	getCanvasRelativePosition(event) {
		const rect = this.inputElement.getBoundingClientRect();
		return {
			x: event.clientX - rect.left,
			y: event.clientY - rect.top,
		};
	}

	setPickPosition(event) {
		const pos = this.getCanvasRelativePosition(event);
		this.pickPosition.x = (pos.x / this.inputElement.clientWidth) * 2 - 1;
		this.pickPosition.y = (pos.y / this.inputElement.clientHeight) * -2 + 1;
	}

	clearPickPosition() {
		this.pickPosition.x = -100000;
		this.pickPosition.y = -100000;
	}
}

// Utility class for object picking
class PickHelper {
	constructor() {
		this.raycaster = new THREE.Raycaster();
		this.pickedObject = null;
		this.pickedObjectSavedColor = 0;
	}

	pick(normalizedPosition, scene, camera, time) {
		// Restore previous picked object color
		if (this.pickedObject) {
			this.pickedObject.material.emissive.setHex(
				this.pickedObjectSavedColor,
			);
			this.pickedObject = undefined;
		}

		// Raycast and find intersected objects
		this.raycaster.setFromCamera(normalizedPosition, camera);
		const intersectedObjects = this.raycaster.intersectObjects(
			scene.children,
		);

		if (intersectedObjects.length) {
			this.pickedObject = intersectedObjects[0].object;
			this.pickedObjectSavedColor = this.pickedObject.material.emissive
				.getHex();

			// Flashing effect for picked object
			this.pickedObject.material.emissive.setHex(
				(time * 8) % 2 > 1 ? 0xFFFF00 : 0xFF0000,
			);
		}
	}
}

// Initialization function
export function init(data) {
	return new ThreeSceneManager(data);
}
