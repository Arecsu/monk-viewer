import { startAaLab } from "./lab-panel.js"
import { mountLabSelection, readLabSelection } from "./lab-selection.js"

function artworkMotion() {
	let partsTime = 0
	let clipCache = null
	const clips = (mgr) => clipCache ??= (() => {
		const list = []
		mgr.model.traverse((o) => { if (o.isMesh && o.name.startsWith("CLIP")) list.push({ mesh: o, base: o.position.x }) })
		return list
	})()

	return {
		modes: [["still", "still"], ["model", "model"], ["camera", "camera"], ["both", "model + camera"], ["parts", "parts (clips slide)"]],
		defaultMode: "still",
		speed: { label: "speed °/s", min: 0, max: 720, step: 1, value: 45, format: (v) => `${v}°` },
		apply(mgr, { mode, speed }, dt) {
			const radians = (speed * Math.PI / 180) * dt
			if (mode === "model" || mode === "both") mgr.model.rotateY(-radians)
			// Drive the orbit goal so automatic motion and manual drags don't fight each other.
			if (mode === "camera" || mode === "both") mgr.controls._goalSpherical.theta -= radians
			if (mode === "parts") {
				partsTime += dt * speed / 45
				for (const { mesh, base } of clips(mgr)) mesh.position.x = base + Math.sin(partsTime * Math.PI * 2) * 0.03
			} else if (partsTime !== 0) {
				partsTime = 0
				for (const { mesh, base } of clips(mgr)) mesh.position.x = base
			}
		},
	}
}

function picketsMotion() {
	let knotTime = 0
	return {
		modes: [["both", "orbit + knot"], ["knot", "knot spins"], ["orbit", "orbit"], ["still", "still"]],
		defaultMode: "both",
		sliders: [
			{ id: "orbitSpeed", label: "orbit speed", min: 0, max: 5, step: 0.05, value: 0.5, format: (v) => v.toFixed(2) },
			{ id: "knotSpeed", label: "knot speed (rad/s)", min: 0, max: 10, step: 0.1, value: 0.5, format: (v) => v.toFixed(1) },
		],
		apply(mgr, { mode, orbitSpeed, knotSpeed }, dt) {
			mgr.controls.autoRotate = mode === "both" || mode === "orbit"
			mgr.controls.autoRotateSpeed = orbitSpeed
			if (mode === "both" || mode === "knot") knotTime += dt * knotSpeed
			if (mgr.knot) mgr.knot.rotation.y = knotTime
		},
		modeChanged(mgr, { mode }) {
			if (mode === "both" || mode === "orbit") return
			// Stop the residual damping too, so static TAA convergence can start immediately.
			mgr.controls.autoRotate = false
			mgr.controls._sphericalDelta?.set(0, 0, 0)
		},
	}
}

const selection = readLabSelection(new URLSearchParams(location.search))
const isPickets = selection.scene === "pickets"
const { init } = await (isPickets ? import("./PicketsScene.js") : import("../renderer.js"))

document.title = isPickets ? "AA lab · pickets" : "AA lab · artwork"
startAaLab({
	init,
	title: "AA lab",
	setupSceneControls: (container) => mountLabSelection(container, selection),
	motion: isPickets ? picketsMotion() : artworkMotion(),
	// Match the original pickets example's DPR cap and brighter, more saturated lighting grade.
	maxPixelRatio: isPickets ? 2 : Infinity,
	grading: isPickets ? { exposure: 2.4, saturation: 1.15 } : null,
	options: isPickets ? { envmapUrl: null } : {
		modelUrl: selection.model
			? `${import.meta.env.BASE_URL}glass-variants/${selection.model}`
			: `${import.meta.env.BASE_URL}False_Enlightenment.glb`,
		envmapUrl: `${import.meta.env.BASE_URL}${selection.environment}`,
		targetDistance: 0.8,
		minDistance: 0.3,
		maxDistance: 2.0,
	},
})
