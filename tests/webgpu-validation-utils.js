// Backend-neutral helpers for the native pipeline validation harness (tests/webgpu-pipeline-browser.js).
// Everything here is DOM-free and GPU-free so it can be unit tested with `node --test`.
//
// Invariants this module enforces:
// - Captures are normalized to display top-left row order and a declared encoding before comparison.
//   WebGL `readPixels` returns bottom-left rows, WebGPU storage is top-left, and WebGPU readbacks are
//   256-byte row padded; those differences are normalized once here instead of leaking into comparisons.
// - Measurements are rejected, not clamped: empty, non-finite, zero/negative, non-monotonic-inconsistent
//   timings and blank/degenerate captures throw instead of producing a plausible-looking number.
// - Comparisons separate *physically meaningful* error (display-linear absolute + relative tolerance) from
//   *visible* error (sRGB code differences classified as flat-surface or edge/shading differences), so an
//   unexplained visible difference on a flat surface fails while a documented silhouette/shading
//   difference is reported with counts.

export class ValidationError extends Error {
  constructor(code, message, details = undefined) {
    super(`${code}: ${message}`);
    this.name = 'ValidationError';
    this.code = code;
    this.details = details;
  }
}

export class CapabilityError extends ValidationError {
  constructor(code, message, details = undefined) {
    super(code, message, details);
    this.name = 'CapabilityError';
  }
}

export function requireFiniteNumber(value, label, { positive = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError('non-finite', `${label} must be a finite number, received ${String(value)}`);
  }
  if (positive && value <= 0) {
    throw new ValidationError('non-positive', `${label} must be greater than 0, received ${value}`);
  }
  return value;
}

export function requireInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ValidationError('invalid-integer', `${label} must be an integer in [${minimum}, ${maximum}], received ${String(value)}`);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// sRGB transfer functions. Comparison happens in display-linear light values; visibility is judged in
// sRGB code values because that is the domain the WebGL reference canvas and a display are quantized in.

export function srgbDecode(value) {
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value);
  if (magnitude <= 0.04045) return sign * (magnitude / 12.92);
  return sign * Math.pow((magnitude + 0.055) / 1.055, 2.4);
}

export function srgbEncode(value) {
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value);
  if (magnitude <= 0.0031308) return sign * (magnitude * 12.92);
  return sign * (1.055 * Math.pow(magnitude, 1 / 2.4) - 0.055);
}

// ---------------------------------------------------------------------------------------------
// Readback geometry.

export const ROW_ORDERS = Object.freeze(['top-left', 'bottom-left']);

/** Compact Three's 256-byte row-aligned WebGPU readbacks. Returns the input when already packed. */
export function unpadRows(data, width, height, channels = 4) {
  if (!ArrayBuffer.isView(data)) throw new ValidationError('capture-type', 'Capture data must be a typed array');
  requireInteger(width, 'width', { minimum: 1 });
  requireInteger(height, 'height', { minimum: 1 });
  requireInteger(channels, 'channels', { minimum: 1, maximum: 4 });
  const rowValues = width * channels;
  const packedLength = rowValues * height;
  if (data.length === packedLength) return data;
  const bytesPerValue = data.BYTES_PER_ELEMENT;
  const packedBytesPerRow = rowValues * bytesPerValue;
  const paddedBytesPerRow = Math.ceil(packedBytesPerRow / 256) * 256;
  if (paddedBytesPerRow === packedBytesPerRow) {
    throw new ValidationError('capture-length', `Capture has ${data.length} values, expected ${packedLength} packed values; rows are already 256-byte aligned so padding cannot explain the difference`);
  }
  const stride = paddedBytesPerRow / bytesPerValue;
  if (data.length !== (height - 1) * stride + rowValues && data.length !== height * stride) {
    throw new ValidationError('capture-length', `Capture has ${data.length} values, expected ${(height - 1) * stride + rowValues} (WebGPU) or ${height * stride} (fully padded) for a ${width}x${height} readback with ${stride} values per row`);
  }
  const result = new data.constructor(packedLength);
  for (let y = 0; y < height; ++y) result.set(data.subarray(y * stride, y * stride + rowValues), y * rowValues);
  return result;
}

