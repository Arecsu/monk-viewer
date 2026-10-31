// The test scene of pmndrs/upscaler's "02 · FSR1 vs FSR3" example (examples/02-fsr1-vs-fsr3 and
// examples/shared/props.ts), rebuilt on the viewer's own pipeline so our TAA/MSAA/SMAA can be compared against that
// page: thin pickets and a spinning metal knot over a high-frequency grid floor, a warm key light and a cool
// hemisphere fill, no environment map. Camera, orbit controls and auto orbit are configured like the example.
//
// The one structural difference: the 48 pickets are merged into one mesh instead of an InstancedMesh. The velocity
// stage reprojects with the mesh matrix only, so instanced copies would get wrong motion vectors. Same pixels, same
// single draw call.

import * as THREE from "three"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"
import { ThreeSceneManager } from "../renderer.js"

/** Checkerboard + thin-grid floor texture, drawn on a canvas (props.ts createGridTexture). */
function createGridTexture(repeat = 12) {
	const size = 512
	const canvas = document.createElement("canvas")
	canvas.width = size
	canvas.height = size
	const ctx = canvas.getContext("2d")

	ctx.fillStyle = "#5c6470"
	ctx.fillRect(0, 0, size, size)
	ctx.fillStyle = "#823535"
	ctx.fillRect(0, 0, size / 2, size / 2)
	ctx.fillRect(size / 2, size / 2, size / 2, size / 2)

	// Thin grid lines, the sub-pixel detail that shows antialiasing quality
	ctx.strokeStyle = "#e8edf4"
	ctx.lineWidth = 2
	const cells = 8
	for (let i = 0; i <= cells; i++) {
		const p = (i / cells) * size
		ctx.beginPath()
		ctx.moveTo(p, 0)
		ctx.lineTo(p, size)
		ctx.moveTo(0, p)
		ctx.lineTo(size, p)
		ctx.stroke()
	}

	const texture = new THREE.CanvasTexture(canvas)
	texture.wrapS = THREE.RepeatWrapping
	texture.wrapT = THREE.RepeatWrapping
	texture.repeat.set(repeat, repeat)
	texture.anisotropy = 8
	texture.colorSpace = THREE.SRGBColorSpace
	return texture
}

/** Builds the scene's meshes under one root (the TAA tracked object) and returns the knot for the motion adapter. */
export function createPicketsModel() {
	const root = new THREE.Group()
	root.name = "pickets-scene"

	const floor = new THREE.Mesh(
		new THREE.PlaneGeometry(120, 120),
		new THREE.MeshStandardMaterial({ map: createGridTexture(12), roughness: 0.85 }),
	)
	floor.name = "floor"
	floor.rotation.x = -Math.PI / 2
	root.add(floor)

	const knot = new THREE.Mesh(
		new THREE.TorusKnotGeometry(1.0, 0.3, 200, 26),
		new THREE.MeshStandardMaterial({ color: 0xc0c8d8, metalness: 0.9, roughness: 0.22 }),
	)
	knot.name = "knot"
	knot.position.set(0, 2.2, -1)
	root.add(knot)

	const picket = new THREE.BoxGeometry(0.08, 2.2, 0.3)
	const pickets = new THREE.Mesh(
		mergeGeometries(Array.from({ length: 48 }, (_, i) => picket.clone().translate(-9.4 + i * 0.4, 1.1, 3.2))),
		new THREE.MeshStandardMaterial({ color: 0xd8b46a, roughness: 0.6 }),
	)
	picket.dispose()
	pickets.name = "pickets"
	root.add(pickets)

	return { root, knot }
}

export class PicketsSceneManager extends ThreeSceneManager {
	setupCamera() {
		this.camera = new THREE.PerspectiveCamera(50, 2, 0.1, 200)
		this.camera.position.set(7, 5, 10)
	}

	// three's stock OrbitControls, as in the example: damping, auto orbit at 0.5 (the motion adapter drives both)
	setupControls() {
		this.controls = new OrbitControls(this.camera, this.inputElement)
		this.controls.target.set(0, 1.6, 0)
		this.controls.enableDamping = true
		this.controls.autoRotate = true
		this.controls.autoRotateSpeed = 0.5
		this.controls.update()
	}

	setupScene() {
		this.scene = new THREE.Scene()
		this.scene.background = new THREE.Color(0x10141a)
		// props.ts addStudioLighting
		const sun = new THREE.DirectionalLight(0xfff2df, 3.2)
		sun.position.set(8, 14, 6)
		this.scene.add(sun)
		this.scene.add(new THREE.HemisphereLight(0x9fb4d4, 0x2a2620, 0.9))
	}

	async loadModel() {
		const { root, knot } = createPicketsModel()
		this.knot = knot
		await this.addModel(root)
	}

	// The example keeps its own texture settings (8x anisotropy); the viewer would raise them to the device maximum
	optimizeModelTextures() {}

	// Free camera: nothing to reframe on resize
	fitCamera() {}

	// Like the example, the controls advance by frame rather than by time (OrbitControls.update() without a delta), so
	// auto orbit and damping match it frame for frame
	updateScene() {
		this.clock.getDelta()
		this.controls.update()
	}
}

export function init(data) {
	return new PicketsSceneManager(data)
}
