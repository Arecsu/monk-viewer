import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { HDRJPGLoader } from "@monogrid/gainmap-js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { FXAAShader } from "three/addons/shaders/FXAAShader.js";
import { DitheringPass } from "./postprocessing/DitheringPass.js";

// Import asset URLs
import artworkModelUrl from "./McLovin-1024x.glb?url";
import HDRIMAP from "./old_bus_depot_2k_HDR.jpg?url";

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
		this.lowPerformanceSettings = {
			 disableMSAA: data.lowPerformanceSettings?.disableMSAA ?? false,
			 lowResolution: data.lowPerformanceSettings?.lowResolution ?? false
		};
		this.baseLoadPixelRatio = data.pixelRatio ?? window.devicePixelRatio;
		this.initialRenderPixelRatio = this.lowPerformanceSettings.lowResolution ? data.pixelRatio / 2 : this.baseLoadPixelRatio;
		this.performantRenderPixelRatio = null;
		this.msaaSamples = this.lowPerformanceSettings.disableMSAA ? 0 : 4;

		this.pixelRatioVariation = 1; // this to handle screen DPI changes

		this.scene = null;
		this.camera = null;
		this.renderer = null;
		this.composer = null;
		this.controls = null;
		this.mixer = null;
		this.pickHelper = null;
		this.lastResizeTime = null;
		this.throttleResize = 150; // miliseconds

		this.lastFrame = Date.now();
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
		this.loadAssets();
	}

	setupRenderer() {
		this.renderer = new THREE.WebGLRenderer({
			powerPreference: "high-performance",
			antialias: true,
			canvas: this.canvas,
		});

		this.renderer.setPixelRatio(this.initialRenderPixelRatio);
		this.renderer.toneMapping = THREE.ReinhardToneMapping;
		//   this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.5;
	}

	setupCamera() {
		this.camera = new THREE.PerspectiveCamera(50, 2, 0.1, 100);
		this.camera.position.z = 0.8;
	}

	setupControls() {
		this.controls = new OrbitControls(this.camera, this.inputElement);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.055;
		this.controls.target.set(0, 0, 0);
		this.controls.update();
	}

	setupScene() {
		this.scene = new THREE.Scene();
		this.scene.background = new THREE.Color(0x000000);
	}

	setupLighting() {
		const light = new THREE.DirectionalLight(0xFFFFFF, 10);
		light.position.set(0, 0, 5);
		this.scene.add(light);
	}

	setupPostProcessing() {
		const renderTarget = new THREE.WebGLRenderTarget(
			this.inputElement.clientWidth,
			this.inputElement.clientHeight,
			{
				samples: this.msaaSamples,
				anisotropy: this.renderer.capabilities.getMaxAnisotropy(),
				colorSpace: THREE.LinearSRGBColorSpace,
				type: THREE.HalfFloatType,
			},
		);

		this.composer = new EffectComposer(this.renderer, renderTarget);

		const renderPass = new RenderPass(this.scene, this.camera);
		this.composer.addPass(renderPass);

		const bloomPass = new UnrealBloomPass(
			new THREE.Vector2(
				this.inputElement.clientWidth,
				this.inputElement.clientHeight,
			),
			0.12,
			0.9,
			0.1,
		);

		this.composer.addPass(bloomPass);

		const pixelRatio = this.getWorkingPixelRatio();


		const outputPass = new OutputPass();
		this.composer.addPass(outputPass);

		const ditheringPass = new DitheringPass({
			ditherIntensity: 1.0,
			ditherPattern: 0 // 0 for noise-based dithering, 1 for ordered dithering
		});
		this.composer.addPass(ditheringPass);

	}

	resetPostProcessing() {
		this.composer.dispose();
		this.composer = null;
		this.setupPostProcessing();
		this.handleResize(true);
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

	loadAssets() {
		this.loadArtworkModel();
		this.loadHDREnvironment();
	}

	loadArtworkModel() {
		const loader = new GLTFLoader();
		loader.load(artworkModelUrl, async (gltf) => {
			const model = gltf.scene;
			model.scale.set(1, 1, 1);

			this.optimizeModelTextures(model);

			await this.renderer.compileAsync(model, this.camera, this.scene);

			this.mixer = new THREE.AnimationMixer(model);
			const action = this.mixer.clipAction(gltf.animations[0]);
			// Uncomment to play animation
			// action.play();

			this.scene.add(model);
			this.startPerformanceSamplingLoop();
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
		const loader = new HDRJPGLoader(this.renderer);
		loader.load(HDRIMAP, (hdri) => {
			const hdrTexture = hdri.renderTarget.texture;
			this.configureHDRTexture(hdrTexture);
			this.scene.environment = hdrTexture;
			this.scene.environment.mapping =
				THREE.EquirectangularReflectionMapping;
			hdri.dispose();
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
		let prevTime = 0;
		let frames = 0;
		const fpsSamples = [];
		const maxSamples = 5;

		const performanceSample = (time) => {
			time *= 0.001;
			const now = Date.now();

			this.handleResize();
			this.updateScene(time, now);

			this.composer.render();

			// Increment the frame counter
			frames++;

			// Collect FPS samples for the first 400 milliseconds
			if (time >= prevTime + 0.1) { // 0.1 second has passed
				const fps = frames / (time - prevTime);
				fpsSamples.push(fps);

				prevTime = time;
				frames = 0;

				// If we have collected 5 samples, evaluate performance
				if (fpsSamples.length >= maxSamples) {
					// const maxFPS = Math.max(...fpsSamples);
					// const maxFPS = median(fpsSamples.slice(3, -1));
					const maxFPS = getAverage(fpsSamples.slice(3));
					const targetFPS = 75;

					console.log('maxfps: ', maxFPS);
					console.log('fpssamples: ', fpsSamples);

					if (maxFPS < 50 && this.msaaSamples > 0) {
						this.msaaSamples = 0;
						this.resetPostProcessing();
					}

					if (maxFPS < 30) {
						// Calculate the ratio of FPS increase needed
						const fpsRatio = maxFPS / targetFPS;

						// Calculate the new pixel ratio
						const potentialPixelRatio = Math.sqrt(this.initialRenderPixelRatio ** 2.6 * fpsRatio);

						this.performantRenderPixelRatio = Math.max(
							0.8,
							Math.min(potentialPixelRatio, this.initialRenderPixelRatio),
						);
						console.log(potentialPixelRatio);
					}

					this.startRenderLoop();

					return;
				}
			}

			requestAnimationFrame(performanceSample);
		};

		requestAnimationFrame(performanceSample);
	}

	startRenderLoop() {
		let prevTime = 0;
		let frames = 0;
		const maxSamples = 5;

		const render = (time) => {
			time *= 0.001;
			const now = Date.now();

			frames++;

			if (time >= prevTime + 1) { // 0.1 second has passed
				const fps = frames / (time - prevTime);
				console.log(fps)
				prevTime = time;
				frames = 0;
			}

			this.handleResize();
			this.updateScene(time, now);

			this.composer.render();

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
		const now = Date.now();

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
		this.composer.setPixelRatio(this.renderer.getPixelRatio());
		this.composer.setSize(width, height);
	}

	updateScene(time, now) {
		const dt = (now - this.lastFrame) / 1000;
		if (this.mixer) this.mixer.update(dt);
		this.controls.update();
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
