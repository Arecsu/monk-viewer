/** Statistics for GPU durations. No FPS/vsync conversion is used in the probe. */
export function timingStats(values) {
  if (!values.length || values.some(v => !Number.isFinite(v) || v < 0)) throw new Error('Invalid timing samples');
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = p => sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)];
  return { samples: values.length, medianMs: percentile(0.5), p10Ms: percentile(0.1), p90Ms: percentile(0.9), meanMs: values.reduce((a, b) => a + b, 0) / values.length };
}

/** Three's WebGPU readback retains 256-byte row padding (the final row is not padded). */
export function unpadRows(data, width, height, channels = 4) {
  const rowValues = width * channels;
  if (data.length === rowValues * height) return data;
  const rowBytes = rowValues * data.BYTES_PER_ELEMENT;
  const stride = Math.ceil(rowBytes / 256) * 256 / data.BYTES_PER_ELEMENT;
  if (data.length !== (height - 1) * stride + rowValues && data.length !== height * stride) throw new Error('Unexpected padded readback size');
  const result = new data.constructor(rowValues * height);
  for (let y = 0; y < height; ++y) result.set(data.subarray(y * stride, y * stride + rowValues), y * rowValues);
  return result;
}

/** WebGPU readback starts at the top; WebGL readback starts at the bottom. */
export function flipRows(data, width, height, channels = 4) {
  if (data.length !== width * height * channels) throw new Error('Readback dimensions do not match');
  const result = new data.constructor(data.length);
  const stride = width * channels;
  for (let y = 0; y < height; ++y) result.set(data.subarray(y * stride, (y + 1) * stride), (height - y - 1) * stride);
  return result;
}

/** Absolute errors, with non-finite values explicitly reported rather than hidden. */
export function comparePixels(reference, actual, channels = [0, 1, 2], mask = null) {
  if (reference.length !== actual.length || reference.length % 4) throw new Error('Readback sizes differ');
  let count = 0, sum = 0, squares = 0, max = 0, nonFinite = 0, different = 0;
  for (let p = 0; p < reference.length / 4; ++p) {
    if (mask && !mask[p]) continue;
    for (const c of channels) {
      const d = Math.abs(reference[p * 4 + c] - actual[p * 4 + c]);
      if (!Number.isFinite(d)) { ++nonFinite; continue; }
      ++count; sum += d; squares += d * d; max = Math.max(max, d);
      if (d !== 0) ++different;
    }
  }
  return { comparedChannels: count, differentChannels: different, nonFinite, maxAbs: max, meanAbs: count ? sum / count : null, rmse: count ? Math.sqrt(squares / count) : null };
}

/** Exclude silhouette/sample-coverage disagreements when comparing depth or motion semantics. */
export function interiorMask(a, b, width, height, radius = 1, maxDepthStep = Infinity) {
  const result = new Uint8Array(width * height);
  for (let y = radius; y < height - radius; ++y) for (let x = radius; x < width - radius; ++x) {
    let inside = true;
    for (let dy = -radius; dy <= radius && inside; ++dy) for (let dx = -radius; dx <= radius; ++dx) {
      const k = ((y + dy) * width + x + dx) * 4;
      const center = (y * width + x) * 4;
      if (!(a[k] < 0.999999 && b[k] < 0.999999) || Math.abs(a[k] - a[center]) > maxDepthStep || Math.abs(b[k] - b[center]) > maxDepthStep) { inside = false; break; }
    }
    result[y * width + x] = inside ? 1 : 0;
  }
  return result;
}
