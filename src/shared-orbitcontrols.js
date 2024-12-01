import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { HDRJPGLoader } from "@monogrid/gainmap-js";

import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { CopyShader } from "three/addons/shaders/CopyShader.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

// import ModShader from "./mod_meshphysical_complete.glsl?raw"

import helmetModelUrl from "./McLovin-1024x.glb?url";
import HDRIMAP from "./old_bus_depot_2k_HDR.jpg?url";

function threeFXPatchEffect(instance) {
    if (instance.patched) return; // Skip, already done!
    instance.patched = true;
    console.warn("AO-PATCH", "FX Patched for postprocessing lib", instance);
    
    // Override methods directly on the instance
    instance.initialize = () => { };
    instance.setRenderer = () => { };
    instance.originalRender = instance.render.bind(instance);
    instance.render = function (renderer, inputBuffer, outputBuffer, delta, maskActive) {
        this.originalRender(renderer, outputBuffer, inputBuffer, delta, maskActive);
    };
    instance.setDepthTexture = () => {
        console.warn("Not implemented in patcher");
    };
    return instance;
}

export function init(data) {
	/* eslint-disable-line no-unused-vars */

	let { canvas, inputElement, pixelRatio } = data;
	const renderer = new THREE.WebGLRenderer({
		powerPreference: "high-performance",
		antialias: false,
		// stencil: false,
		// depth: false,
		canvas,
	});
	pixelRatio = 1
	renderer.setPixelRatio(pixelRatio || 1);
	// renderer.outputColorSpace = THREE.SRGBColorSpace;
	// renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
	// renderer.toneMapping = THREE.NoToneMapping;
	// renderer.toneMappingExposure = 1.5;
	// renderer.toneMapping = THREE.ReinhardToneMapping;
	renderer.toneMapping = THREE.ReinhardToneMapping;
	renderer.toneMappingExposure = 1.5;
	// renderer.toneMapping = THREE.CineonToneMapping;
	// renderer.toneMapping = THREE.NeutralToneMapping;
	// renderer.toneMapping = THREE.AgXToneMapping;
	// renderer.toneMapping = THREE.ACESFilmicToneMapping;



	const fov = 50;
	const aspect = 2; // the canvas default
	const near = 0.1;
	const far = 100;
	const camera = new THREE.PerspectiveCamera(fov, aspect, near, far);
	camera.position.z = 0.8;

	const controls = new OrbitControls(camera, inputElement);
	controls.enableDamping = true;
	controls.dampingFactor = 0.055;
	controls.target.set(0, 0, 0);

	controls.update();

	const scene = new THREE.Scene();

	const color = 0xFFFFFF;
	const intensity = 1;
	const light = new THREE.DirectionalLight(color, intensity);
	scene.background = new THREE.Color( 0x000000 );
	light.position.set(-10, 5, 40);
	// scene.add( light );

	let mixer;
	let lastframe = Date.now();
	let dt;

	{
		const loader = new GLTFLoader();
		loader.load(helmetModelUrl, async function (gltf) {
			const model = gltf.scene;
			model.scale.set(1, 1, 1);

			// Improve texture quality for all materials in the model
			model.traverse((child) => {
				// console.log(child.material)
				if (child.material) {
					child.material.needsUpdate = true
					child.material.onBeforeCompile = (shader) => {
						// Inject code into the shader
						// console.log(shader.fragmentShader);
						// shader.fragmentShader = ModShader;

						console.log(shader)
					};
				}

				if (child.isMesh) {
					child.receiveShadow = false;
					// Helper function to apply optimal texture settings
					const optimizeTexture = (texture) => {
						if (texture) {
							// texture.minFilter = THREE.LinearFilter;
							texture.minFilter = THREE.LinearMipmapLinearFilter;
							texture.magFilter = THREE.LinearFilter;
							texture.anisotropy = renderer.capabilities
								.getMaxAnisotropy();
							// texture.anisotropy = false;
							texture.generateMipmaps = true;
						}
					};

					// Apply to all available texture maps
					optimizeTexture(child.material.map); // Base color/diffuse map
					optimizeTexture(child.material.normalMap); // Normal map
					optimizeTexture(child.material.roughnessMap); // Roughness map
					optimizeTexture(child.material.metalnessMap); // Metalness map
				}
			});

			// wait until the model can be added to the scene without blocking due to shader compilation
			await renderer.compileAsync(model, camera, scene);

			mixer = new THREE.AnimationMixer(model);
			const action = mixer.clipAction(gltf.animations[0]);
			// action.play();

			scene.add(model);
			requestAnimationFrame(render);
		});
	}

	{
		const loader = new HDRJPGLoader(renderer);
		loader.load(HDRIMAP, function (hdri) {
			const hdrTexture = hdri.renderTarget.texture;
			// Ensure proper texture settings
			hdrTexture.type = THREE.HalfFloatType;
			hdrTexture.minFilter = THREE.LinearMipmapLinearFilter;
			hdrTexture.magFilter = THREE.LinearFilter;
			hdrTexture.generateMipmaps = true;
			hdrTexture.needsUpdate = true;

			//  scene.background = hdrTexture;
			//  scene.background.mapping = THREE.EquirectangularReflectionMapping;
			scene.environment = hdrTexture;
			scene.environment.mapping = THREE.EquirectangularReflectionMapping;

			// Don't forget to dispose of the HDR renderer when you're done
			hdri.dispose();
		});
	}


	const sizeRenderer = renderer.getDrawingBufferSize( new THREE.Vector2() );
	const renderTarget = new THREE.WebGLRenderTarget( sizeRenderer.width, sizeRenderer.height, 
		{ 
			samples: 8,
			anisotropy: renderer.capabilities.getMaxAnisotropy(),
			colorSpace: THREE.LinearSRGBColorSpace,
			type: THREE.HalfFloatType
		} 
	);

	const composer = new EffectComposer( renderer, renderTarget );

	const renderPass = new RenderPass( scene, camera );
	composer.addPass( renderPass );

	const unrealBloomPass = new UnrealBloomPass(
		sizeRenderer,
		0.12,
		0.9,
		0.1
	)

	composer.addPass(unrealBloomPass);


	// const copyPass = new ShaderPass( CopyShader )
	// composer_1.addPass( copyPass )
	// const smaaRenderPass = new SMAAPass(inputElement.clientWidth, inputElement.clientHeight);
	// composer_1.addPass( smaaRenderPass )


	const outputPass = new OutputPass();
	composer.addPass( outputPass );
	

	const boxWidth = 1;
	const boxHeight = 1;
	const boxDepth = 1;
	const geometry = new THREE.BoxGeometry(boxWidth, boxHeight, boxDepth);

	function makeInstance(geometry, color, position) {
		const material = new THREE.MeshStandardMaterial({
			color,
			envMap: scene.environment, // Add environment map
			metalness: 0.5, // Add some metalness
			roughness: 0.5, // Add some roughness
		});

		const cube = new THREE.Mesh(geometry, material);
		scene.add(cube);
		cube.position.set(position.x, position.y, position.z);
		return cube;
	}

	/*
	const cubes = [
		makeInstance( geometry, 0x44aa88, 0 ),
		makeInstance( geometry, 0x8844aa, - 2 ),
		makeInstance( geometry, 0xaa8844, 2 ),
	];
   */

	const cubes1 = [
		() => makeInstance(geometry, 0x44aa88, getRandomPosition()),
		() => makeInstance(geometry, 0x8844aa, getRandomPosition()),
		() => makeInstance(geometry, 0xaa8844, getRandomPosition()),
	];

	// Helper function to generate random positions
	function getRandomPosition() {
		const min = -30;
		const max = 30;
		return {
			x: Math.random() * (max - min) + min,
			y: Math.random() * (max - min) + min,
			z: Math.random() * (max - min) * 1 + min - 40,
		};
	}

	// Number of times to duplicate
	const timesToDuplicate = 100;

	/*
   // Create the cubes array by executing makeInstance for eac copy
   const cubes = [];
   for (let i = 0; i < timesToDuplicate; i++) {
         for (const instance of cubes1) {
            cubes.push(instance()); // Call each function in cubes1
         }
   }
			*/

	class PickHelper {
		constructor() {
			this.raycaster = new THREE.Raycaster();
			this.pickedObject = null;
			this.pickedObjectSavedColor = 0;
		}
		pick(normalizedPosition, scene, camera, time) {
			// restore the color if there is a picked object
			if (this.pickedObject) {
				this.pickedObject.material.emissive.setHex(
					this.pickedObjectSavedColor,
				);
				this.pickedObject = undefined;
			}

			// cast a ray through the frustum
			this.raycaster.setFromCamera(normalizedPosition, camera);
			// get the list of objects the ray intersected
			const intersectedObjects = this.raycaster.intersectObjects(
				scene.children,
			);
			if (intersectedObjects.length) {
				// pick the first object. It's the closest one
				this.pickedObject = intersectedObjects[0].object;
				// save its color
				this.pickedObjectSavedColor = this.pickedObject.material.emissive
					.getHex();
				// set its emissive color to flashing red/yellow
				this.pickedObject.material.emissive.setHex(
					(time * 8) % 2 > 1 ? 0xFFFF00 : 0xFF0000,
				);
			}
		}
	}

	const pickPosition = { x: -2, y: -2 };
	const pickHelper = new PickHelper();
	clearPickPosition();
	let lastResizeTime = 0;

	function resizeRendererToDisplaySize(renderer, now) {
		if (now - lastResizeTime < 150) return false;
		const canvas = renderer.domElement;
		const width = inputElement.clientWidth;
		const height = inputElement.clientHeight;
		const needResize = canvas.width !== Math.floor(width * pixelRatio) || canvas.height !== Math.floor(height * pixelRatio);
		if (needResize) {
			lastResizeTime = now;
			renderer.setSize(width, height, false);
			renderTarget.setSize(width, height, false);
			composer.setSize(width, height); // Add this line
			renderPass.setSize(width, height);
			unrealBloomPass.resolution.set(width, height); // Update UnrealBloomPass resolution
		}

		return needResize;
	}

	function render(time) {
		time *= 0.001;
		const now = Date.now();

		if (resizeRendererToDisplaySize(renderer, now)) {
			camera.aspect = inputElement.clientWidth / inputElement.clientHeight;
			camera.updateProjectionMatrix();
		}

		/*
		cubes.forEach( ( cube, ndx ) => {

			const speed = 1 + ndx * .0001;
			const rot = time * speed;
			cube.rotation.x = rot;
			cube.rotation.y = rot;

		} );
		 */
		// https://raw.githubusercontent.com/Arecsu/model-viewer/monk/packages/shared-assets/environments/old_bus_depot_2k_HDR.jpg
		// pickHelper.pick( pickPosition, scene, camera, time );

		dt = (now - lastframe) / 1000;
		if (mixer) mixer.update(dt);

		controls.update();

		// renderer.render(scene, camera);
		composer.render();

		lastframe = now;

		requestAnimationFrame(render);
	}

	function getCanvasRelativePosition(event) {
		const rect = inputElement.getBoundingClientRect();
		return {
			x: event.clientX - rect.left,
			y: event.clientY - rect.top,
		};
	}

	function setPickPosition(event) {
		const pos = getCanvasRelativePosition(event);
		pickPosition.x = (pos.x / inputElement.clientWidth) * 2 - 1;
		pickPosition.y = (pos.y / inputElement.clientHeight) * -2 + 1; // note we flip Y
	}

	function clearPickPosition() {
		// unlike the mouse which always has a position
		// if the user stops touching the screen we want
		// to stop picking. For now we just pick a value
		// unlikely to pick something
		pickPosition.x = -100000;
		pickPosition.y = -100000;
	}

	inputElement.addEventListener("mousemove", setPickPosition);
	inputElement.addEventListener("mouseout", clearPickPosition);
	inputElement.addEventListener("mouseleave", clearPickPosition);

	inputElement.addEventListener("touchstart", (event) => {
		// prevent the window from scrolling
		event.preventDefault();
		// inputElement.style.touchAction = 'auto'; // disable touch scroll
		setPickPosition(event.touches[0]);
	}, { passive: false });

	inputElement.addEventListener("touchmove", (event) => {
		setPickPosition(event.touches[0]);
	});

	inputElement.addEventListener("touchend", (event) => {
		// inputElement.style.touchAction = 'auto';
		clearPickPosition();
	});
}
