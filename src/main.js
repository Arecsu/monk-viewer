import { init } from "./shared-orbitcontrols.js";

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
const wheelEventHandlerImpl = makeSendPropertiesHandler([
  "deltaX",
  "deltaY",
]);
const keydownEventHandler = makeSendPropertiesHandler([
  "ctrlKey",
  "metaKey",
  "shiftKey",
  "keyCode",
]);

const defaultEventHandlerImpl = makeSendPropertiesHandler([]);

function wheelEventHandler(event, sendFn) {
  event.preventDefault();
  wheelEventHandlerImpl(event, sendFn);
}

function preventDefaultHandler(event) {
  // Shutdown an event
  event.preventDefault();
}

function defaultEventHandler(event, sendFn) {
  // Pass the event as-is to allow default behavior
  sendFn({ type: event.type })
}

function copyProperties(src, properties, dst) {
  for (const name of properties) {
    dst[name] = src[name];
  }
}

function makeSendPropertiesHandler(properties) {
  return function sendProperties(event, sendFn) {
    const data = { type: event.type };
    copyProperties(event, properties, data);
    sendFn(data);
  };
}

function touchEventHandler(event, sendFn) {
  // preventDefault() fixes mousemove, mouseup and mousedown
  //	firing when doing a simple touchup touchdown
  // Happens only at offscreen canvas
  event.preventDefault();
  const touches = [];
  const data = { type: event.type, touches };
  for (let i = 0; i < event.touches.length; ++i) {
    const touch = event.touches[i];
    touches.push({
      pageX: touch.pageX,
      pageY: touch.pageY,
      clientX: touch.clientX,
      clientY: touch.clientY,
    });
  }

  sendFn(data);
}

// The four arrow keys
const orbitKeys = {
  "37": true, // left
  "38": true, // up
  "39": true, // right
  "40": true, // down
};
function filteredKeydownEventHandler(event, sendFn) {
  const { keyCode } = event;
  if (orbitKeys[keyCode]) {
    event.preventDefault();
    keydownEventHandler(event, sendFn);
  }
}

let nextProxyId = 0;
class ElementProxy {
  constructor(element, worker, eventHandlers) {
    this.id = nextProxyId++;
    this.worker = worker;
    this.element = element;

    const sendEvent = (data) => {
      this.worker.postMessage({
        type: "event",
        id: this.id,
        data,
      });
    };

    // Register an id
    worker.postMessage({
      type: "makeProxy",
      id: this.id,
    });

    // Create ResizeObserver
    this.resizeObserver = new ResizeObserver((_entries) => {
      requestAnimationFrame(() => {
        const rect = this.element.getBoundingClientRect();
        sendEvent({
          type: "size",
          left: rect.left,
          top: rect.top,
          width: this.element.clientWidth,
          height: this.element.clientHeight,
          pixelRatio: window.devicePixelRatio || 1
        });
      });
    });

    // Initial size send
    this.sendSize(sendEvent);

    // Observe the element
    this.resizeObserver.observe(element);

    // Add event listeners
    for (const [eventName, handler] of Object.entries(eventHandlers)) {
      element.addEventListener(eventName, function (event) {
        handler(event, sendEvent);
      });
    }

    // Fallback resize listener
    // window.addEventListener("resize", () => this.sendSize(sendEvent));
  }

  sendSize(sendEvent) {
    const rect = this.element.getBoundingClientRect();
    sendEvent({
      type: "size",
      left: rect.left,
      top: rect.top,
      width: this.element.clientWidth,
      height: this.element.clientHeight,
    });
  }

  // Optional: Cleanup method to disconnect observer
  disconnect() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
  }
}

function getLowPerformanceSettings() {
  const firefoxMacintoshRegex = /Macintosh(?!.*KHTML).*Gecko/i;
  const firefoxAndroidRegex = /Android(?!.*KHTML).*Gecko/i;

  if (firefoxMacintoshRegex.test(navigator.userAgent)) {
    return {
      disableAA: true,
      lowResolution: false
    }
  }

  if (firefoxAndroidRegex.test(navigator.userAgent)) {
    return {
      disableAA: true,
      lowResolution: true
    }
  }

  return null;
}


function startWorker(canvas, lowPerformanceSettings) {
  // canvas.focus();
  const offscreen = canvas.transferControlToOffscreen();
  const worker = new Worker(
    new URL('./offscreencanvas-worker-orbitcontrol.js', import.meta.url),
    { type: 'module' });
  const pixelRatio = window.devicePixelRatio || 1;
  const eventHandlers = {
    contextmenu: defaultEventHandler,
    mousedown: mouseEventHandler,
    mousemove: mouseEventHandler,
    mouseup: mouseEventHandler,
    mouseleave: mouseEventHandler,
    pointerdown: mouseEventHandler,
    pointermove: mouseEventHandler,
    pointerup: mouseEventHandler,
    touchstart: touchEventHandler,
    touchmove: touchEventHandler,
    touchend: touchEventHandler,
    wheel: wheelEventHandler,
    keydown: filteredKeydownEventHandler,
  };
  const proxy = new ElementProxy(canvas, worker, eventHandlers);
  worker.postMessage({
    type: "start",
    canvas: offscreen,
    canvasId: proxy.id,
    pixelRatio: pixelRatio,
    lowPerformanceSettings
  }, [offscreen]);
  console.log("using OffscreenCanvas"); /* eslint-disable-line no-console */
}

function startMainPage(canvas, lowPerformanceSettings) {
  init({ canvas, inputElement: canvas, pixelRatio: window.devicePixelRatio, lowPerformanceSettings });
  console.log("using regular canvas"); /* eslint-disable-line no-console */
}

function main() {
  /* eslint consistent-return: 0 */

  const lowPerformanceSettings = getLowPerformanceSettings();

  const canvas = document.querySelector("#c");
  if (canvas.transferControlToOffscreen) {
    startWorker(canvas, lowPerformanceSettings);
  } else {
    startMainPage(canvas, lowPerformanceSettings);
  }
}

main();
