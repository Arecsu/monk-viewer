import { init } from "./renderer.js"
import { EventDispatcher } from "three"

function noop() {}

class ElementProxyReceiver extends EventDispatcher {
	constructor(id) {
		super()
		this.id = id
		this.style = {} // because OrbitControls try to set style.touchAction;
		this.rootProxy = this
	}

	get clientWidth() {
		return this.width
	}
	get clientHeight() {
		return this.height
	}

	getRootNode() {
		return this.rootProxy
	}

	// OrbitControls call these as of r132. Maybe we should implement them
	setPointerCapture() {}
	releasePointerCapture() {}
	getBoundingClientRect() {
		return {
			left: this.left,
			top: this.top,
			width: this.width,
			height: this.height,
			right: this.left + this.width,
			bottom: this.top + this.height,
		}
	}
	handleEvent(data) {
		if (data.type === "size") {
			this.left = data.left
			this.top = data.top
			this.width = data.width
			this.height = data.height
			this.pixelRatio = data.pixelRatio
			return
		}

		data.preventDefault = noop
		data.stopPropagation = noop
		this.dispatchEvent(data)
	}

	m_interactivity(state) {
		self.postMessage({ type: "interactivity", id: this.id, state })
	}

	m_loaded(state) {
		self.postMessage({ type: "loaded", id: this.id, state })
	}

	m_ready(state) {
		self.postMessage({ type: "ready", id: this.id, state })
	}

	focus() {
		// no-op
	}
}

class ProxyManager {
	constructor() {
		this.targets = {}
		this.handleEvent = this.handleEvent.bind(this)
	}
	makeProxy(data) {
		const { id } = data
		const proxy = new ElementProxyReceiver(id)
		this.targets[id] = proxy
	}
	getProxy(id) {
		return this.targets[id]
	}
	handleEvent(data) {
		this.targets[data.id].handleEvent(data.data)
	}
}

const proxyManager = new ProxyManager()

let sceneManager;

function start(data) {
	const proxy = proxyManager.getProxy(data.canvasId)
	proxy.ownerDocument = proxy 	// HACK!
	self.document = {} 				// HACK!
	sceneManager = init({
		canvas: data.canvas,
		inputElement: proxy,
		pixelRatio: data.pixelRatio,
		modelUrl: data.modelUrl,
		envmapUrl: data.envmapUrl,
		minDistance: data.minDistance,
		targetDistance: data.targetDistance,
		maxDistance: data.maxDistance,
		initDelay: data.initDelay,
		startup: data.startup,
		initDelayInteractive: data.initDelayInteractive,
		lowPerformanceSettings: data.lowPerformanceSettings,
		perfSampling: data.perfSampling,
		e_interactivityChange: (state) => proxy.m_interactivity(state),
		e_loaded: (state) => proxy.m_loaded(state),
		e_ready: (state) => proxy.m_ready(state)
	})
}

function makeProxy(data) {
	proxyManager.makeProxy(data)
}

const handlers = {
	start,
	makeProxy,
	event: proxyManager.handleEvent,
	enableRendering: () => sceneManager.enableRendering(),
	disableRendering: () => sceneManager.disableRendering(),
	dispose: () => {
		if (sceneManager) {
		  sceneManager.dispose();
		  sceneManager = null;
		}
	},
}

self.onmessage = function (e) {
	const fn = handlers[e.data.type]
	if (typeof fn !== "function") {
		throw new Error("no handler for type: " + e.data.type)
	}
	fn(e.data)
}