/** Normalize row order to display top-left. WebGL readPixels is bottom-left, WebGPU storage is top-left. */
export function toTopLeftRows(data, width, height, { channels = 4, rowOrder = 'top-left' } = {}) {
  if (!ROW_ORDERS.includes(rowOrder)) {
    throw new ValidationError('row-order', `Unknown row order "${rowOrder}"; expected ${ROW_ORDERS.join(' or ')}`);
  }
  const expected = width * height * channels;
  if (data.length !== expected) {
    throw new ValidationError('capture-length', `Capture has ${data.length} values, expected ${expected} for ${width}x${height}x${channels}`);
  }
  if (rowOrder === 'top-left') return data;
  const result = new data.constructor(expected);
  const stride = width * channels;
  for (let y = 0; y < height; ++y) {
    const destination = (height - y - 1) * stride;
    result.set(data.subarray(y * stride, (y + 1) * stride), destination);
  }
  return result;
}

/** IEEE 754 binary16 -> number, including subnormals, infinities and NaN. */
export function decodeHalfFloat(bits) {
  requireInteger(bits, 'half-float bits', { minimum: 0, maximum: 0xffff });
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa === 0 ? sign * Infinity : NaN;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

// `rgba8unorm-srgb` readbacks are already sRGB codes (hardware encoded exactly one sRGB transform on write);
// everything else is a display-linear value that still needs the presentation transfer function.
export const CAPTURE_FORMATS = Object.freeze({
  'rgba8unorm': { channels: 4, encoding: 'display-linear', array: Uint8Array, decode: (value) => value / 255 },
  'rgba8unorm-srgb': { channels: 4, encoding: 'srgb', array: Uint8Array, decode: (value) => value / 255 },
  'rgba16float': { channels: 4, encoding: 'display-linear', array: Uint16Array, decode: decodeHalfFloat },
  'rgba32float': { channels: 4, encoding: 'display-linear', array: Float32Array, decode: (value) => value },
});

/**
 * Convert one backend's raw readback into `{ data: Float32Array (top-left, 4 channels), encoding }`.
 * `format` is the native/Three texture format; unsupported formats fail as a capability error rather
 * than being compared in an unknown encoding.
 */
export function normalizeCapture({ data, width, height, channels = 4, rowOrder = 'top-left', format, label = 'capture' }) {
  const spec = CAPTURE_FORMATS[format];
  if (!spec) {
    throw new CapabilityError('capture-format', `${label}: unsupported capture format "${String(format)}"; supported formats are ${Object.keys(CAPTURE_FORMATS).join(', ')}`);
  }
  if (channels !== spec.channels) {
    throw new ValidationError('capture-channels', `${label}: format ${format} has ${spec.channels} channels, received ${channels}`);
  }
  if (!(data instanceof spec.array)) {
    const actual = data?.constructor?.name ?? String(data);
    throw new CapabilityError('capture-type', `${label}: format ${format} readback must be a ${spec.array.name}, received ${actual}; the backend read the wrong texture or the format declaration is stale`);
  }
  requireInteger(width, `${label}.width`, { minimum: 1 });
  requireInteger(height, `${label}.height`, { minimum: 1 });
  const packed = unpadRows(data, width, height, channels);
  const rows = toTopLeftRows(packed, width, height, { channels, rowOrder });
  const values = new Float32Array(rows.length);
  for (let i = 0; i < rows.length; ++i) values[i] = spec.decode(rows[i]);
  return { label, width, height, channels, format, encoding: spec.encoding, data: values };
}

/** Reinterpret (not convert) the declared encoding, used only for a diagnosed encoding-mismatch hint. */
export function reinterpretEncoding(capture, encoding) {
  if (encoding !== 'srgb' && encoding !== 'display-linear') {
    throw new ValidationError('capture-encoding', `Unknown capture encoding "${encoding}"`);
  }
  return { ...capture, encoding, reinterpreted: true };
}

function requireSameShape(reference, candidate, label) {
  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    throw new ValidationError('capture-shape', `${label}: capture sizes differ (reference ${reference.width}x${reference.height}, candidate ${candidate.width}x${candidate.height})`);
  }
  if (reference.channels !== candidate.channels) {
    throw new ValidationError('capture-shape', `${label}: capture channel counts differ (${reference.channels} vs ${candidate.channels})`);
  }
  const expected = reference.width * reference.height * reference.channels;
  if (reference.data.length !== expected || candidate.data.length !== expected) {
    throw new ValidationError('capture-shape', `${label}: capture data lengths do not match ${reference.width}x${reference.height}x${reference.channels}`);
  }
}

