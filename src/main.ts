// @ts-ignore
import { init } from "./renderer.js";
import OffscreenCanvasWorker from './offscreencanvas-worker.js?worker'

declare global {
  interface Window {
    webkit?: any;
  }
}


// Device and browser detection
const IS_ANDROID = /android/i.test(navigator.userAgent);
const IS_IOS =
  (/iPad|iPhone|iPod/.test(navigator.userAgent) && !((window as any).MSStream)) ||
  (/Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const IS_WKWEBVIEW = Boolean(window.webkit && window.webkit.messageHandlers);
const IS_AR_QUICKLOOK_CANDIDATE = (() => {
  if (IS_IOS) {
    if (!IS_WKWEBVIEW) {
      const tempAnchor = document.createElement('a');
      return Boolean(
        tempAnchor.relList &&
        tempAnchor.relList.supports &&
        tempAnchor.relList.supports('ar')
      );
    } else {
      return Boolean(
        /CriOS\/|EdgiOS\/|FxiOS\/|GSA\/|DuckDuckGo\//.test(navigator.userAgent)
      );
    }
  }
  return false;
})();
const IS_SCENEVIEWER_CANDIDATE =
  IS_ANDROID && !/firefox|OculusBrowser/i.test(navigator.userAgent);
let arMode = 'none';
if (IS_AR_QUICKLOOK_CANDIDATE) {
  arMode = 'quick-look';
} else if (IS_SCENEVIEWER_CANDIDATE) {
  arMode = 'scene-viewer';
}

interface EventPayload {
  type: string;
  [key: string]: any;
}

function getPixelRatio(limit: number): number {
  return Math.min(window.devicePixelRatio || 1, limit);
}

class ElementProxy {
  private static nextId = 0;
  public readonly id: number = ElementProxy.nextId++;
  private worker: Worker;
  private element: HTMLElement;
  private resizeObserver: ResizeObserver;
  private limitPixelRatio: number;
  private removers: Array<() => void> = [];
  private disconnected = false;

  constructor(
    element: HTMLElement,
    worker: Worker,
    handlers: Record<string, (event: Event) => EventPayload>,
    limitPixelRatio: number
  ) {
    this.worker = worker;
    this.element = element;
    this.limitPixelRatio = limitPixelRatio;
  
    const sendEvent = (data: EventPayload) => {
      this.worker.postMessage({ type: "event", id: this.id, data });
    };
  
    this.worker.postMessage({ type: "makeProxy", id: this.id });
  
    const sendSize = () => {
      if (this.disconnected) return;
      const rect = this.element.getBoundingClientRect();
      sendEvent({
        type: "size",
        left: rect.left,
        top: rect.top,
        width: this.element.clientWidth,
        height: this.element.clientHeight,
        pixelRatio: getPixelRatio(this.limitPixelRatio),
      });
    };
  
    this.resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(sendSize);
    });
  
    sendSize();
    this.resizeObserver.observe(element);
    window.addEventListener('resize', sendSize);
    this.removers.push(() => window.removeEventListener('resize', sendSize));
  
    this.attachHandlers(handlers, sendEvent);
  }

  private attachHandlers(handlers: Record<string, (event: Event) => EventPayload>, sendEvent: (data: EventPayload) => void): void {
    Object.entries(handlers).forEach(([eventName, handler]) => {
      const listener = (event: Event) => {
        if (this.disconnected) return;
        const payload = handler(event);
        sendEvent(payload);
      };
      this.element.addEventListener(eventName, listener);
      this.removers.push(() => this.element.removeEventListener(eventName, listener));
    });
  }

  disconnect(): void {
    this.disconnected = true;
    this.resizeObserver.disconnect();
    this.removers.splice(0).forEach(remove => remove());
  }
}

function createHandler<T extends Event>(handler: (event: T) => EventPayload): (event: Event) => EventPayload {
  return (event: Event) => handler(event as T);
}

