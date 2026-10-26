// Promotion is deliberately gated by final-image, temporal, lifecycle and performance evidence.
export const WEBGPU_ACCEPTED = false;
export const BACKENDS = Object.freeze(['auto', 'webgl', 'webgpu']);

export function normalizeBackend(value = 'auto') {
  if (!BACKENDS.includes(value)) throw new TypeError(`Unknown rendering backend: ${value}`);
  return value;
}

export function chooseBackend(requested = 'auto', { webgpuAvailable = !!globalThis.navigator?.gpu, accepted = WEBGPU_ACCEPTED } = {}) {
  requested = normalizeBackend(requested);
  if (requested === 'webgl') return { requested, selected: 'webgl', reason: 'explicit' };
  if (!webgpuAvailable) return { requested, selected: 'webgl', reason: 'webgpu-unavailable' };
  if (requested === 'auto' && !accepted) return { requested, selected: 'webgl', reason: 'webgpu-acceptance-pending' };
  return { requested, selected: 'webgpu', reason: requested === 'auto' ? 'accepted-native-preference' : 'explicit' };
}