export function toLinearDomain(capture) {
  if (capture.encoding === 'display-linear') return capture.data;
  if (capture.encoding !== 'srgb') throw new ValidationError('capture-encoding', `Unknown capture encoding "${capture.encoding}"`);
  const result = new Float32Array(capture.data.length);
  for (let i = 0; i < capture.data.length; ++i) result[i] = srgbDecode(capture.data[i]);
  return result;
}

export function toSrgbCodeDomain(capture) {
  if (capture.encoding === 'srgb') return capture.data;
  if (capture.encoding !== 'display-linear') throw new ValidationError('capture-encoding', `Unknown capture encoding "${capture.encoding}"`);
  const result = new Float32Array(capture.data.length);
  for (let i = 0; i < capture.data.length; ++i) result[i] = srgbEncode(capture.data[i]);
  return result;
}

// ---------------------------------------------------------------------------------------------
// Content checks: a frame that drew nothing, drew a constant image, or produced non-finite values is
// rejected before it can be reported as a parity or timing success.

export function captureStats(capture, { threshold = 1 / 255 } = {}) {
  const { width, height } = capture;
  const pixels = width * height;
  const code = toSrgbCodeDomain(capture);
  const distinct = new Set();
  let nonFinite = 0, lit = 0, black = 0, sum = 0, squares = 0, min = Infinity, max = -Infinity;
  for (let p = 0; p < pixels; ++p) {
    const r = code[p * 4], g = code[p * 4 + 1], b = code[p * 4 + 2];
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) { ++nonFinite; continue; }
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += luminance;
    squares += luminance * luminance;
    if (luminance < min) min = luminance;
    if (luminance > max) max = luminance;
    if (Math.max(r, g, b) > threshold) ++lit; else ++black;
    distinct.add(((Math.round(r * 255) & 255) << 16) | ((Math.round(g * 255) & 255) << 8) | (Math.round(b * 255) & 255));
  }
  const considered = pixels - nonFinite;
  const meanLuminance = considered ? sum / considered : null;
  return {
    label: capture.label,
    pixels,
    nonFinite,
    litFraction: considered ? lit / considered : null,
    blackFraction: considered ? black / considered : null,
    distinctColors: distinct.size,
    meanLuminance,
    stdLuminance: considered ? Math.sqrt(Math.max(0, squares / considered - meanLuminance * meanLuminance)) : null,
    minLuminance: considered ? min : null,
    maxLuminance: considered ? max : null,
    encoding: capture.encoding,
  };
}

export function assertCaptureContent(stats, {
  label = stats.label ?? 'capture',
  minimumLitFraction = 0.001,
  maximumLitFraction = 0.99,
  minimumDistinctColors = 32,
  maximumNonFinite = 0,
} = {}) {
  if (stats.nonFinite > maximumNonFinite) {
    throw new ValidationError('non-finite-capture', `${label}: ${stats.nonFinite} of ${stats.pixels} pixels are non-finite; rejecting the frame`, stats);
  }
  if (stats.distinctColors < minimumDistinctColors) {
    throw new ValidationError('blank-capture', `${label}: only ${stats.distinctColors} distinct display colors (minimum ${minimumDistinctColors}); the pipeline did not present a rendered frame`, stats);
  }
  if (!(stats.litFraction >= minimumLitFraction)) {
    throw new ValidationError('empty-coverage', `${label}: lit fraction ${stats.litFraction} is below ${minimumLitFraction}; the scene/model appears not to be drawn`, stats);
  }
  if (stats.litFraction > maximumLitFraction) {
    throw new ValidationError('saturated-coverage', `${label}: lit fraction ${stats.litFraction} exceeds ${maximumLitFraction}; the frame is not the expected black-background scene`, stats);
  }
  return stats;
}

