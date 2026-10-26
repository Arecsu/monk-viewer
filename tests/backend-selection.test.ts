import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseBackend, normalizeBackend, WEBGPU_ACCEPTED } from '../src/BackendSelection.js';
import { webglProjection } from '../src/webgpu/Common.js';
import { PerspectiveCamera, WebGPUCoordinateSystem, WebGLCoordinateSystem } from 'three/webgpu';

 test('automatic selection prefers native WebGPU where available and stays gate-controlled', () => {
  assert.equal(WEBGPU_ACCEPTED, true);
  assert.deepEqual(chooseBackend('auto', { webgpuAvailable: true }), {
    requested: 'auto', selected: 'webgpu', reason: 'accepted-native-preference',
  });
  assert.deepEqual(chooseBackend('auto', { webgpuAvailable: false }), {
    requested: 'auto', selected: 'webgl', reason: 'webgpu-unavailable',
  });
  assert.equal(chooseBackend('auto', { webgpuAvailable: true, accepted: false }).reason, 'webgpu-acceptance-pending');
  assert.equal(chooseBackend('webgpu', { webgpuAvailable: true }).selected, 'webgpu');
  assert.equal(chooseBackend('webgl', { webgpuAvailable: true, accepted: true }).selected, 'webgl');
});

test('unsupported native requests are observable and invalid names rejected', () => {
  assert.deepEqual(chooseBackend('webgpu', { webgpuAvailable: false }), {
    requested: 'webgpu', selected: 'webgl', reason: 'webgpu-unavailable',
  });
  assert.throws(() => normalizeBackend('WebGPU'), /Unknown rendering backend/);
});

test('native projection converts back to reference GL NDC including asymmetric jitter terms', () => {
  const native = new PerspectiveCamera(50, 1.7, 0.03, 100);
  native.coordinateSystem = WebGPUCoordinateSystem;
  native.updateProjectionMatrix();
  native.projectionMatrix.elements[8] += 0.001;
  native.projectionMatrix.elements[9] -= 0.002;
  const saved = native.projectionMatrix.clone();
  const actual = webglProjection(native);
  const reference = new PerspectiveCamera(50, 1.7, 0.03, 100);
  reference.coordinateSystem = WebGLCoordinateSystem;
  reference.updateProjectionMatrix();
  reference.projectionMatrix.elements[8] += 0.001;
  reference.projectionMatrix.elements[9] -= 0.002;
  for (let i = 0; i < 16; ++i) assert.ok(Math.abs(actual.elements[i] - reference.projectionMatrix.elements[i]) < 1e-12);
  assert.deepEqual(native.projectionMatrix.elements, saved.elements);
  assert.notEqual(webglProjection(reference), reference.projectionMatrix);
});
