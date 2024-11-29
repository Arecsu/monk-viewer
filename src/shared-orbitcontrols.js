import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRJPGLoader } from '@monogrid/gainmap-js';
import helmetModelUrl from './McLovin-1024x.glb?url';
import HDRIMAP from './old_bus_depot_2k_HDR.jpg?url';
import { BloomEffect, EffectComposer, EffectPass, RenderPass, BlendFunction, BrightnessContrastEffect, HueSaturationEffect, ToneMappingEffect, ToneMappingMode, SMAAEffect, EdgeDetectionMode, SMAAPreset } from "postprocessing";

export function init( data ) { /* eslint-disable-line no-unused-vars */

	const { canvas, inputElement } = data;
	const renderer = new THREE.WebGLRenderer( { antialias: true, canvas } );
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.toneMapping = THREE.NoToneMapping;
	// renderer.toneMapping = THREE.ReinhardToneMapping;
	// renderer.toneMappingExposure = 2;
	// renderer.toneMapping = THREE.ReinhardToneMapping;
	// renderer.toneMappingExposure = 1.5;
	// renderer.toneMapping = THREE.CineonToneMapping;
	// renderer.toneMapping = THREE.NeutralToneMapping;
	// renderer.toneMapping = THREE.AgXToneMapping;
	// renderer.toneMapping = THREE.ACESFilmicToneMapping;

	const fov = 75;
	const aspect = 2; // the canvas default
	const near = 0.1;
	const far = 100;
	const camera = new THREE.PerspectiveCamera( fov, aspect, near, far );
	camera.position.z = 4;

	const controls = new OrbitControls( camera, inputElement );
   controls.enableDamping = true;
   controls.dampingFactor = 0.055;
	controls.target.set( 0, 0, 0 );

	controls.update();

	const scene = new THREE.Scene();


	const color = 0xFFFFFF;
	const intensity = 1;
	const light = new THREE.DirectionalLight( color, intensity );
	light.position.set( - 10, 5, 40 );
	// scene.add( light );


	let mixer
	let lastframe = Date.now()
	let dt

	{
		const loader = new GLTFLoader()
		loader.load( helmetModelUrl, async function ( gltf ) {
			const model = gltf.scene;
			model.scale.set(7, 7, 7);

			// wait until the model can be added to the scene without blocking due to shader compilation

			await renderer.compileAsync( model, camera, scene );

			mixer = new THREE.AnimationMixer( model );
			console.log(gltf.animations)
			var action = mixer.clipAction( gltf.animations[ 0 ] );
			action.play();

			scene.add( model );
			requestAnimationFrame( render );

		})
	}


	{
		const loader = new HDRJPGLoader(renderer);
		loader.load(HDRIMAP, function (hdri) {
			 const hdrTexture = hdri.renderTarget.texture;
			 // Ensure proper texture settings
			 hdrTexture.type = THREE.HalfFloatType;
			//  hdrTexture.minFilter = THREE.LinearFilter;
			//  hdrTexture.magFilter = THREE.LinearFilter;
			 hdrTexture.needsUpdate = true;
			 
			 // scene.background = hdrTexture;
			 // scene.background.mapping = THREE.EquirectangularReflectionMapping;
			 scene.environment = hdrTexture;
			 scene.environment.mapping = THREE.EquirectangularReflectionMapping;
  
			 // Don't forget to dispose of the HDR renderer when you're done
			 hdri.dispose();
		});
	}

	const composer = new EffectComposer(renderer, {
		frameBufferType: THREE.HalfFloatType
	});
	
	composer.addPass(new RenderPass(scene, camera));
	// composer.addPass(new EffectPass(camera, new BloomEffect()));

	const smaaEffect = new SMAAEffect({
		preset: SMAAPreset.HIGH,
		edgeDetectionMode: EdgeDetectionMode.DEPTH
  });
  smaaEffect.edgeDetectionMaterial.edgeDetectionThreshold = 0.01;

  const bloomEffect = new BloomEffect({
		// blendFunction:
		luminanceThreshold: 0.5,
		luminanceSmoothing: 0.1,
		mipmapBlur: 1,
		intensity: 4, 
		radius: 0.7,
		// levels, 
  })

	const toneMappingEffect = new ToneMappingEffect({
		mode: ToneMappingMode.REINHARD2,
		resolution: 256,
		whitePoint: 30.0,
		middleGrey: 0.6,
		minLuminance: 0.01,
		averageLuminance: 0.001,
		adaptationRate: 1.0,
		// blendFunction: BlendFunction.MULTIPLY,
	});


	const hueSaturationEffect = new HueSaturationEffect({
		hue: 0,          // Range: 0 to 2π
		saturation: 0,   // Range: -1 to 1
		blendFunction: BlendFunction.NORMAL
	});

	const brightnessContrastEffect = new BrightnessContrastEffect({
		brightness: 0,   // Range: -1 to 1
		contrast: 0,     // Range: -1 to 1
		blendFunction: BlendFunction.NORMAL
	});

	// Add all effects to a single pass
	composer.addPass(new EffectPass(
		camera,
		// SMAAEffect,
		// bloomEffect,
		// toneMappingEffect,
		// hueSaturationEffect,
		// brightnessContrastEffect,
	));


	const boxWidth = 1;
	const boxHeight = 1;
	const boxDepth = 1;
	const geometry = new THREE.BoxGeometry( boxWidth, boxHeight, boxDepth );

	function makeInstance( geometry, color, position) {
		const material = new THREE.MeshStandardMaterial({
			 color,
			 envMap: scene.environment,    // Add environment map
			 metalness: 0.5,               // Add some metalness
			 roughness: 0.5                // Add some roughness
		});
		
		const cube = new THREE.Mesh( geometry, material );
		scene.add( cube );
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
       z: Math.random() * (max - min) * 1 + min - 40
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
		pick( normalizedPosition, scene, camera, time ) {

			// restore the color if there is a picked object
			if ( this.pickedObject ) {

				this.pickedObject.material.emissive.setHex( this.pickedObjectSavedColor );
				this.pickedObject = undefined;

			}

			// cast a ray through the frustum
			this.raycaster.setFromCamera( normalizedPosition, camera );
			// get the list of objects the ray intersected
			const intersectedObjects = this.raycaster.intersectObjects( scene.children );
			if ( intersectedObjects.length ) {

				// pick the first object. It's the closest one
				this.pickedObject = intersectedObjects[ 0 ].object;
				// save its color
				this.pickedObjectSavedColor = this.pickedObject.material.emissive.getHex();
				// set its emissive color to flashing red/yellow
				this.pickedObject.material.emissive.setHex( ( time * 8 ) % 2 > 1 ? 0xFFFF00 : 0xFF0000 );

			}

		}

	}

	const pickPosition = { x: - 2, y: - 2 };
	const pickHelper = new PickHelper();
	clearPickPosition();

function resizeRendererToDisplaySize(renderer) {
    const canvas = renderer.domElement;
    const width = inputElement.clientWidth;
    const height = inputElement.clientHeight;
    const needResize = canvas.width !== width || canvas.height !== height;
    if (needResize) {
        renderer.setSize(width, height, false);
        composer.setSize(width, height); // Add this line
    }
    return needResize;
}

	function render( time ) {

		time *= 0.001;

		if ( resizeRendererToDisplaySize( renderer ) ) {

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
		
		dt = (Date.now() - lastframe)/1000
		if (mixer) mixer.update(dt)

      controls.update();

		// renderer.render( scene, camera );
		composer.render();
		
		lastframe = Date.now();

		requestAnimationFrame( render );

	}


	function getCanvasRelativePosition( event ) {

		const rect = inputElement.getBoundingClientRect();
		return {
			x: event.clientX - rect.left,
			y: event.clientY - rect.top,
		};

	}

	function setPickPosition( event ) {

		const pos = getCanvasRelativePosition( event );
		pickPosition.x = ( pos.x / inputElement.clientWidth ) * 2 - 1;
		pickPosition.y = ( pos.y / inputElement.clientHeight ) * - 2 + 1; // note we flip Y

	}

	function clearPickPosition() {

		// unlike the mouse which always has a position
		// if the user stops touching the screen we want
		// to stop picking. For now we just pick a value
		// unlikely to pick something
		pickPosition.x = - 100000;
		pickPosition.y = - 100000;

   }

	inputElement.addEventListener( 'mousemove', setPickPosition );
	inputElement.addEventListener( 'mouseout', clearPickPosition );
	inputElement.addEventListener( 'mouseleave', clearPickPosition );

	inputElement.addEventListener( 'touchstart', ( event ) => {

		// prevent the window from scrolling
		event.preventDefault();
      // inputElement.style.touchAction = 'auto'; // disable touch scroll
		setPickPosition( event.touches[ 0 ] );

	}, { passive: false } );

	inputElement.addEventListener( 'touchmove', ( event ) => {

		setPickPosition( event.touches[ 0 ] );

	} );

	inputElement.addEventListener( 'touchend', ( event ) => { 
      
      // inputElement.style.touchAction = 'auto';
      clearPickPosition();
      
   })

}