export function compareCoverage(reference, candidate, { label = 'coverage', maxLitFractionDelta = 0.02 } = {}) {
  const litFractionDelta = Math.abs(reference.litFraction - candidate.litFraction);
  const reasons = [];
  if (!(litFractionDelta <= maxLitFractionDelta)) {
    reasons.push(`lit fraction differs by ${(litFractionDelta * 100).toFixed(2)}% (${reference.litFraction} vs ${candidate.litFraction}), limit ${(maxLitFractionDelta * 100).toFixed(2)}%`);
  }
  return { label, litFractionDelta, maxLitFractionDelta, reasons, pass: reasons.length === 0 };
}

// ---------------------------------------------------------------------------------------------
// Display parity tolerances.

/**
 * Default full-frame display tolerance. Values are display-linear except the code-step fields.
 *
 * The WebGL reference is an 8-bit sRGB canvas (one half sRGB code step is ~0.0039 in code, up to ~0.012 in
 * linear at white) and the native presentation target may be 8-bit linear or half float, so quantization
 * alone accounts for up to ~4/255 in linear. `relTolerance` covers the documented node-vs-GLSL material
 * difference measured on the geometry stage (encoded-HDR RMSE ~4.7e-4, interior max ~0.055) plus bloom and
 * tone-map rounding. Differences adjacent to a reference silhouette or shading discontinuity (reference
 * sRGB-code gradient >= `edgeGradientStep` within `edgeRadius`) are reported as edge differences instead of
 * failing, mirroring the geometry probe's separate edge/interior reporting. Everywhere else (flat surfaces)
 * the gates are strict: an unexplained visible difference fails, so a missing stage, wrong coordinate
 * orientation, stale history or mirrored dither pattern cannot pass. `maxFlatVisibleFraction` allows 0.02%
 * of pixels (~108 at 900x600) for isolated single-pixel rounding.
 */
export const DISPLAY_TOLERANCE = Object.freeze({
  name: 'display-parity-v1',
  domain: 'display-linear',
  absTolerance: 4 / 255,
  relTolerance: 0.03,
  rmse: 12 / 255,
  flatRmse: 3 / 255,
  maxOutlierFraction: 0.002,
  hardAbs: 40 / 255,
  maxHardFraction: 0.0005,
  visibleCodeStep: 2 / 255,
  maxFlatVisibleFraction: 0.0002,
  maxVisibleFraction: 0.06,
  edgeGradientStep: 3 / 255,
  edgeRadius: 2,
});

/** Tighter tolerance for two captures of the same backend after it has converged (TAA still frames). */
export const STILL_TOLERANCE = Object.freeze({
  ...DISPLAY_TOLERANCE,
  name: 'still-convergence-v1',
  absTolerance: 1 / 255,
  relTolerance: 0.01,
  rmse: 3 / 255,
  flatRmse: 1 / 255,
  maxOutlierFraction: 0.0005,
  hardAbs: 8 / 255,
  maxHardFraction: 0,
  visibleCodeStep: 1 / 255,
  maxFlatVisibleFraction: 0,
  maxVisibleFraction: 0.002,
});

function localGradient(code, width, height, channels) {
  const gradient = new Float32Array(width * height);
  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) {
      const p = y * width + x;
      let peak = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        for (let c = 0; c < 3; ++c) peak = Math.max(peak, Math.abs(code[p * channels + c] - code[q * channels + c]));
      }
      gradient[p] = peak;
    }
  }
  return gradient;
}

