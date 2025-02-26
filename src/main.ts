// @ts-ignore
import { init } from "./shared-orbitcontrols.js";

interface EventPayload {
  type: string;
  [key: string]: any;
}

class ElementProxy {
  private static nextId = 0;
  public readonly id: number = ElementProxy.nextId++;
  private worker: Worker;
  private element: HTMLElement;
  private resizeObserver: ResizeObserver;

  constructor(element: HTMLElement, worker: Worker, handlers: Record<string, (event: Event) => EventPayload>) {
    this.worker = worker;
    this.element = element;
  
    const sendEvent = (data: EventPayload) => {
      this.worker.postMessage({ type: "event", id: this.id, data });
    };
  
    this.worker.postMessage({ type: "makeProxy", id: this.id });
  
    const sendSize = () => {
      const rect = this.element.getBoundingClientRect();
      sendEvent({
        type: "size",
        left: rect.left,
        top: rect.top,
        width: this.element.clientWidth,
        height: this.element.clientHeight,
        pixelRatio: window.devicePixelRatio || 1,
      });
    };
  
    this.resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(sendSize);
    });
  
    sendSize();
    this.resizeObserver.observe(element);
  
    this.attachHandlers(handlers, sendEvent);
  }

  private attachHandlers(handlers: Record<string, (event: Event) => EventPayload>, sendEvent: (data: EventPayload) => void): void {
    Object.entries(handlers).forEach(([eventName, handler]) => {
      this.element.addEventListener(eventName, (event) => {
        const payload = handler(event);
        sendEvent(payload);
      });
    });
  }

  disconnect(): void {
    this.resizeObserver.disconnect();
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

function makeTouchEventHandler() {
  return (e: TouchEvent): EventPayload => {
    e.preventDefault();
    return {
      type: e.type,
      touches: Array.from(e.touches).map((touch) => ({
        pageX: touch.pageX,
        pageY: touch.pageY,
        clientX: touch.clientX,
        clientY: touch.clientY,
      })),
    };
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
  
  const touchEventHandler = makeTouchEventHandler();
  
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

    touchstart:   createHandler<TouchEvent>(touchEventHandler),
    touchmove:    createHandler<TouchEvent>(touchEventHandler),
    touchend:     createHandler<TouchEvent>(touchEventHandler),
    
    keydown: createHandler<KeyboardEvent>((e) => ({
      type: e.type,
      key: e.key,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
    })),
  };
};

function getLowPerformanceSettings() {
  const isFirefoxMacintosh = /Macintosh(?!.*KHTML).*Gecko/i.test(navigator.userAgent);
  const isFirefoxAndroid = /Android(?!.*KHTML).*Gecko/i.test(navigator.userAgent);

  if (isFirefoxMacintosh || isFirefoxAndroid) {
    return { disableMSAA: true, lowResolution: true };
  }

  return { disableMSAA: false, lowResolution: false };
}

// main();



class MonkView extends HTMLElement {
  private canvas: HTMLCanvasElement;
  private commonOptions: {
    pixelRatio: number;
    modelUrl: string;
    envmapUrl: string;
    minDistance: number;
    targetDistance: number;
    maxDistance: number;
    lowPerformanceSettings: ReturnType<typeof getLowPerformanceSettings>;
    perfSampling: {
      stabilityDuration: number;
      measureDuration: number;
    }
  };
  public isInteractive: boolean = false;

  constructor() {
    super();
    this.canvas = document.createElement("canvas");

    // Extract attributes once and build the options object.
    const modelUrl = this.getAttribute("model") || "";
    const envmapUrl = this.getAttribute("envmap") || "";
    const targetDistance = parseFloat(this.getAttribute("target-distance") || "0.8");
    const minDistance = parseFloat(this.getAttribute("min-distance") || "0.1");
    const maxDistance = parseFloat(this.getAttribute("max-distance") || "1.0");
    const perfSampling = {
      stabilityDuration: parseFloat(this.getAttribute("perf-stability-duration") || "1.0"),
      measureDuration: parseFloat(this.getAttribute("perf-measure-duration") || "0.5")
    }

    this.commonOptions = {
      pixelRatio: window.devicePixelRatio || 1,
      modelUrl,
      envmapUrl,
      minDistance,
      targetDistance,
      maxDistance,
      lowPerformanceSettings: getLowPerformanceSettings(),
      perfSampling
    };
  }

  connectedCallback(): void {
    this.appendChild(this.canvas);
    this.logAttributes();
    this.initScene();
  }

  logAttributes(): void {
    // Access values from commonOptions directly.
    console.log("Model URL:", this.commonOptions.modelUrl);
    console.log("Max distance:", this.commonOptions.maxDistance);
    console.log("Target distance:", this.commonOptions.targetDistance);
    console.log("Min distance:", this.commonOptions.minDistance);
    console.log("Envmap URL:", this.commonOptions.envmapUrl);
  }

  private isValidURL(url: string): boolean {
    if (!url) return false;
    try {
      new URL(url, document.baseURI);
      return true;
    } catch (e) {
      return false;
    }
  }

  private handleInteractivityChange(state: boolean) {
    this.isInteractive = state;
    this.dispatchEvent(new CustomEvent('interactivity', { detail: { state } }));
  }

  startWorker(canvas: HTMLCanvasElement): void {
    const offscreen = canvas.transferControlToOffscreen();
    const worker = new Worker(
      new URL("./offscreencanvas-worker-orbitcontrol.js", import.meta.url),
      { type: "module" }
    );

    const handlers = createEventHandlers(this);
    const proxy = new ElementProxy(canvas, worker, handlers);

    worker.postMessage({
      type: "start",
      canvas: offscreen,
      canvasId: proxy.id,
      ...this.commonOptions,
    }, [offscreen]);

    worker.onmessage = (e) => {
      if (e.data.type === 'interactivity') {
          this.handleInteractivityChange(e.data.state);
      }
    };
  }

  initScene(): void {
    if (!this.canvas) return;

    const hasValidModel = this.isValidURL(this.commonOptions.modelUrl);
    const hasValidEnvmap = this.isValidURL(this.commonOptions.envmapUrl);

    if (!(hasValidModel && hasValidEnvmap)) {
      console.warn("No valid model or envmap found. Scene won't be initialized.");
      return;
    }

    this.canvas.transferControlToOffscreen !== undefined 
      ? this.startWorker(this.canvas)
      : init({ 
        canvas: this.canvas, 
        inputElement: this.canvas, 
        ...this.commonOptions,
        onInteractivityChange: (state: boolean) => this.handleInteractivityChange(state)
      });
  }

}

customElements.define("monk-view", MonkView);