function makeSendPropertiesHandler(properties: string[]) {
  return (e: MouseEvent | PointerEvent): EventPayload => {
    const payload: EventPayload = { type: e.type };
    properties.forEach((prop) => {
      if (prop in e) {
        payload[prop] = (e as any)[prop];
      }
    });
    return payload;
  };
}

const createEventHandlers = (monkView: MonkView) => {
  
  const mouseEventHandler = makeSendPropertiesHandler([
    "ctrlKey",
    "metaKey",
    "shiftKey",
    "button",
    "pointerType",
    "clientX",
    "clientY",
    "pointerId",
    "pageX",
    "pageY",
  ]);

  const getTouchPayload = (e: TouchEvent) => ({
    type: e.type,
    touches: Array.from(e.touches).map((touch) => ({
      pageX: touch.pageX,
      pageY: touch.pageY,
      clientX: touch.clientX,
      clientY: touch.clientY,
    })),
  });
  
  return {
    // contextmenu:  createHandler<Event>((e) => ({ type: e.type })),
    contextmenu:  createHandler<Event>((e) => {
      e.preventDefault()
      return { type: e.type }
    }),
    
    click:        createHandler<MouseEvent>(mouseEventHandler),
    mousedown:    createHandler<MouseEvent>(mouseEventHandler),
    mousemove:    createHandler<MouseEvent>(mouseEventHandler),
    mouseup:      createHandler<MouseEvent>(mouseEventHandler),
    mouseleave:   createHandler<MouseEvent>(mouseEventHandler),
    pointerdown:  createHandler<MouseEvent>(mouseEventHandler),
    pointermove:  createHandler<MouseEvent>(mouseEventHandler),
    pointerup:    createHandler<MouseEvent>(mouseEventHandler),
    pointerout:   createHandler<MouseEvent>(mouseEventHandler),

    wheel: createHandler<WheelEvent>((e) => {
      if (monkView.isInteractive) {
        e.preventDefault();
      }
      return {
        type: e.type,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
      };
    }),

    touchstart:   createHandler<TouchEvent>(getTouchPayload),
    touchend:     createHandler<TouchEvent>(getTouchPayload),
    touchmove:    createHandler<TouchEvent>((e) => {
      if (monkView.isInteractive) {
        e.preventDefault();
      }
      return getTouchPayload(e);
    }),
    
    keydown: createHandler<KeyboardEvent>((e) => ({
      type: e.type,
      key: e.key,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
    })),
  };
};

// main();

class MonkView extends HTMLElement {
  private canvas: HTMLCanvasElement;
  private commonOptions: {
    pixelRatio: number;
    backend: string;
    modelUrl: string | null;
    envmapUrl: string | null;
    minDistance: number;
    targetDistance: number;
    maxDistance: number;
    initDelay: number;
    initDelayInteractive: number;
    startup: string;
    lowPerformanceSettings: ReturnType<MonkView["getLowPerformanceSettings"]>;
    smaa: boolean;
    grazingSpecularClamp: boolean;
    perfSampling: {
      stabilityDuration: number;
      measureDuration: number;
    }
  };
  public isInteractive: boolean = false;
  private limitPixelRatio: number = Infinity;
  private sceneManager: any = null;
  private worker: Worker | null = null;
  private workerStarted: boolean = false;
  private proxy: ElementProxy | null = null;
  private useOffscreenCanvas: boolean = false;
  private fallbackReason: string | null = null;
  private backendOverride: string | null = null;
  private requestedStart: boolean | null = null;
  private generation = 0;
  private workerTimeout: ReturnType<typeof setTimeout> | null = null;
  public backendStatus: any = null;

  static get observedAttributes() { return ['backend']; }

  attributeChangedCallback(name: string, oldValue: string | null, value: string | null): void {
    if (name !== 'backend' || oldValue === value || !this.commonOptions) return;
    const backend = value ?? 'auto';
    if (!['auto', 'webgl', 'webgpu'].includes(backend)) {
      this.dispatchEvent(new CustomEvent('renderererror', { detail: { message: `Unknown backend: ${backend}` } }));
      return;
    }
    this.commonOptions.backend = backend;
    if (this.sceneManager || this.worker) this.restartRenderer(null, null);
  }

