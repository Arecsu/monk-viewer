// The AA lab panel, shared by every lab page. A page supplies the manager (the viewer, or a subclass with its own
// scene), the manager options and a motion adapter; everything else (toggles, sliders, presets, hotkeys, the state
// line) is the same, so labs with different scenes compare the same settings.
//
// Query parameters: ?mode=taa (default) | taa+smaa | tmr4 (TAA off) | tmr4+smaa; ?smaa=0 builds the pipeline without
// the SMAA pass, ?clamp=0 starts with the grazing clamp off, ?fixed=1 (or the older ?live=0) pins the deterministic
// 900x600 @1x framebuffer used for measurement runs. Without it the canvas fills the viewport at the device pixel
// ratio. ?preset=legacy starts with the previous TAA settings instead of the modern ones. ?backend=auto|webgl|webgpu.
// Hotkeys: M MSAA, T TAA, S SMAA, C static convergence, G grazing clamp, J jitter compensation,
// F adaptive filter, N 3x3 neighbourhood, D depth validation, L thin feature locks, E edge blend,
// A specular AA, B motion blur, O bloom, K GT7 tone mapping, U temporal upscaling on/off (WebGPU), V cycle the debug view, R reset history, P hide/show the panel.

import * as THREE from "three"
import "./lab-panel.css"
import { benchmarkFrames } from "./benchmark.js"

const panelMarkup = (title, motion) => `
  <button id="show-panel" class="hidden">controls</button>
  <div id="panel">
    <header>
      <h1>${title}</h1>
      <div class="toggles"><button id="hide-panel">hide</button></div>
    </header>

    <h2>Renderer</h2>
    <div class="row"><label for="backend">backend</label><select id="backend">
      <option value="auto">auto (WebGPU if available)</option><option value="webgl">WebGL reference</option><option value="webgpu">native WebGPU</option>
    </select></div>
    <div id="backend-status">initializing</div>

    <h2>Motion</h2>
    <div class="row">
      <label for="motion-mode">motion</label>
      <select id="motion-mode">
        ${motion.modes.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}
      </select>
    </div>
    ${(motion.sliders ?? [{ id: "speed", ...motion.speed }]).map((slider) => `
      <div class="row">
        <label for="motion-${slider.id}">${slider.label}</label>
        <input id="motion-${slider.id}" type="range" min="${slider.min}" max="${slider.max}" step="${slider.step}" />
        <output id="motion-${slider.id}-out"></output>
      </div>`).join("")}

    <h2>Toggles</h2>
    <div class="toggles" id="toggles"></div>

    <h2>Modern TAA</h2>
    <div class="row">
      <label for="preset">preset</label>
      <select id="preset">
        <option value="modern">modern</option>
        <option value="legacy">legacy (previous)</option>
      </select>
    </div>
    <div class="toggles" id="modern-toggles"></div>
    <div class="row">
      <label for="box-mode">clamp box</label>
      <select id="box-mode">
        <option value="variance">mean ± Γσ</option>
        <option value="minmax">min/max × Γ</option>
        <option value="intersection">variance ∩ min/max</option>
      </select>
    </div>
    <div class="row">
      <label for="debug-view">debug view</label>
      <select id="debug-view">
        <option value="0">off</option>
        <option value="1">locks (red)</option>
        <option value="2">depth: trusted / disoccluded</option>
        <option value="3">glass mask (blue)</option>
        <option value="4">motion (red x, green y) + blend (blue)</option>
      </select>
    </div>
    <div id="modern"></div>

    <h2>Temporal upscaling</h2>
    <div class="toggles" id="upscale-presets"></div>
    <div id="upscale"></div>
    <div id="upscale-state" class="note"></div>

    <h2>Motion blur</h2>
    <div class="toggles" id="blur-toggles"></div>
    <div id="blur"></div>

    <h2>Specular AA</h2>
    <div id="specular"></div>

    <h2>Tone mapping</h2>
    <div class="toggles" id="tonemapping-toggles"></div>
    <div id="tonemapping"></div>

    <h2>Edge resolve</h2>
    <div class="row">
      <label for="resolve-encoding">MSAA curve</label>
      <select id="resolve-encoding">
        <option value="rgb">per channel</option>
        <option value="max">max channel (keeps hue)</option>
        <option value="linear">off (plain MSAA)</option>
      </select>
    </div>
    <div id="resolve"></div>

    <h2>Temporal</h2>
    <div id="temporal"></div>

    <h2>Spatial</h2>
    <div id="spatial"></div>

    <h2>Performance</h2>
    <div class="toggles" id="performance-toggles"></div>
    <div class="note">Specialized TAA shader: builds the current toggle settings into the TAA shader so disabled features cost nothing. Same image; each new combination compiles once.</div>
    <div id="performance"></div>
    <div class="row">
      <label>quick</label>
      <div class="toggles">
        <button id="half-res">½ resolution</button>
        <button id="benchmark" title="Pauses the loop and renders frames back to back: the frame cost without vsync">benchmark</button>
      </div>
    </div>
    <div id="benchmark-result"></div>

    <div class="buttons">
      <button id="reset">reset history</button>
      <button id="copy">copy settings</button>
    </div>

    <div id="state"></div>
  </div>`