function dilateMax(values, width, height, radius) {
  if (radius <= 0) return values;
  const result = new Float32Array(values.length);
  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) {
      let peak = 0;
      for (let dy = -radius; dy <= radius; ++dy) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -radius; dx <= radius; ++dx) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const value = values[ny * width + nx];
          if (value > peak) peak = value;
        }
      }
      result[y * width + x] = peak;
    }
  }
  return result;
}

function percentileFromHistogram(histogram, total, fraction) {
  if (total <= 0) return 0;
  const target = Math.max(1, Math.ceil(total * fraction));
  let accumulated = 0;
  for (let step = 0; step < histogram.length; ++step) {
    accumulated += histogram[step];
    if (accumulated >= target) return step / 255;
  }
  return (histogram.length - 1) / 255;
}

/**
 * Compare two normalized display captures. Reports the light-output error (display-linear abs+rel tolerance,
 * RMSE, hard outliers) separately for flat surfaces and for edge-adjacent pixels, and classifies visible
 * differences (sRGB code steps) the same way. `pass` is false for non-finite values, an exceeded
 * flat-surface outlier/hard/visible budget or an exceeded flat-surface RMSE, with every reason in `reasons`.
 * Edge-adjacent differences are reported (counts, maxima, percentiles) but not failed: they are the
 * documented node-vs-GLSL shading and silhouette differences, which this harness does not claim identical.
 */