  public setBackend(backend: 'auto' | 'webgl' | 'webgpu'): void {
    this.setAttribute('backend', backend);
  }
  // private canInitialize: boolean = false; // unused

  constructor() {
    super();
    this.canvas = document.createElement("canvas");
    this.useOffscreenCanvas = this.getAttribute("offscreencanvas") === "true"

    // Extract attributes once and build the options object.
    const modelUrl = this.isValidURL(this.getAttribute("model") || "");
    const envmapUrl = this.isValidURL(this.getAttribute("envmap") || "");
    const targetDistance = parseFloat(this.getAttribute("target-distance") || "0.8");
    const minDistance = parseFloat(this.getAttribute("min-distance") || "0.1");
    const maxDistance = parseFloat(this.getAttribute("max-distance") || "1.0");
    const initDelay = parseFloat(this.getAttribute("init-delay") || "0.0");
    const initDelayInteractive = parseFloat(this.getAttribute("init-delay-interactive") || "0.0");
    const perfSampling = {
      stabilityDuration: parseFloat(this.getAttribute("perf-stability-duration") || "1.0"),
      measureDuration: parseFloat(this.getAttribute("perf-measure-duration") || "0.5")
    }
    const startup = this.getAttribute("startup") || "auto";

    this.commonOptions = {
      pixelRatio: getPixelRatio(this.limitPixelRatio),
      backend: this.getAttribute('backend') || 'auto',
      modelUrl,
      envmapUrl,
      minDistance,
      targetDistance,
      maxDistance,
      initDelay,
      initDelayInteractive,
      startup,
      lowPerformanceSettings: this.getLowPerformanceSettings(),
      smaa: this.getAttribute("smaa") === "true",
      grazingSpecularClamp: this.getAttribute("grazing-specular-clamp") === "true",
      perfSampling
    };
  }

  private addARLink(): void {
    if (arMode === 'none' || this.querySelector('.ar-link')) return;

    const modelAttr = arMode === 'quick-look' ? 'model-usdz' : 'model-glb';
    const modelUrl = this.isValidURL(this.getAttribute(modelAttr) || "");
    if (!modelUrl) return;
    const modelTitle = this.getAttribute('model-title') || document.title || 'model';
    const isVertical = this.getAttribute('ar-vertical') === "true";
    const isVerticalString = isVertical ? "true" : "false";

    const anchor = document.createElement('a');
    anchor.textContent = 'AR';
    anchor.classList.add('ar-link');

    if (arMode === 'quick-look') {
      anchor.setAttribute('rel', 'ar');
      anchor.setAttribute('href', modelUrl);
    } else if (arMode === 'scene-viewer') {
      const fallbackUrl = window.location.href;
      const intentUrl = `intent://arvr.google.com/scene-viewer/1.2?file=${encodeURIComponent(modelUrl)}&mode=ar_only&enable_vertical_placement=${isVerticalString}&title=${encodeURIComponent(modelTitle)}#Intent;scheme=https;package=com.google.android.googlequicksearchbox;action=android.intent.action.VIEW;S.browser_fallback_url=${encodeURIComponent(fallbackUrl)};end;`;
      anchor.setAttribute('href', intentUrl);
    }

    this.appendChild(anchor);
  }

  connectedCallback(): void {
    if (!this.canvas.isConnected) this.appendChild(this.canvas);
    this.logAttributes();
    this.initScene();
    this.addARLink();
  }

  logAttributes(): void {
    // Access values from commonOptions directly.
    console.log("Model URL:", this.commonOptions.modelUrl);
    console.log("Max distance:", this.commonOptions.maxDistance);
    console.log("Target distance:", this.commonOptions.targetDistance);
    console.log("Min distance:", this.commonOptions.minDistance);
    console.log("Envmap URL:", this.commonOptions.envmapUrl);
  }