/**
 * Starts a lab page.
 *
 * @param {Object} lab
 * @param {Function} lab.init - Creates the manager from the options, e.g. renderer.js `init`.
 * @param {Object} lab.options - Scene-specific manager options (model, environment, camera distances...).
 * @param {Object} lab.motion - `{ modes: [[value, label]], defaultMode, speed: {label, min, max, step, value, format},
 *   sliders: [{id, label, min, max, step, value, format}], apply(mgr, state, dt), modeChanged?(mgr, state) }`.
 *   Use `speed` for one slider or `sliders` for multiple named controls. `apply` runs after the manager's scene update.
 * @param {string} [lab.title] - Panel heading.
 * @param {Object} [lab.grading] - GT7 tone mapping values applied on load, for scenes lit differently.
 * @param {number} [lab.maxPixelRatio] - Caps the device pixel ratio of live (non-fixed) runs.
 */
export function startAaLab({ init, options, motion, title = "TAA lab", grading = null, maxPixelRatio = Infinity }) {
	window.THREE = THREE
	document.body.insertAdjacentHTML("beforeend", panelMarkup(title, motion))

	const params = new URLSearchParams(location.search)
	// A literal "+" in a query string decodes as a space
	const mode = (params.get("mode") ?? "taa").replace(" ", "+")
	const fixed = params.get("fixed") === "1" || params.get("live") === "0"
	const live = !fixed
	window.mode = mode
	if (fixed) document.body.classList.add("fixed")

	// The ratio the page asked for; the resolution slider scales it.
	const nativeRatio = live ? Math.min(window.devicePixelRatio, maxPixelRatio) : 1

	const canvas = document.getElementById("c")
	const mgr = window.mgr = init({
		canvas,
		inputElement: canvas,
		pixelRatio: nativeRatio,
		backend: params.get('backend') ?? 'auto',
		initDelay: 0,
		initDelayInteractive: 0,
		startup: "auto",
		lowPerformanceSettings: { disableMSAA: false, lowResolution: false },
		smaa: params.get("smaa") !== "0",
		grazingSpecularClamp: params.get("clamp") !== "0",
		perfSampling: { stabilityDuration: 0, measureDuration: 0.1 },
		...options,
		e_backend: status => {
			document.getElementById('backend-status').textContent = `${status.selected ?? 'pending'} · ${status.phase} · ${status.reason ?? ''}`
		},
		e_error: error => {
			window.lastRendererError = error
			document.getElementById('backend-status').textContent = `FAILED: ${error.message}`
			console.error('AA lab renderer failed', error)
		},
		e_loaded: () => {
			if (!mode.startsWith("taa")) window.mgr.taa.enabled = false
			if (window.mgr.smaaPass) window.mgr.smaaPass.enabled = mode.endsWith("+smaa")
			if (grading) Object.assign(mgr.gt7ToneMapping, grading)
			window.loaded = true
			applyPreset(params.get("preset") === "legacy" ? "legacy" : "modern")
			setupPanel()
		},
	})

	document.getElementById('backend').value = params.get('backend') ?? 'auto'
	document.getElementById('backend').addEventListener('change', event => {
		const url = new URL(location.href)
		url.searchParams.set('backend', event.target.value)
		// New document/canvas, never bind WebGL to a WebGPU-bound canvas or vice versa.
		location.href = url.href
	})

	// The lab compares settings, so it must not be auto-tuned mid-comparison. The normal loop is started directly,
	// skipping the FPS measurement that drops MSAA and the pixel ratio on slower machines.
	mgr.startPerformanceSamplingLoop = () => {
		mgr.clock.start()
		mgr.setupInteraction()
		mgr.e_loaded(true)
		mgr.isRendering = true
		mgr.startRenderLoop()
	}

	// --- Motion, so the same pose can be compared while still and while moving --------------------------------
	// The built-in auto-rotation is replaced by the page's motion adapter, which the panel controls, so still frames
	// converge and moving frames are reproducible.
	const motionSliders = motion.sliders ?? [{ id: "speed", ...motion.speed }]
	const motionState = { mode: motion.defaultMode, ...Object.fromEntries(motionSliders.map((slider) => [slider.id, slider.value])) }
	let lastMotionTime = performance.now()
	mgr.canAnimate = () => false

	// Manual orbit from the start: the viewer normally needs a click to enter interactive mode, which also swaps in
	// its own model animations. The panel drives motion explicitly instead.
	mgr.isInteractive = true
	mgr.controls.enabled = true
	mgr.toggleInteractiveMode = () => {}

	// Changing the ratio goes through the renderer's own resize path, so the pipeline, the TAA history and the camera
	// projection all stay consistent.
	let resolutionScale = 1
	let resolutionBackup = 1
	const applyResolutionScale = (scale) => {
		resolutionScale = scale
		mgr.performantRenderPixelRatio = nativeRatio * scale
	}

	const updateScene = mgr.updateScene.bind(mgr)
	mgr.updateScene = () => {
		updateScene()
		if (!window.loaded) return
		const now = performance.now()
		const dt = Math.min((now - lastMotionTime) / 1000, 0.1)
		lastMotionTime = now
		motion.apply(mgr, motionState, dt)
	}

	// --- Panel ------------------------------------------------------------------------------------------------
	const $ = (id) => document.getElementById(id)
	const panel = $("panel")
	const toggleButtons = new Map()
	const sliderRows = new Map()

	const T = () => mgr.taa
	// Temporal upscaling exists on the native WebGPU pipeline only
	const canUpscale = () => typeof mgr.pipeline?.renderScale === "number"
	// FSR's quality modes, as output / render ratios
	const upscalePresets = [["native", 1], ["1.5× quality", 1 / 1.5], ["1.7× balanced", 1 / 1.7], ["2× performance", 1 / 2], ["3× ultra", 1 / 3]]
	const setUpscale = (scale) => { if (canUpscale()) mgr.pipeline.renderScale = scale }
	let upscaleBackup = 0.5
	// The bloom effect on WebGL, its controls on WebGPU: both have enabled and backgroundFastPath, and skip every bloom
	// pass while disabled
	const bloom = () => mgr.pipeline.passes.find(p => p.effects).effects[0]

	const toggles = [
		["taa", "TAA", () => T().enabled, (v) => { T().enabled = v }],
		["background", "TAA bounds", () => T().backgroundFastPath, (v) => { T().backgroundFastPath = v; T().reset() }],
		["bloomBounds", "bloom bounds", () => bloom().backgroundFastPath, (v) => { bloom().backgroundFastPath = v }],
		["msaa", "MSAA", () => mgr.geometryPass.samples > 0, (v) => {
			mgr.geometryPass.samples = v ? mgr.msaaSamples : 0
			T().reset()
		}],
		["smaa", "SMAA", () => !!mgr.smaaPass?.enabled, (v) => { if (mgr.smaaPass) mgr.smaaPass.enabled = v }],
		["clamp", "grazing clamp", () => mgr.grazingClamp.enabled, (v) => { mgr.grazingClamp.enabled = v }],
		["static", "static convergence", () => T().staticConvergence, (v) => { T().staticConvergence = v; T().reset() }],
		["jitterComp", "jitter compensation", () => T().jitterCompensation, (v) => { T().jitterCompensation = v; T().reset() }],
		["motionFilter", "adaptive filter", () => T().motionFilterScale > 0, (v) => { T().motionFilterScale = v ? motionFilterScaleBackup : 0; T().reset() }],
		["clampHistory", "clamp history", () => T().clampHistory, (v) => { T().clampHistory = v; T().reset() }],
	]

	// The techniques added for thin bright edges in motion. Each one is independent, so they can be compared one by
	// one against the rest.
	const modernToggles = [
		["neighbourhood", "3×3 clamp", () => T().neighbourhood === 9, (v) => { T().neighbourhood = v ? 9 : 5 }],
		["clipTowards", "clip → current", () => T().clipTowardsCurrent, (v) => { T().clipTowardsCurrent = v }],
		["depthRejection", "depth validation", () => T().depthRejection, (v) => { T().depthRejection = v; T().reset() }],
		["motionRejection", "motion validation", () => T().motionRejection, (v) => { T().motionRejection = v }],
		["locks", "thin feature locks", () => T().thinFeatureLocks, (v) => { T().thinFeatureLocks = v; T().reset() }],
		["edgeBlend", "edge blend", () => T().edgeAdaptiveBlend, (v) => { T().edgeAdaptiveBlend = v }],
		["confidence", "sample confidence", () => T().sampleConfidence, (v) => { T().sampleConfidence = v }],
		["velocity", "velocity buffer", () => T().velocityBuffer !== null, (v) => { T().velocityBuffer = v ? mgr.velocityBuffer : null }],
		["reactive", "glass mask", () => T().reactiveMask !== null, (v) => setReactiveMask(v)],
		["motionBlur", "motion blur", () => !!mgr.motionBlurPass?.enabled, (v) => { mgr.motionBlurPass.enabled = v }],
		["bloom", "bloom", () => bloom().enabled, (v) => { bloom().enabled = v }],
		["specularAA", "specular AA", () => mgr.specularAA.enabled, (v) => { mgr.specularAA.enabled = v }],
	]

	// The transparent objects' mask from the resolve pass: no locks, no relaxed clamp, no edge blend on glass
	const setReactiveMask = (v) => {
		if (!mgr.resolvePass) return
		mgr.resolvePass.reactiveMaskEnabled = v
		T().reactiveMask = v ? mgr.resolvePass.reactiveMask : null
	}

	// Previous behaviour, and the combination of all the new techniques. The legacy values are the pass defaults.
	const presets = {
		legacy: {
			neighbourhood: 5, boxMode: "variance", clipTowardsCurrent: false, depthRejection: false, motionRejection: false,
			thinFeatureLocks: false, edgeAdaptiveBlend: false, sampleConfidence: false,
			trustedGamma: 2.0, depthTolerance: 0.0015, motionTolerance: 1.0, disocclusionBlend: 0.35, lockFrames: 8, lockSimilarity: 0.75,
			lockStrength: 1.0, lockMaxSpeed: 0, edgeBlend: 0.08, varianceGamma: 1.0, blend: 0.2,
			specularAA: false, grazingClamp: true, reactive: false, motionBlur: false, velocity: false,
		},
		modern: {
			neighbourhood: 9, boxMode: "variance", clipTowardsCurrent: true, depthRejection: true, motionRejection: true,
			thinFeatureLocks: true, edgeAdaptiveBlend: true, sampleConfidence: true,
			trustedGamma: 2.0, depthTolerance: 0.0015, motionTolerance: 1.0, disocclusionBlend: 0.35, lockFrames: 4, lockSimilarity: 0.75,
			lockStrength: 1.0, lockMaxSpeed: 12, edgeBlend: 0.08, varianceGamma: 1.0, blend: 0.15,
			specularAA: true, grazingClamp: false, reactive: true, motionBlur: true, velocity: true,
		},
	}

	const applyPreset = (name) => {
		const { specularAA, grazingClamp, reactive, motionBlur, velocity, ...taa } = presets[name]
		T().velocityBuffer = velocity ? mgr.velocityBuffer : null
		Object.assign(T(), taa)
		mgr.specularAA.enabled = specularAA
		mgr.grazingClamp.enabled = grazingClamp
		setReactiveMask(reactive)
		if (mgr.motionBlurPass) mgr.motionBlurPass.enabled = motionBlur
		T().reset()
	}

	let motionFilterScaleBackup = 1

	const sliders = [
		["temporal", "blend", "new frame", 0.02, 0.8, 0.01, 2,
			() => T().blend, (v) => { T().blend = v }],
		["temporal", "staticBlend", "still frame", 0.002, 0.2, 0.002, 3,
			() => T().staticBlend, (v) => { T().staticBlend = v }],
		["temporal", "varianceGamma", "clamp Γ", 0.25, 4, 0.05, 2,
			() => T().varianceGamma, (v) => { T().varianceGamma = v }],
		["spatial", "filterSharpness", "k still", 0.5, 8, 0.1, 1,
			() => T().filterSharpness, (v) => { T().filterSharpness = v }],
		["spatial", "motionFilterSharpness", "k moving", 0.5, 8, 0.1, 1,
			() => T().motionFilterSharpness, (v) => { T().motionFilterSharpness = v }],
		["spatial", "motionFilterScale", "adaptive rate", 0, 2, 0.05, 2,
			() => T().motionFilterScale, (v) => {
				motionFilterScaleBackup = Math.max(v, 0.05)
				T().motionFilterScale = v
			}],
		["spatial", "jitterScale", "jitter px", 0, 1.5, 0.05, 2,
			() => T().jitterScale, (v) => { T().jitterScale = v; T().reset() }],
		["spatial", "jitterSamples", "jitter samples", 2, 16, 1, 0,
			() => T().jitterSamples, (v) => { T().jitterSamples = v; T().reset() }],
		["modern", "trustedGamma", "Γ trusted", 0.5, 6, 0.05, 2,
			() => T().trustedGamma, (v) => { T().trustedGamma = v }],
		["modern", "depthTolerance", "depth tol", 0.0005, 0.03, 0.0005, 4,
			() => T().depthTolerance, (v) => { T().depthTolerance = v }],
		["modern", "motionTolerance", "motion tol px", 0.25, 8, 0.25, 2,
			() => T().motionTolerance, (v) => { T().motionTolerance = v }],
		["modern", "disocclusionBlend", "disocclusion", 0.05, 1, 0.01, 2,
			() => T().disocclusionBlend, (v) => { T().disocclusionBlend = v }],
		["modern", "lockFrames", "lock frames", 1, 32, 1, 0,
			() => T().lockFrames, (v) => { T().lockFrames = v }],
		["modern", "lockSimilarity", "lock similarity", 0.3, 0.98, 0.01, 2,
			() => T().lockSimilarity, (v) => { T().lockSimilarity = v }],
		["modern", "lockStrength", "lock strength", 0, 1, 0.05, 2,
			() => T().lockStrength, (v) => { T().lockStrength = v }],
		["modern", "edgeBlend", "edge blend", 0.01, 0.4, 0.01, 2,
			() => T().edgeBlend, (v) => { T().edgeBlend = v }],
		["modern", "lockMaxSpeed", "lock max px/f", 0, 40, 1, 0,
			() => T().lockMaxSpeed, (v) => { T().lockMaxSpeed = v }],
		["blur", "shutter", "shutter", 0.05, 1, 0.05, 2,
			() => mgr.motionBlurPass.shutter, (v) => { mgr.motionBlurPass.shutter = v }],
		["blur", "maxBlur", "max blur", 0.005, 0.08, 0.005, 3,
			() => mgr.motionBlurPass.maxBlur, (v) => { mgr.motionBlurPass.maxBlur = v }],
		["blur", "blurSamples", "samples", 4, 32, 1, 0,
			() => mgr.motionBlurPass.samples, (v) => { mgr.motionBlurPass.samples = v }],
		["blur", "softDepth", "soft depth", 0.001, 0.1, 0.001, 3,
			() => mgr.motionBlurPass.softDepth, (v) => { mgr.motionBlurPass.softDepth = v }],
		["specular", "specularVariance", "variance", 0, 1, 0.01, 2,
			() => mgr.specularAA.variance, (v) => { mgr.specularAA.variance = v }],
		["specular", "specularThreshold", "threshold", 0, 1, 0.01, 2,
			() => mgr.specularAA.threshold, (v) => { mgr.specularAA.threshold = v }],
		["tonemapping", "gt7Exposure", "exposure", 0.5, 8, 0.05, 2,
			() => mgr.gt7ToneMapping.exposure, (v) => { mgr.gt7ToneMapping.exposure = v }],
		["tonemapping", "gt7Contrast", "contrast", 0.5, 2, 0.01, 2,
			() => mgr.gt7ToneMapping.contrast, (v) => { mgr.gt7ToneMapping.contrast = v }],
		// Shadows
		["tonemapping", "gt7BlackPoint", "black point", -0.15, 0.15, 0.005, 3,
			() => mgr.gt7ToneMapping.blackPoint, (v) => { mgr.gt7ToneMapping.blackPoint = v }],
		["tonemapping", "gt7Toe", "shadow toe", 0.5, 2.5, 0.01, 2,
			() => mgr.gt7ToneMapping.shadowToe, (v) => { mgr.gt7ToneMapping.shadowToe = v }],
		["tonemapping", "gt7ToeLength", "toe length", 0.05, 1.1, 0.01, 2,
			() => mgr.gt7ToneMapping.toeLength, (v) => { mgr.gt7ToneMapping.toeLength = v }],
		// Highlights
		["tonemapping", "gt7Shoulder", "shoulder start", 0.1, 0.9, 0.01, 2,
			() => mgr.gt7ToneMapping.shoulderStart, (v) => { mgr.gt7ToneMapping.shoulderStart = v }],
		["tonemapping", "gt7Hardness", "highlight hardness", -1, 0.9, 0.01, 2,
			() => mgr.gt7ToneMapping.highlightHardness, (v) => { mgr.gt7ToneMapping.highlightHardness = v }],
		["tonemapping", "gt7Chroma", "chroma preservation", 0, 1, 0.01, 2,
			() => mgr.gt7ToneMapping.chromaPreservation, (v) => { mgr.gt7ToneMapping.chromaPreservation = v }],
		// Colour
		["tonemapping", "gt7Saturation", "saturation", 0, 2, 0.01, 2,
			() => mgr.gt7ToneMapping.saturation, (v) => { mgr.gt7ToneMapping.saturation = v }],
		["tonemapping", "gt7Vibrance", "vibrance", -1, 1, 0.01, 2,
			() => mgr.gt7ToneMapping.vibrance, (v) => { mgr.gt7ToneMapping.vibrance = v }],
		// The curve that MSAA samples and the TAA history are averaged through, see TonemappedResolvePass
		["resolve", "resolveExposure", "MSAA exposure", 0.1, 8, 0.05, 2,
			() => mgr.resolvePass?.exposure ?? 0, (v) => { if (mgr.resolvePass) mgr.resolvePass.exposure = v }],
		["resolve", "taaExposure", "TAA exposure", 0.1, 8, 0.05, 2,
			() => T().exposure, (v) => { T().exposure = v }],
		// Internal render resolution, reconstructed to the output by TAA
		["upscale", "upscaleScale", "render scale", 0.33, 1, 0.01, 2,
			() => canUpscale() ? mgr.pipeline.renderScale : 1, (v) => setUpscale(v)],
		["upscale", "upscaleFloor", "min weight", 0, 0.5, 0.01, 2,
			() => T().upscaleConfidenceFloor ?? 0, (v) => { if (canUpscale()) T().upscaleConfidenceFloor = v }],
		// The canvas resolution itself: everything, output included, scales with it
		["performance", "resolution", "canvas scale", 0.3, 1.5, 0.05, 2,
			() => resolutionScale, (v) => {
				// Remember what to return to when the half resolution shortcut is switched off
				if (v !== 0.5) resolutionBackup = v
				applyResolutionScale(v)
			}],
	]

	// Optimizations that keep the image: A/B them against the plain versions
	const blurToggles = [
		["adaptiveBlur", "adaptive samples", () => !!mgr.motionBlurPass?.adaptiveSamples,
			(v) => { mgr.motionBlurPass.adaptiveSamples = v }],
	]
	const performanceToggles = [
		["specialize", "specialized TAA shader", () => !!T().specializeShader,
			(v) => { if ("specializeShader" in T()) T().specializeShader = v }],
	]

	// GT7 against the previous Reinhard, both kept in the effect chain
	const toneMappingToggles = [
		["gt7", "GT7 (off: Reinhard)", () => mgr.gt7ToneMapping.enabled, (v) => {
			mgr.gt7ToneMapping.enabled = v
			mgr.reinhardToneMapping.enabled = !v
		}],
	]

	const createToggle = ([key, label, get, set], container = "toggles") => {
		const button = document.createElement("button")
		button.textContent = label
		button.addEventListener("click", () => { if (!button.disabled) { set(!get()); refresh() } })
		toggleButtons.set(key, { button, get })
		$(container).append(button)
		return button
	}

	const createSlider = ([target, key, label, min, max, step, decimals, get, set]) => {
		const row = document.createElement("div")
		row.className = "row"
		const labelEl = document.createElement("label")
		labelEl.textContent = label
		labelEl.htmlFor = `sl-${key}`
		const input = document.createElement("input")
		input.id = `sl-${key}`
		input.type = "range"
		input.min = min
		input.max = max
		input.step = step
		const output = document.createElement("output")
		input.addEventListener("input", () => { set(Number(input.value)); refresh() })
		row.append(labelEl, input, output)
		$(target).append(row)
		sliderRows.set(key, { input, output, decimals, get })
	}

	const fps = { frames: 0, since: performance.now(), value: 0 }
	const tickFps = () => {
		const now = performance.now()
		++fps.frames
		if (now - fps.since >= 500) {
			fps.value = Math.round(fps.frames * 1000 / (now - fps.since))
			fps.frames = 0
			fps.since = now
			refresh()
		}
		requestAnimationFrame(tickFps)
	}

	const copyableSettings = () => ({
		blend: T().blend,
		staticBlend: T().staticBlend,
		varianceGamma: T().varianceGamma,
		filterSharpness: T().filterSharpness,
		motionFilterSharpness: T().motionFilterSharpness,
		motionFilterScale: T().motionFilterScale,
		jitterScale: T().jitterScale,
		jitterSamples: T().jitterSamples,
		jitterCompensation: T().jitterCompensation,
		staticConvergence: T().staticConvergence,
		clampHistory: T().clampHistory,
		backgroundFastPath: T().backgroundFastPath,
		neighbourhood: T().neighbourhood,
		boxMode: T().boxMode,
		clipTowardsCurrent: T().clipTowardsCurrent,
		depthRejection: T().depthRejection,
		depthTolerance: T().depthTolerance,
		motionRejection: T().motionRejection,
		motionTolerance: T().motionTolerance,
		trustedGamma: T().trustedGamma,
		disocclusionBlend: T().disocclusionBlend,
		thinFeatureLocks: T().thinFeatureLocks,
		lockFrames: T().lockFrames,
		lockSimilarity: T().lockSimilarity,
		lockStrength: T().lockStrength,
		edgeAdaptiveBlend: T().edgeAdaptiveBlend,
		edgeBlend: T().edgeBlend,
		sampleConfidence: T().sampleConfidence,
		lockMaxSpeed: T().lockMaxSpeed,
		velocityBuffer: T().velocityBuffer !== null,
		reactiveMask: T().reactiveMask !== null,
		motionBlur: { enabled: mgr.motionBlurPass.enabled, adaptiveSamples: mgr.motionBlurPass.adaptiveSamples, shutter: mgr.motionBlurPass.shutter,
			maxBlur: mgr.motionBlurPass.maxBlur, samples: mgr.motionBlurPass.samples, softDepth: mgr.motionBlurPass.softDepth },
		bloom: { enabled: bloom().enabled, backgroundFastPath: bloom().backgroundFastPath },
		specularAntialiasing: { enabled: mgr.specularAA.enabled, variance: mgr.specularAA.variance, threshold: mgr.specularAA.threshold },
		grazingSpecularClamp: mgr.grazingClamp.enabled,
		toneMapping: { gt7: mgr.gt7ToneMapping.enabled, ...Object.fromEntries(["exposure", "contrast", "blackPoint",
			"shadowToe", "toeLength", "shoulderStart", "highlightHardness", "chromaPreservation", "saturation", "vibrance"].map((k) => [k, mgr.gt7ToneMapping[k]])) },
		specializedTaaShader: T().specializeShader ?? null,
		upscaling: canUpscale() ? { renderScale: mgr.pipeline.renderScale, minWeight: T().upscaleConfidenceFloor } : null,
		edgeResolve: { encoding: mgr.resolvePass?.encoding, msaaExposure: mgr.resolvePass?.exposure, taaExposure: T().exposure },
	})

	const refresh = () => {
		const t = T()
		const uniforms = t.fullscreenMaterial.uniforms

		for (const [, { button, get }] of toggleButtons) {
			button.disabled = false
			button.classList.toggle("on", !!get())
		}
		$("half-res").classList.toggle("on", resolutionScale === 0.5)
		for (const button of $("upscale-presets").children) {
			button.disabled = !canUpscale()
			button.classList.toggle("on", canUpscale() && Math.abs(mgr.pipeline.renderScale - Number(button.dataset.scale)) < 1e-3)
		}
		if (canUpscale()) {
			const p = mgr.pipeline
			$("upscale-state").innerHTML = p.renderScale < 1 ?
				`render <b>${p.renderWidth}×${p.renderHeight}</b> → <b>${p.pixelWidth}×${p.pixelHeight}</b>` +
				` (${(p.pixelWidth / p.renderWidth).toFixed(2)}×) · <b>${t.jitterPhases}</b> jitter phases` :
				`native: render = output (${p.pixelWidth}×${p.pixelHeight})`
		} else {
			$("upscale-state").textContent = "native WebGPU backend only"
		}
		$("box-mode").value = t.boxMode
		$("resolve-encoding").value = mgr.resolvePass?.encoding ?? "linear"
		$("resolve-encoding").disabled = !mgr.resolvePass
		$("debug-view").value = String(t.debugView)
		const smaa = toggleButtons.get("smaa").button
		smaa.disabled = !mgr.smaaPass
		// Native WebGPU only
		toggleButtons.get("specialize").button.disabled = !("specializeShader" in t)
		for (const slider of motionSliders) {
			$(`motion-${slider.id}-out`).textContent = slider.format(motionState[slider.id])
			$(`motion-${slider.id}`).value = motionState[slider.id]
		}

		for (const [key, { input, output, decimals, get }] of sliderRows) {
			const value = get()
			if (document.activeElement !== input) input.value = value
			if (key.startsWith("upscale")) input.disabled = !canUpscale()
			output.textContent = key === "resolution" ? `${value.toFixed(2)}×` :
				(decimals === 0 ? String(Math.round(value)) : value.toFixed(decimals))
		}

		const still = t.staticConvergence && t.stillFrames > 0
		$("state").innerHTML =
			`<b>${mgr.geometryPass.samples}x</b> MSAA · TAA <b>${t.enabled ? "on" : "off"}</b>` +
			` · blend <b>${uniforms.blend.value.toFixed(3)}</b>${still ? ` (still ${t.stillFrames}f)` : ""}` +
			` · Γ <b>${t.varianceGamma.toFixed(2)}</b>` +
			` · k <b>${t.filterSharpness.toFixed(1)}</b>→<b>${t.motionFilterSharpness.toFixed(1)}</b>` +
			` · jitter <b>${t.jitterScale.toFixed(2)}px×${t.jitterSamples}</b><br>` +
			`jitter comp <b>${t.jitterCompensation ? "on" : "off"}</b>` +
			` · clamp <b>${uniforms.clipHistory.value ? "on" : "off"}</b>` +
			` · SMAA <b>${mgr.smaaPass?.enabled ? "on" : "off"}</b><br>` +
			`box <b>${t.neighbourhood === 9 ? "3×3" : "cross"} ${t.boxMode}</b>` +
			` · Γ trusted <b>${t.depthRejection ? t.trustedGamma.toFixed(2) : "–"}</b>` +
			` · specular AA <b>${mgr.specularAA.enabled ? "on" : "off"}</b><br>` +
			`res <b>${resolutionScale.toFixed(2)}×</b> (${mgr.renderer.domElement.width}×${mgr.renderer.domElement.height})` +
			` · <b>${fps.value}</b> fps`
	}

	const setupPanel = () => {
		toggles.forEach((t) => createToggle(t))
		modernToggles.forEach((t) => createToggle(t, "modern-toggles"))
		toneMappingToggles.forEach((t) => createToggle(t, "tonemapping-toggles"))
		blurToggles.forEach((t) => createToggle(t, "blur-toggles"))
		performanceToggles.forEach((t) => createToggle(t, "performance-toggles"))
		sliders.forEach(createSlider)

		for (const [label, scale] of upscalePresets) {
			const button = document.createElement("button")
			button.textContent = label
			button.dataset.scale = String(scale)
			button.addEventListener("click", () => { setUpscale(scale); refresh() })
			$("upscale-presets").append(button)
		}

		$("preset").value = params.get("preset") === "legacy" ? "legacy" : "modern"
		$("preset").addEventListener("change", (e) => { applyPreset(e.target.value); refresh() })
		$("box-mode").addEventListener("change", (e) => { T().boxMode = e.target.value; refresh() })
		$("resolve-encoding").addEventListener("change", (e) => { if (mgr.resolvePass) mgr.resolvePass.encoding = e.target.value; refresh() })
		$("debug-view").addEventListener("change", (e) => { T().debugView = Number(e.target.value); refresh() })

		$("motion-mode").value = motionState.mode
		$("motion-mode").addEventListener("change", (e) => {
			motionState.mode = e.target.value
			lastMotionTime = performance.now()
			motion.modeChanged?.(mgr, motionState)
			T().reset()
			refresh()
		})
		for (const slider of motionSliders) {
			$(`motion-${slider.id}`).addEventListener("input", (e) => {
				motionState[slider.id] = Number(e.target.value)
				refresh()
			})
			$(`motion-${slider.id}`).value = motionState[slider.id]
		}

		$("reset").addEventListener("click", () => { T().reset(); refresh() })
		$("half-res").addEventListener("click", () => {
			const half = resolutionScale === 0.5
			applyResolutionScale(half ? resolutionBackup : 0.5)
			refresh()
		})
		$("benchmark").addEventListener("click", async () => {
			const button = $("benchmark")
			if (button.disabled) return
			button.disabled = true
			$("benchmark-result").textContent = "measuring…"
			try {
				const result = window.lastBenchmark = await benchmarkFrames(mgr)
				const { width, height } = mgr.renderer.domElement
				const upscaled = canUpscale() && mgr.pipeline.renderScale < 1 ?
					` from ${mgr.pipeline.renderWidth}×${mgr.pipeline.renderHeight}` : ""
				$("benchmark-result").innerHTML =
					`<b>${result.msPerFrame.toFixed(2)} ms</b>/frame ≈ <b>${Math.round(result.fps)}</b> fps uncapped` +
					` · cpu ${result.cpuMsPerFrame.toFixed(2)} ms · ${width}×${height}${upscaled}, ${result.frames}f×${result.rounds.length}`
			} catch (error) {
				$("benchmark-result").textContent = `benchmark failed: ${error.message}`
			} finally {
				button.disabled = false
			}
		})
		$("copy").addEventListener("click", async () => {
			const json = JSON.stringify(copyableSettings(), null, 2)
			console.log(json)
			try {
				await navigator.clipboard.writeText(json)
				$("state").innerHTML += '<br><span id="copied">settings copied</span>'
			} catch (error) {
				$("state").innerHTML += '<br><span id="copied">settings logged to console</span>'
			}
		})

		$("hide-panel").addEventListener("click", togglePanel)
		$("show-panel").addEventListener("click", togglePanel)

		refresh()
		requestAnimationFrame(tickFps)
	}

	let panelHidden = false
	const togglePanel = () => {
		panelHidden = !panelHidden
		panel.classList.toggle("hidden", panelHidden)
		$("show-panel").classList.toggle("hidden", !panelHidden)
	}

	if (live) {
		// Pin full resolution: there is no auto-tuner in the lab, but the renderer's own pixel ratio logic still applies.
		window.mgr.performantRenderPixelRatio = nativeRatio
		window.addEventListener("keydown", (e) => {
			if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
			const key = e.key.toLowerCase()
			const action = {
				m: "msaa", t: "taa", s: "smaa", c: "static", g: "clamp",
				j: "jitterComp", f: "motionFilter", r: "reset", p: "panel",
				n: "neighbourhood", d: "depthRejection", l: "locks", e: "edgeBlend", a: "specularAA", v: "debug",
				b: "motionBlur", o: "bloom", k: "gt7", u: "upscale",
			}[key]
			if (action === "panel") return togglePanel()
			if (action === "upscale") {
				if (!canUpscale()) return
				const scale = mgr.pipeline.renderScale
				if (scale < 1) upscaleBackup = scale
				setUpscale(scale < 1 ? 1 : upscaleBackup)
				return refresh()
			}
			if (action === "reset") return T().reset()
			if (action === "debug") { T().debugView = (T().debugView + 1) % 5; return refresh() }
			const toggle = toggleButtons.get(action)
			if (toggle && !toggle.button.disabled) {
				const value = !toggle.get()
				const def = [...toggles, ...modernToggles, ...toneMappingToggles, ...blurToggles, ...performanceToggles]
					.find(([name]) => name === action)
				def[3](value)
				refresh()
			}
		})
	}

	return mgr
}