export function compareCaptures(reference, candidate, {
  tolerance = DISPLAY_TOLERANCE,
  channels = [0, 1, 2],
  label = 'frames',
} = {}) {
  requireSameShape(reference, candidate, label);
  const { width, height, channels: stride } = reference;
  const pixels = width * height;
  const referenceLinear = toLinearDomain(reference);
  const candidateLinear = toLinearDomain(candidate);
  const referenceCode = toSrgbCodeDomain(reference);
  const candidateCode = toSrgbCodeDomain(candidate);
  const edge = dilateMax(localGradient(referenceCode, width, height, stride), width, height, tolerance.edgeRadius);

  let comparedPixels = 0, comparedFlatPixels = 0, nonFinite = 0;
  let comparedChannels = 0, flatChannels = 0, edgeChannels = 0;
  let sumAbs = 0, sumSquares = 0, flatSquares = 0, maxAbs = 0;
  let flatOutlierChannels = 0, edgeOutlierChannels = 0, flatHardChannels = 0;
  let visiblePixels = 0, visibleFlatPixels = 0, visibleEdgePixels = 0, maxCodeStep = 0;
  const histogram = new Float64Array(256);

  for (let p = 0; p < pixels; ++p) {
    const edgeAdjacent = edge[p] >= tolerance.edgeGradientStep;
    let pixelVisible = false, pixelFinite = true, codeStep = 0;
    for (const c of channels) {
      const index = p * stride + c;
      const a = referenceLinear[index], b = candidateLinear[index];
      if (!Number.isFinite(a) || !Number.isFinite(b)) { ++nonFinite; pixelFinite = false; continue; }
      const difference = Math.abs(a - b);
      ++comparedChannels;
      sumAbs += difference;
      sumSquares += difference * difference;
      if (difference > maxAbs) maxAbs = difference;
      const allowance = tolerance.absTolerance + tolerance.relTolerance * Math.max(Math.abs(a), Math.abs(b));
      if (edgeAdjacent) {
        ++edgeChannels;
        if (difference > allowance) ++edgeOutlierChannels;
      } else {
        ++flatChannels;
        flatSquares += difference * difference;
        if (difference > allowance) ++flatOutlierChannels;
        if (difference > tolerance.hardAbs) ++flatHardChannels;
      }
      const code = Math.abs(referenceCode[index] - candidateCode[index]);
      if (code > codeStep) codeStep = code;
    }
    if (!pixelFinite) continue;
    ++comparedPixels;
    if (!edgeAdjacent) ++comparedFlatPixels;
    if (codeStep >= tolerance.visibleCodeStep) pixelVisible = true;
    if (codeStep > maxCodeStep) maxCodeStep = codeStep;
    const bin = Math.max(0, Math.min(255, Math.round(codeStep * 255)));
    histogram[bin] += 1;
    if (pixelVisible) {
      ++visiblePixels;
      if (edgeAdjacent) ++visibleEdgePixels; else ++visibleFlatPixels;
    }
  }

  const visibleFlatFraction = comparedPixels ? visibleFlatPixels / comparedPixels : 1;
  const visibleFraction = comparedPixels ? visiblePixels / comparedPixels : 1;
  const flatOutlierFraction = flatChannels ? flatOutlierChannels / flatChannels : 1;
  const flatHardFraction = flatChannels ? flatHardChannels / flatChannels : 1;
  const rmse = comparedChannels ? Math.sqrt(sumSquares / comparedChannels) : null;
  const flatRmse = flatChannels ? Math.sqrt(flatSquares / flatChannels) : null;
  const reasons = [];
  if (nonFinite > 0) reasons.push(`${nonFinite} non-finite channel comparisons`);
  if (comparedPixels === 0) reasons.push('no comparable pixels');
  if (comparedFlatPixels === 0) reasons.push('no comparable flat-surface pixels');
  if (flatOutlierFraction > tolerance.maxOutlierFraction) reasons.push(`flat-surface outlier channel fraction ${flatOutlierFraction.toExponential(3)} exceeds ${tolerance.maxOutlierFraction}`);
  if (flatHardFraction > tolerance.maxHardFraction) reasons.push(`flat-surface hard-difference channel fraction ${flatHardFraction.toExponential(3)} exceeds ${tolerance.maxHardFraction}`);
  if (visibleFlatFraction > tolerance.maxFlatVisibleFraction) reasons.push(`unexplained flat-surface visible difference fraction ${visibleFlatFraction.toExponential(3)} exceeds ${tolerance.maxFlatVisibleFraction}`);
  if (visibleFraction > tolerance.maxVisibleFraction) reasons.push(`visible difference covers ${(visibleFraction * 100).toFixed(2)}% of pixels, exceeding ${(tolerance.maxVisibleFraction * 100).toFixed(2)}%`);
  if (!(flatRmse <= tolerance.flatRmse)) reasons.push(`flat-surface display-linear RMSE ${flatRmse} exceeds ${tolerance.flatRmse}`);
  if (!(rmse <= tolerance.rmse)) reasons.push(`whole-frame display-linear RMSE ${rmse} exceeds ${tolerance.rmse}`);

  return {
    label,
    domain: tolerance.domain,
    tolerance: tolerance.name,
    comparedPixels,
    comparedFlatPixels,
    comparedChannels,
    flatChannels,
    edgeChannels,
    nonFinite,
    maxAbs,
    meanAbs: comparedChannels ? sumAbs / comparedChannels : null,
    rmse,
    flatRmse,
    flatOutlierChannels,
    flatOutlierFraction,
    edgeOutlierChannels,
    flatHardChannels,
    flatHardFraction,
    visiblePixels,
    visibleFlatPixels,
    visibleEdgePixels,
    visibleFlatFraction,
    visibleFraction,
    maxCodeStep,
    codeDiffPercentiles: {
      p50: percentileFromHistogram(histogram, comparedPixels, 0.5),
      p99: percentileFromHistogram(histogram, comparedPixels, 0.99),
      p999: percentileFromHistogram(histogram, comparedPixels, 0.999),
      max: maxCodeStep,
    },
    reasons,
    pass: reasons.length === 0,
  };
}