  private isValidURL(url: string): string | null {
    if (!url) return null;
    try {
      return new URL(url, document.baseURI).href;
    } catch (e) {
      return null;
    }
  }

  private handleInteractivityChange(state: boolean) {
    this.isInteractive = state;
    if (state) {
      this.setAttribute('interactive', 'true')
      this.style.cursor = 'move'
    } else {
      this.setAttribute('interactive', 'false')
      this.style.cursor = 'pointer'
    }
    this.dispatchEvent(new CustomEvent('interactivity', { detail: { state } }));
  }

  private handleOnLoaded(state: boolean) {
    this.setAttribute('loaded', 'true')
    this.dispatchEvent(new CustomEvent('loaded', { detail: { state } }));
  }

  private handleBackend(status: any) {
    this.backendStatus = { ...status, ...(this.fallbackReason ? { fallbackReason: this.fallbackReason } : {}) };
    this.setAttribute('renderer-backend', status.selected ?? 'initializing');
    this.dispatchEvent(new CustomEvent('backendchange', { detail: this.backendStatus }));
  }

  private handleRendererError(error: any): void {
    this.dispatchEvent(new CustomEvent('renderererror', { detail: error }));
    if (error.recoverable && this.backendOverride !== 'webgl' && this.isConnected) {
      // A canvas cannot switch context type, including after worker transfer: always replace it.
      this.restartRenderer('webgl', error.message);
    }
  }

  private restartRenderer(backend: string | null, reason: string | null): void {
    const fresh = this.canvas.cloneNode(false) as HTMLCanvasElement;
    this.dispose();
    this.canvas = fresh;
    this.backendOverride = backend;
    this.fallbackReason = reason;
    this.removeAttribute('ready');
    this.removeAttribute('loaded');
    if (this.isConnected) { this.appendChild(this.canvas); this.initScene(); }
  }

  private handleOnReady(state: boolean) {
    this.setAttribute('ready', 'true')
    this.dispatchEvent(new CustomEvent('ready', { detail: { state } }));
  }

  private getLowPerformanceSettings() {
    const userAgent = navigator.userAgent;
    // Firefox, not the platform: Android devices get the same settings as iOS, the auto-tuner handles slow ones
    const isFirefoxMacOrAndroid = /(Macintosh|Android)(?!.*KHTML).*Gecko/i.test(userAgent);
  
    if (isFirefoxMacOrAndroid && this.useOffscreenCanvas) {
      return { disableMSAA: true, lowResolution: true };
    }
    if (isFirefoxMacOrAndroid) {
      return { disableMSAA: true, lowResolution: false };
    }
  
    return { disableMSAA: false, lowResolution: false };
  }

  startWorker(canvas: HTMLCanvasElement): void {
    const offscreen = canvas.transferControlToOffscreen();
    const worker = new OffscreenCanvasWorker();
    this.worker = worker;
    const generation = this.generation;
    this.workerTimeout = setTimeout(() => {
      if (this.worker === worker && !this.workerStarted) this.recoverWorker('Worker initialization timed out');
    }, 15000);
    worker.onerror = event => {
      event.preventDefault();
      if (this.worker === worker) this.recoverWorker(event.message || 'Worker failed');
    };
    worker.onmessageerror = () => { if (this.worker === worker) this.recoverWorker('Worker message decoding failed'); };

    // Module workers can receive messages while their imports are still initializing. Wait until the worker has
    // installed its dispatcher before sending makeProxy, size, or start; otherwise later events have no receiver.
    worker.onmessage = (e) => {
      if (this.worker !== worker || this.generation !== generation) return;
      switch (e.data.type) {
        case 'initialized': {
          if (this.workerStarted) break;
          if (this.workerTimeout) clearTimeout(this.workerTimeout);
          const handlers = createEventHandlers(this);
          this.proxy = new ElementProxy(canvas, worker, handlers, this.limitPixelRatio);
          worker.postMessage({
            ...this.commonOptions,
            backend: this.backendOverride ?? this.commonOptions.backend,
            startup: this.requestedStart === null ? this.commonOptions.startup :
              (this.requestedStart ? 'auto' : 'manual'),
            type: 'start',
            canvas: offscreen,
            canvasId: this.proxy.id,
          }, [offscreen]);
          this.workerStarted = true;
          break;
        }
        case 'backend':
          this.handleBackend(e.data.status);
          break;
        case 'error':
          this.handleRendererError(e.data.error);
          break;
        case 'interactivity':
          this.handleInteractivityChange(e.data.state);
          break
        case 'loaded':
          this.handleOnLoaded(e.data.state);
          break
        case 'ready':
          this.handleOnReady(e.data.state);
          break
      }
    };
  }

