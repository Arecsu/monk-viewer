import test from 'node:test';
import assert from 'node:assert/strict';
import { timingStats, flipRows, unpadRows, comparePixels, interiorMask } from '../src/lab/geometry-probe-utils.js';

test('timing statistics do not mutate input and reject missing/invalid GPU samples', () => {
  const values = [4, 1, 3, 2];
  assert.deepEqual(timingStats(values), { samples: 4, medianMs: 3, p10Ms: 1, p90Ms: 4, meanMs: 2.5 });
  assert.deepEqual(values, [4, 1, 3, 2]);
  for (const bad of [[], [NaN], [Infinity], [-1]]) assert.throws(() => timingStats(bad));
});

test('WebGPU padded readbacks are compacted before row inversion', () => {
  const padded = new Float32Array(64 + 8); // 2 RGBA pixels per row, second row starts at byte 256.
  padded.set([1, 2, 3, 4, 5, 6, 7, 8]);
  padded.set([9, 10, 11, 12, 13, 14, 15, 16], 64);
  const compact = unpadRows(padded, 2, 2);
  assert.deepEqual([...compact], Array.from({ length: 16 }, (_, i) => i + 1));
  assert.deepEqual([...flipRows(compact, 2, 2)], [9, 10, 11, 12, 13, 14, 15, 16, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(unpadRows(compact, 2, 2), compact);
  assert.throws(() => unpadRows(new Float32Array(17), 2, 2));
  assert.throws(() => flipRows(compact, 3, 2));
});

test('pixel comparison reports errors and non-finite values explicitly', () => {
  const a = new Float32Array([0, 0, 0, 1, 2, 2, 2, 1]);
  const b = new Float32Array([1, 0, 0, 0, NaN, 2, 2, 1]);
  const stats = comparePixels(a, b);
  assert.equal(stats.nonFinite, 1);
  assert.equal(stats.maxAbs, 1);
  assert.equal(stats.comparedChannels, 5);
  assert.equal(stats.differentChannels, 1);
  assert.equal(comparePixels(a, b, [1, 2]).nonFinite, 0);
  assert.throws(() => comparePixels(a, new Float32Array(4)));
});

test('interior masks require both backends to cover every neighboring pixel', () => {
  const a = new Float32Array(5 * 5 * 4).fill(0.5), b = a.slice();
  const initial = interiorMask(a, b, 5, 5);
  assert.equal(initial.reduce((sum, x) => sum + x, 0), 9);
  b[(2 * 5 + 2) * 4] = 1;
  assert.equal(interiorMask(a, b, 5, 5).reduce((sum, x) => sum + x, 0), 0);
});

test('continuous-surface masks exclude internal edges without masking a constant backend depth error', () => {
  const a = new Float32Array(5 * 5 * 4).fill(0.5), b = new Float32Array(5 * 5 * 4).fill(0.6);
  assert.equal(interiorMask(a, b, 5, 5, 1, 0.01).reduce((sum, x) => sum + x, 0), 9);
  a[(2 * 5 + 2) * 4] = 0.8;
  assert.equal(interiorMask(a, b, 5, 5, 1, 0.01).reduce((sum, x) => sum + x, 0), 0);
});