/** Per-pixel maximum visible difference in sRGB code steps, for error maps and worst-region reporting. */
export function createErrorMap(reference, candidate, { channels = [0, 1, 2], label = 'error map' } = {}) {
  requireSameShape(reference, candidate, label);
  const { width, height, channels: stride } = reference;
  const referenceCode = toSrgbCodeDomain(reference);
  const candidateCode = toSrgbCodeDomain(candidate);
  const data = new Uint8Array(width * height);
  let maxStep = 0, visiblePixels = 0;
  for (let p = 0; p < width * height; ++p) {
    let step = 0;
    for (const c of channels) {
      const index = p * stride + c;
      const a = referenceCode[index], b = candidateCode[index];
      if (!Number.isFinite(a) || !Number.isFinite(b)) { step = 255; break; }
      step = Math.max(step, Math.abs(a - b));
    }
    const quantized = Math.min(255, Math.round(step * 255));
    data[p] = quantized;
    if (quantized > maxStep) maxStep = quantized;
    if (quantized >= Math.round(DISPLAY_TOLERANCE.visibleCodeStep * 255)) ++visiblePixels;
  }
  return { label, width, height, data, maxStep, visiblePixels };
}

/** Worst 32x32 (default) regions of an error map, for locating an unexplained difference. */
export function tileSummary(errorMap, { tile = 32, limit = 8 } = {}) {
  const { width, height, data } = errorMap;
  requireInteger(tile, 'tile', { minimum: 1 });
  requireInteger(limit, 'limit', { minimum: 1 });
  const tiles = [];
  for (let y = 0; y < height; y += tile) {
    for (let x = 0; x < width; x += tile) {
      const w = Math.min(tile, width - x), h = Math.min(tile, height - y);
      let peak = 0, sum = 0;
      for (let dy = 0; dy < h; ++dy) {
        for (let dx = 0; dx < w; ++dx) {
          const value = data[(y + dy) * width + x + dx];
          if (value > peak) peak = value;
          sum += value;
        }
      }
      tiles.push({ x, y, width: w, height: h, maxStep: peak, meanStep: sum / (w * h) });
    }
  }
  tiles.sort((a, b) => b.maxStep - a.maxStep || b.meanStep - a.meanStep);
  return tiles.slice(0, limit);
}