  private recoverWorker(message: string): void {
    this.useOffscreenCanvas = false;
    this.dispatchEvent(new CustomEvent('renderererror', { detail: { message, execution: 'worker', recoverable: true } }));
    this.restartRenderer(this.backendOverride, `main-thread fallback: ${message}`);
  }

  private dispose(): void {
    ++this.generation;
    if (this.workerTimeout) clearTimeout(this.workerTimeout);
    this.workerTimeout = null;
    if (this.worker) {
      // Worker scenario
      this.worker.postMessage({ type: "dispose" }); // dispose() in renderer.js
      this.worker.terminate();
      this.worker = null;
      this.workerStarted = false;
      if (this.proxy) {
        this.proxy.disconnect(); // Disconnect ResizeObserver
        this.proxy = null;
      }
    } else if (this.sceneManager) {
      // Main thread scenario
      this.sceneManager.dispose();
      this.sceneManager = null;
    }
    // Remove canvas if still attached
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
    // Reconnecting must not reuse a context-bound or transferred canvas.
    this.canvas = this.canvas.cloneNode(false) as HTMLCanvasElement;
  }

  disconnectedCallback(): void {
    this.dispose();
  }

  public disposeRenderer(): void {
    this.dispose();
  }

  attemptInit(): void {
    this.requestedStart = true;
    // this.canInitialize = true; // unused
    if (this.worker) {
      if (this.workerStarted) this.worker.postMessage({ type: "enableRendering" });
    } else if (this.sceneManager) {
      this.sceneManager.enableRendering();
    }
  }

  abortInit(): void {
    this.requestedStart = false;
    // this.canInitialize = false; // unused
    if (this.worker) {
      if (this.workerStarted) this.worker.postMessage({ type: "disableRendering" });
    } else if (this.sceneManager) {
      this.sceneManager.disableRendering();
    }
  }

  initScene(): void {
    if (!this.canvas) return;

    if (!(this.commonOptions.modelUrl && this.commonOptions.envmapUrl)) {
      console.warn("No valid model or envmap found. Scene won't be initialized.");
      return;
    }

    const generation = this.generation;
    const current = (callback: () => void) => { if (this.generation === generation) callback(); };
    if (this.canvas.transferControlToOffscreen !== undefined && this.useOffscreenCanvas) {
      try { this.startWorker(this.canvas); } catch (error) { this.recoverWorker(String(error)); }
    } else {
      this.sceneManager = init({
        canvas: this.canvas,
        inputElement: this.canvas,
        ...this.commonOptions,
        backend: this.backendOverride ?? this.commonOptions.backend,
        startup: this.requestedStart === null ? this.commonOptions.startup : (this.requestedStart ? 'auto' : 'manual'),
        e_interactivityChange: (state: boolean) => current(() => this.handleInteractivityChange(state)),
        e_loaded: (state: boolean) => current(() => this.handleOnLoaded(state)),
        e_ready: (state: boolean) => current(() => this.handleOnReady(state)),
        e_backend: (status: any) => current(() => this.handleBackend(status)),
        e_error: (error: any) => current(() => this.handleRendererError(error)),
      });
    }
  }

}

customElements.define("monk-view", MonkView);