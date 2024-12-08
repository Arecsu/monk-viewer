// @ts-ignore
import { init } from "./shared-orbitcontrols.js";

interface EventPayload {
  type: string;
  [key: string]: any;
}

class ElementProxy {
  private static nextId = 0;
  public readonly id: number;
  private worker: Worker;
  private element: HTMLElement;
  private resizeObserver: ResizeObserver;

  constructor(element: HTMLElement, worker: Worker, handlers: Record<string, (event: Event) => EventPayload>) {
    this.id = ElementProxy.nextId++;
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

const createEventHandlers = () => {
  
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
    contextmenu:  createHandler<Event>((e) => ({ type: e.type })),
    mousedown:    createHandler<MouseEvent>(mouseEventHandler),
    mousemove:    createHandler<MouseEvent>(mouseEventHandler),
    mouseup:      createHandler<MouseEvent>(mouseEventHandler),
    mouseleave:   createHandler<MouseEvent>(mouseEventHandler),
    pointerdown:  createHandler<MouseEvent>(mouseEventHandler),
    pointermove:  createHandler<MouseEvent>(mouseEventHandler),
    pointerup:    createHandler<MouseEvent>(mouseEventHandler),

    wheel: createHandler<WheelEvent>((e) => {
      e.preventDefault();
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

function startWorker(canvas: HTMLCanvasElement): void {
  const offscreen = canvas.transferControlToOffscreen();
  const worker = new Worker(
    new URL("./offscreencanvas-worker-orbitcontrol.js", import.meta.url),
    { type: "module" }
  );

  const proxy = new ElementProxy(canvas, worker, createEventHandlers());

  worker.postMessage({
    type: "start",
    canvas: offscreen,
    canvasId: proxy.id,
    pixelRatio: window.devicePixelRatio || 1,
    lowPerformanceSettings: getLowPerformanceSettings(),
  }, [offscreen]);
}

function main(): void {
  const canvas = document.querySelector<HTMLCanvasElement>("#c");
  if (!canvas) return;

  canvas.transferControlToOffscreen !== undefined 
    ? startWorker(canvas)
    : init({ 
      canvas, 
      inputElement: canvas, 
      pixelRatio: window.devicePixelRatio, 
      lowPerformanceSettings: getLowPerformanceSettings() 
    });
}

main();