/** Consecutive-capture convergence, used for the deterministic still TAA sequence of one backend. */
export function convergenceStats(frames, {
  tolerance = STILL_TOLERANCE,
  label = 'convergence',
  tail = 3,
  maxTailCodeStep = 1 / 255,
} = {}) {
  if (!Array.isArray(frames)) throw new ValidationError('convergence-input', `${label}: frames must be an array of captures`);
  requireInteger(tail, `${label}.tail`, { minimum: 1 });
  if (frames.length < tail + 1) {
    throw new ValidationError('convergence-input', `${label}: need at least ${tail + 1} captures to judge convergence, received ${frames.length}`);
  }
  const steps = [];
  for (let i = 1; i < frames.length; ++i) {
    const comparison = compareCaptures(frames[i - 1], frames[i], { tolerance, label: `${label} frame ${i}` });
    steps.push({
      frame: i,
      rmse: comparison.rmse,
      maxAbs: comparison.maxAbs,
      nonFinite: comparison.nonFinite,
      maxCodeStep: comparison.codeDiffPercentiles.max,
      p999CodeStep: comparison.codeDiffPercentiles.p999,
      visibleFlatPixels: comparison.visibleFlatPixels,
      pass: comparison.pass,
      reasons: comparison.reasons,
    });
  }
  const tailSteps = steps.slice(-tail);
  const reasons = [];
  for (const step of tailSteps) {
    if (!step.pass) reasons.push(`frame ${step.frame} differs beyond the still tolerance: ${step.reasons.join('; ')}`);
    if (!(step.maxCodeStep <= maxTailCodeStep)) reasons.push(`frame ${step.frame} still changes by ${(step.maxCodeStep * 255).toFixed(2)} code steps (limit ${(maxTailCodeStep * 255).toFixed(2)})`);
  }
  return { label, tolerance: tolerance.name, steps, tail, maxTailCodeStep, converged: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------------------------
// Timing. A measurement is only reported if every sample is a finite positive duration and the repeated
// rounds agree; disjoint or invalid measurements throw instead of being averaged into a plausible number.

export function timingStats(samples, { label = 'timing', minimumSamples = 1 } = {}) {
  if (!Array.isArray(samples)) throw new ValidationError('timing-type', `${label}: samples must be an array`);
  if (samples.length < minimumSamples) {
    throw new ValidationError('timing-empty', `${label}: expected at least ${minimumSamples} samples, received ${samples.length}`);
  }
  const values = [];
  for (let i = 0; i < samples.length; ++i) {
    const value = samples[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ValidationError('timing-invalid', `${label}: sample ${i} is not a finite number (${String(value)})`);
    }
    if (value <= 0) {
      throw new ValidationError('timing-invalid', `${label}: sample ${i} is not a positive duration (${value} ms); zero, negative or unpopulated GPU timestamps are rejected`);
    }
    values.push(value);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction) => sorted[Math.min(Math.floor(sorted.length * fraction), sorted.length - 1)];
  const middle = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let variance = 0;
  for (const value of values) variance += (value - mean) ** 2;
  return {
    label,
    samples: values.length,
    medianMs: median,
    p10Ms: percentile(0.1),
    p90Ms: percentile(0.9),
    meanMs: mean,
    stdMs: Math.sqrt(variance / values.length),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
  };
}

/** Reject round medians that disagree, which indicates the GPU was shared, thermal-throttled or disjoint. */
export function roundStability(roundMedians, { label = 'timing', maxRelativeSpread = 0.25, minimumRounds = 2 } = {}) {
  if (!Array.isArray(roundMedians) || roundMedians.length < minimumRounds) {
    throw new ValidationError('timing-rounds', `${label}: need at least ${minimumRounds} alternating rounds to reject unstable measurements, received ${Array.isArray(roundMedians) ? roundMedians.length : String(roundMedians)}`);
  }
  const stats = timingStats(roundMedians, { label: `${label} rounds`, minimumSamples: minimumRounds });
  const spread = (stats.maxMs - stats.minMs) / stats.medianMs;
  if (!(spread <= maxRelativeSpread)) {
    throw new ValidationError('timing-disjoint', `${label}: round medians ${roundMedians.map((value) => value.toFixed(3)).join(', ')} ms spread ${(spread * 100).toFixed(1)}% exceeds ${(maxRelativeSpread * 100).toFixed(0)}%; the measurement is unstable or the GPU was shared, discard and rerun`);
  }
  return { label, rounds: roundMedians.length, mediansMs: [...roundMedians], spread, maxRelativeSpread };
}

/** Whole-frame sustained cadence: wall-clock milliseconds per submitted frame, reported apart from GPU times. */
export function sustainedStats(samples, { label = 'sustained' } = {}) {
  const stats = timingStats(samples, { label, minimumSamples: 2 });
  return { ...stats, framesPerSecond: 1000 / stats.medianMs };
}

// ---------------------------------------------------------------------------------------------
// Exclusivity: one browser/GPU owner at a time. A second harness refuses to start rather than sharing
// the device with another measurement.

export const GPU_LOCK_KEY = '__monkViewerExclusiveGpuOwner';

export function acquireExclusiveGpuLock(scope = globalThis, owner = 'webgpu-validation') {
  if (!scope || typeof scope !== 'object') throw new ValidationError('gpu-lock-scope', 'Exclusive GPU lock requires an object scope');
  const existing = scope[GPU_LOCK_KEY];
  if (existing) {
    throw new ValidationError('gpu-lock-held', `Exclusive GPU ownership is held by "${existing.owner}" since ${new Date(existing.acquiredAt).toISOString()}; let it finish instead of running concurrent GPU work`);
  }
  const token = { owner, acquiredAt: Date.now() };
  scope[GPU_LOCK_KEY] = token;
  let released = false;
  return {
    owner,
    acquiredAt: token.acquiredAt,
    release() {
      if (released) return;
      released = true;
      if (scope[GPU_LOCK_KEY] === token) delete scope[GPU_LOCK_KEY];
    },
  };
}
