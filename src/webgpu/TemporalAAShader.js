// Native TSL port of the GLSL TemporalAAPass fragment shader. Every lookup converts from the algorithmic
// WebGL bottom-left space to native top-left texture storage exactly once, in the helpers below.
import * as GPU from 'three/webgpu';
import * as TSL from 'three/tsl';

const {
  Fn,
  If,
  vec2,
  vec3,
  vec4,
  ivec2,
  int,
  float,
  texture,
  textureLoad,
  textureSize,
  min,
  max,
  abs,
  exp,
  sqrt,
  floor,
  clamp,
  mix,
  smoothstep,
  select,
  length,
  property,
  outputStruct,
  screenCoordinate
} = TSL;

// Centre, the 4 direct neighbours, then the 4 diagonals. neighbourCount selects the cross (5) or the full 3x3 (9).
const NEIGHBOURS = [
  [0, 0], [-1, 0], [1, 0], [0, -1], [0, 1],
  [-1, -1], [1, -1], [-1, 1], [1, 1]
];

/**
 * The discrete settings a specialized material bakes in as constants, with their node types. Everything else (blend,
 * gammas, tolerances, per-frame state) stays a uniform.
 */
export const SPECIALIZED_SETTINGS = Object.freeze({
  neighbourCount: 'int',
  boxMode: 'int',
  debugView: 'int',
  jitterCompensation: 'float',
  clipTowardsCurrent: 'bool',
  depthRejection: 'bool',
  motionRejection: 'bool',
  thinFeatureLocks: 'bool',
  edgeAdaptiveBlend: 'bool',
  sampleConfidence: 'bool',
  useVelocityBuffer: 'bool'
});

const constantNode = (type, value) => type === 'int' ? int(value) : type === 'float' ? float(value) : TSL.bool(value);

/**
 * Builds the TSL fullscreen material that reads the current frame and the previous history and writes
 * history/output/state as one three-attachment draw.
 *
 * `upscale` builds the temporal upscaling variant (the current frame smaller than the output). It is a separate
 * material rather than a uniform branch: the extra live values of the upscaling path cost the native one occupancy
 * (~35% of the TAA pass at 2560x1600 on an M1) even when skipped, so the native material is the unchanged graph.
 *
 * @param {Object} uniforms - TSL uniform nodes shared with {@link WebGpuTemporalAA}.
 * @param {Object} textures - TSL texture nodes: color, depth, velocity, reactive, history and state.
 * `constants` specializes the material: the listed {@link SPECIALIZED_SETTINGS} become constants instead of uniforms,
 * so the shader compiler drops the disabled paths. The math is the same; every feature switch otherwise stays in the
 * shader as a uniform branch, and the union of all of them costs registers and occupancy (measured ~1.4 ms per frame
 * at 2560x1600 on an M1, TAA pass and bypass together).
 *
 * @param {Object} [options]
 * @param {boolean} [options.upscale=false] - Build the temporal upscaling variant.
 * @param {?Object} [options.constants=null] - Values for {@link SPECIALIZED_SETTINGS}; null keeps them all uniforms.
 * @returns {GPU.MeshBasicNodeMaterial} The resolve material. It owns no textures.
 */
export function createTemporalAAMaterial(uniforms, textures, { upscale = false, constants = null } = {}) {

  if (constants !== null) {
    uniforms = { ...uniforms };
    for (const [name, type] of Object.entries(SPECIALIZED_SETTINGS)) uniforms[name] = constantNode(type, constants[name]);
  }

  const {
    enabled,
    exposure,
    blend,
    varianceGamma,
    historyValid,
    clipHistory,
    moving,
    filterSharpness,
    motionFilterSharpness,
    motionFilterScale,
    jitterCompensation,
    neighbourCount,
    boxMode,
    clipTowardsCurrent,
    depthRejection,
    depthTolerance,
    motionRejection,
    motionTolerance,
    trustedGamma,
    disocclusionBlend,
    thinFeatureLocks,
    lockStep,
    lockMaxSpeed,
    lockSimilarity,
    lockStrength,
    edgeAdaptiveBlend,
    edgeBlend,
    sampleConfidence,
    reactiveStrength,
    debugView,
    useVelocityBuffer,
    inverseViewProjectionJittered,
    viewProjection,
    previousViewProjection,
    objectMotion,
    texelSize,
    size,
    renderTexelSize,
    renderSize,
    inputScale,
    upscaleConfidenceFloor,
    jitterOffset,
    previousJitter,
    backgroundBounds
  } = uniforms;

  const { color, depth, velocity, reactive, history, state } = textures;

  const height = () => int(size.y);

  // Algorithmic (bottom-left) -> storage (top-left). The fragment writes its own pixel, so only reads convert.
  const logicalPixel = () => ivec2(screenCoordinate.x, height().sub(1).sub(int(screenCoordinate.y)));
  const sampleLogical = (source, uv) => texture(source, vec2(uv.x, float(1).sub(uv.y)));
  // Output-sized textures: the history state, and natively the current frame too
  const loadLogical = (source, pixel) => textureLoad(source, ivec2(pixel.x, height().sub(1).sub(pixel.y)));
  // Upscaling: render-sized textures (the current frame)
  const loadRender = upscale ?
    (source, pixel) => textureLoad(source, ivec2(pixel.x, int(renderSize.y).sub(1).sub(pixel.y))) : loadLogical;
  const textureSizeInt = (source) => ivec2(textureSize(source));
  // Texel steps of the current frame's depth
  const inputTexelSize = upscale ? renderTexelSize : texelSize;

  // Upscaling: the current frame is rendered at renderSize, jittered by jitterOffset render pixels, so the sample of
  // render texel k sits at k + 0.5 + jitter. Output pixel centres map to renderPosition in the same continuous render
  // coordinates; renderBase is the texel that contains it. Natively renderBase is the output pixel, centreOffset 0.
  const renderPosition = () => vec2(logicalPixel()).add(0.5).mul(inputScale);
  const renderBase = upscale ? () => ivec2(floor(renderPosition())) : logicalPixel;

  const RGBToYCoCg = (c) => vec3(
    c.r.mul(0.25).add(c.g.mul(0.5)).add(c.b.mul(0.25)),
    c.r.mul(0.5).sub(c.b.mul(0.5)),
    c.r.mul(-0.25).add(c.g.mul(0.5)).sub(c.b.mul(0.25))
  );

  const YCoCgToRGB = (c) => vec3(
    c.x.add(c.y).sub(c.z),
    c.x.add(c.z),
    c.x.sub(c.y).sub(c.z)
  );

  const encode = (c) => {
    const value = max(c, vec3(0)).mul(exposure);
    return value.div(value.add(1.0));
  };

  const decode = (e) => {
    const clamped = min(e, vec3(0.9995));
    return clamped.div(clamped.oneMinus().mul(exposure));
  };

  // Encoded YCoCg colour of the current frame at a render texel offset from renderBase.
  const sampleCurrent = (base, offset) => {
    const maximum = textureSizeInt(color).sub(1);
    // Natively base is null and the output pixel is rebuilt per load, exactly as before upscaling existed.
    const coord = clamp((base ?? logicalPixel()).add(ivec2(offset[0], offset[1])), ivec2(0), maximum);
    return RGBToYCoCg(encode(loadRender(color, coord).rgb));
  };

  // The current frame at the output pixel without temporal reconstruction: its own texel natively, bilinear when
  // upscaling (the naive upscale, also used outside the history bounds and with TAA off).
  const currentInput = (uv) => upscale ? sampleLogical(color, uv).rgb : loadLogical(color, logicalPixel()).rgb;

  // 5-tap Catmull-Rom. Bilinear history blurs a little more every frame while the model rotates.
  const sampleHistory = (uv) => {
    const texSize = vec2(1.0).div(texelSize);
    const samplePos = uv.mul(texSize);
    const texPos1 = floor(samplePos.sub(0.5)).add(0.5);
    const f = samplePos.sub(texPos1);

    const w0 = f.mul(f.mul(f.mul(-0.5).add(1.0)).sub(0.5));
    const w1 = f.mul(f).mul(f.mul(1.5).add(-2.5)).add(1.0);
    const w2 = f.mul(f.mul(f.mul(-1.5).add(2.0)).add(0.5));
    const w3 = f.mul(f).mul(f.mul(0.5).add(-0.5));

    const w12 = w1.add(w2);
    const texPos0 = texPos1.sub(1.0).mul(texelSize);
    const texPos3 = texPos1.add(2.0).mul(texelSize);
    const texPos12 = texPos1.add(w2.div(w12)).mul(texelSize);

    let result = sampleLogical(history, vec2(texPos12.x, texPos0.y)).rgb.mul(w12.x).mul(w0.y);
    result = result.add(sampleLogical(history, vec2(texPos0.x, texPos12.y)).rgb.mul(w0.x).mul(w12.y));
    result = result.add(sampleLogical(history, texPos12).rgb.mul(w12.x).mul(w12.y));
    result = result.add(sampleLogical(history, vec2(texPos3.x, texPos12.y)).rgb.mul(w3.x).mul(w12.y));
    result = result.add(sampleLogical(history, vec2(texPos12.x, texPos3.y)).rgb.mul(w12.x).mul(w3.y));

    const weight = w12.x.mul(w0.y).add(w0.x.mul(w12.y)).add(w12.x.mul(w12.y))
      .add(w3.x.mul(w12.y)).add(w12.x.mul(w3.y));
    return max(result.div(weight), vec3(0));
  };

  // Moves q towards the centre of the box until it lies inside.
  const clipToBox = (boxMin, boxMax, q) => {
    const center = boxMax.add(boxMin).mul(0.5);
    const extents = boxMax.sub(boxMin).mul(0.5).add(1e-6);
    const v = q.sub(center);
    const a = abs(v.div(extents));
    const m = max(a.x, max(a.y, a.z));
    return select(m.greaterThan(1.0), center.add(v.div(m)), q);
  };

  // Moves q along the segment towards the current colour until it lies inside the box (Pedersen 2016).
  const clipTowards = (boxMin, boxMax, target, q) => {
    const clampedTarget = clamp(target, boxMin, boxMax);
    const r = q.sub(clampedTarget).toVar();
    const rMax = boxMax.sub(clampedTarget);
    const rMin = boxMin.sub(clampedTarget);
    const EPSILON = 1e-7;

    If(r.x.greaterThan(rMax.x.add(EPSILON)), () => { r.mulAssign(rMax.x.div(r.x)); });
    If(r.y.greaterThan(rMax.y.add(EPSILON)), () => { r.mulAssign(rMax.y.div(r.y)); });
    If(r.z.greaterThan(rMax.z.add(EPSILON)), () => { r.mulAssign(rMax.z.div(r.z)); });
    If(r.x.lessThan(rMin.x.sub(EPSILON)), () => { r.mulAssign(rMin.x.div(r.x)); });
    If(r.y.lessThan(rMin.y.sub(EPSILON)), () => { r.mulAssign(rMin.y.div(r.y)); });
    If(r.z.lessThan(rMin.z.sub(EPSILON)), () => { r.mulAssign(rMin.z.div(r.z)); });

    return clampedTarget.add(r);
  };

  // Where the surface seen at uv was on screen in the previous frame (xy), its view depth then (z) and now (w).
  // The depths are 0 for the background.
  const reproject = Fn(([uv, surfaceDepth]) => {
    const worldClip = inverseViewProjectionJittered.mul(vec4(vec3(uv.x, uv.y, surfaceDepth).mul(2.0).sub(1.0), 1.0));
    const world = worldClip.xyz.div(worldClip.w);
    const current = viewProjection.mul(vec4(world, 1.0));

    const velocitySample = sampleLogical(velocity, uv);
    const previous = previousViewProjection.mul(objectMotion.mul(vec4(world, 1.0)));
    const cameraVelocity = current.xy.div(current.w).sub(previous.xy.div(previous.w)).mul(0.5);

    const withVelocity = vec4(
      uv.x.sub(velocitySample.x),
      uv.y.sub(velocitySample.y),
      current.w.mul(velocitySample.z.add(1.0)),
      current.w
    );
    const withObjectMotion = vec4(
      uv.x.sub(cameraVelocity.x),
      uv.y.sub(cameraVelocity.y),
      previous.w,
      current.w
    );

    return select(surfaceDepth.greaterThanEqual(1.0), vec4(uv.x, uv.y, 0.0, 0.0),
      select(useVelocityBuffer, withVelocity, withObjectMotion));
  });

  // Ratio of two encoded lumas. Small absolute differences count as alike too, so that faint near-black gradients
  // don't lock and keep their history as trails.
  const similar = (a, b) => abs(a.sub(b)).lessThan(0.06)
    .or(min(a, b).div(max(a, b)).greaterThanEqual(lockSimilarity));

  const historyColor = property('vec4');
  const outputColor = property('vec3');
  const stateColor = property('vec4');

  const resolve = Fn(() => {
    const uv = vec2(logicalPixel()).add(0.5).div(size);

    // The viewer is one bounded rigid object against black, before bloom. Outside its padded history footprint
    // there has never been a signal to reconstruct. Write ALL attachments so stale history cannot return later.
    const outside = uv.x.lessThan(backgroundBounds.x).or(uv.y.lessThan(backgroundBounds.y))
      .or(uv.x.greaterThan(backgroundBounds.z)).or(uv.y.greaterThan(backgroundBounds.w));

    If(outside, () => {
      const input = currentInput(uv);
      historyColor.assign(select(enabled, vec4(0.0, 0.0, 0.0, 1.0), vec4(input, 1.0)));
      outputColor.assign(select(enabled, vec3(0.0), input));
      stateColor.assign(vec4(0.0));
    }).Else(() => {
      // Velocity of the closest surface in the neighbourhood. The MSAA depth resolve keeps a single sample, so the
      // depth of a sub-pixel edge is often the background's: without this, thin edges would lag behind as static.
      const closestUv = uv.toVar();
      const closestDepth = float(1.0).toVar();

      for (let i = 0; i < 9; ++i) {
        If(neighbourCount.greaterThan(int(i)), () => {
          const candidate = uv.add(vec2(NEIGHBOURS[i][0], NEIGHBOURS[i][1]).mul(inputTexelSize));
          const candidateDepth = sampleLogical(depth, candidate);
          If(candidateDepth.lessThan(closestDepth), () => {
            closestDepth.assign(candidateDepth);
            closestUv.assign(candidate);
          });
        });
      }

      const motionData = reproject(closestUv, closestDepth).toVar('taaMotionData');
      const historyUv = uv.add(motionData.xy.sub(closestUv))
        .add(jitterOffset.sub(previousJitter).mul(jitterCompensation).mul(inputTexelSize)).toVar('taaHistoryUv');

      // The motion this pixel is reprojected with, in pixels. Stored for the motion blur and the motion validation.
      const velocityPixels = closestUv.sub(motionData.xy).div(texelSize).toVar('taaVelocityPixels');
      const motion = length(historyUv.sub(uv).div(texelSize)).toVar('taaMotion');

      // Disabled TAA is a pure bypass: no jitter, no filtering. The pipeline reports no motion and uses full bounds,
      // so the state is not consumed; it is still written fresh rather than leaving stale motion behind.
      If(enabled.not(), () => {
        const input = currentInput(uv);
        historyColor.assign(vec4(input, 1.0));
        outputColor.assign(input);
        stateColor.assign(vec4(motionData.w, 0.0, velocityPixels.x, velocityPixels.y));
      }).Else(() => {
        const sharpness = mix(filterSharpness, motionFilterSharpness,
          clamp(motion.mul(motionFilterScale), 0.0, 1.0));

        const samples = [];
        const m1 = vec3(0.0).toVar();
        const m2 = vec3(0.0).toVar();
        const minColor = vec3(1e9).toVar();
        const maxColor = vec3(-1e9).toVar();
        const filtered = vec3(0.0).toVar();
        const filterWeight = float(0.0).toVar();
        const lumaMin = float(1e9).toVar();
        const lumaMax = float(-1e9).toVar();
        // Upscaling only: the render texel holding the output pixel centre, the distance from that centre to its
        // sample in render pixels, and the kernel rescaled so that distances count in output pixels (one render
        // pixel is 1 / inputScale output pixels). Kept to three values: the loop below is the same as the native
        // one, extra live state there costs occupancy.
        const base = upscale ? renderBase().toVar('taaRenderBase') : null;
        const baseOffset = upscale ?
          vec2(base).add(0.5).sub(renderPosition()).add(jitterOffset).toVar('taaBaseOffset') : jitterOffset;
        const kernel = upscale ? sharpness.div(inputScale.mul(inputScale)).toVar('taaKernel') : sharpness;

        // All 9 are fetched: the thin feature test and the edge contrast always look at the full 3x3.
        for (let i = 0; i < 9; ++i) {
          const c = sampleCurrent(base, NEIGHBOURS[i]);
          samples[i] = c;
          lumaMin.assign(min(lumaMin, c.x));
          lumaMax.assign(max(lumaMax, c.x));

          If(neighbourCount.greaterThan(int(i)), () => {
            m1.addAssign(c);
            m2.addAssign(c.mul(c));
            minColor.assign(min(minColor, c));
            maxColor.assign(max(maxColor, c));

            // Reconstruct the pixel from the jittered samples around it, weighted by their distance to the pixel
            // centre. Without it, the history converges to a box filter and leaves steps on thin near-horizontal
            // lines. Gaussian, as in Karis 2014. Upscaling measures the distance in output pixels, so the history
            // converges to output-resolution detail: each frame adds mostly where a sample lands near the pixel.
            const d = vec2(NEIGHBOURS[i][0], NEIGHBOURS[i][1]).add(baseOffset);
            const w = exp(d.dot(d).mul(kernel).mul(-1.0));
            filtered.addAssign(c.mul(w));
            filterWeight.addAssign(w);
          });
        }

        // Concrete variable: TSL otherwise materializes this lazy expression where it is first built (inside a
        // conditional history branch) and the final unconditional mix reads an uninitialized var when that branch is
        // skipped, e.g. static convergence sets clipHistory false.
        const current = filtered.div(filterWeight).toVar('taaCurrent');
        // Upscaling: this frame alone, bilinearly upscaled, for pixels without usable history (the Gaussian above is
        // sharp in output pixels, so on its own it shows the render pixel grid); and how close the nearest sample came
        // to the output pixel centre: per axis the samples are one render pixel apart, so the nearest is at most half
        // of one away (Blackman-Harris fit in output pixels, as the sample confidence below). Natively the samples are
        // dense and both are unnecessary.
        const currentSmooth = upscale ?
          RGBToYCoCg(encode(sampleLogical(color, uv).rgb)).toVar('taaCurrentSmooth') : current;
        const nearestConfidence = upscale ? (() => {
          const phase = renderPosition().sub(0.5).sub(jitterOffset);
          const f = phase.sub(floor(phase));
          const nearest = min(f, vec2(1.0).sub(f)).div(inputScale);
          return exp(nearest.dot(nearest).mul(-2.29)).toVar('taaNearestConfidence');
        })() : null;
        const currentDepth = motionData.w.toVar('taaCurrentDepth');

        // Glass and other transparent surfaces (FSR 2 "reactive mask"): their reflections and scratches move on
        // their own, and the depth behind them says nothing about them.
        const reactiveAmount = float(0.0).toVar();

        If(reactiveStrength.greaterThan(0.0), () => {
          // Upscaling: the mask is render-sized; storage coordinates scale directly (both are top-left).
          const pixel = upscale ? ivec2(vec2(screenCoordinate.xy).mul(inputScale)) : ivec2(screenCoordinate);
          const coord = min(pixel, textureSizeInt(reactive).sub(1));
          reactiveAmount.assign(reactiveStrength.mul(textureLoad(reactive, coord).x));
        });

        // Thin feature: no 2x2 quad around the pixel looks like it (FSR 2). A sub-pixel line touches every quad it
        // crosses with a different colour on at least one side, a solid area or a wide edge doesn't.
        const thin = float(0.0).toVar();

        If(thinFeatureLocks, () => {
          const y = samples[0].x;
          const quad0 = similar(y, samples[1].x).and(similar(y, samples[3].x)).and(similar(y, samples[5].x));
          const quad1 = similar(y, samples[2].x).and(similar(y, samples[3].x)).and(similar(y, samples[6].x));
          const quad2 = similar(y, samples[1].x).and(similar(y, samples[4].x)).and(similar(y, samples[7].x));
          const quad3 = similar(y, samples[2].x).and(similar(y, samples[4].x)).and(similar(y, samples[8].x));
          thin.assign(select(
            quad0.or(quad1).or(quad2).or(quad3).not().and(lumaMax.sub(lumaMin).greaterThan(0.05)),
            1.0,
            0.0
          ));
        });

        const offscreen = historyUv.x.lessThan(0.0).or(historyUv.y.lessThan(0.0))
          .or(historyUv.x.greaterThan(1.0)).or(historyUv.y.greaterThan(1.0));

        If(historyValid.not().or(offscreen), () => {
          historyColor.assign(vec4(decode(YCoCgToRGB(currentSmooth)), 1.0));
          outputColor.assign(decode(YCoCgToRGB(currentSmooth)));
          stateColor.assign(vec4(currentDepth, thin.mul(reactiveAmount.oneMinus()),
            velocityPixels.x, velocityPixels.y));
        }).Else(() => {
          // Geometric validation (Nehab et al. 2007). Only the texel the lookup lands in counts.
          const stateSize = textureSizeInt(state);
          const stateCoord = clamp(ivec2(historyUv.mul(vec2(stateSize))), ivec2(0), stateSize.sub(1));
          // One fetch shared by depth validation, motion validation and the lock update; keep it at this common
          // scope so no branch can materialize it after a sibling has already read it.
          const storedState = loadLogical(state, stateCoord).toVar('taaStoredState');
          const match = float(1.0).toVar();

          If(depthRejection, () => {
            const expected = motionData.z;
            const same = select(
              expected.greaterThan(0.0),
              abs(storedState.x.sub(expected)).lessThanEqual(depthTolerance.mul(expected)),
              storedState.x.equal(0.0)
            );
            match.assign(select(same, 1.0, 0.0));
          });

          // Motion validation (motion vector divergence): history that moved very differently belongs elsewhere.
          If(motionRejection, () => {
            const divergence = length(velocityPixels.sub(storedState.zw));
            const same = divergence.lessThanEqual(motionTolerance.add(length(velocityPixels).mul(0.25)));
            match.assign(select(same, match, 0.0));
          });

          // Locks follow the surface and fade linearly over lockFrames; a disocclusion drops them. Glass doesn't lock.
          const lock = thin.toVar();

          If(thinFeatureLocks.and(match.greaterThan(0.0)), () => {
            lock.assign(max(storedState.y.sub(lockStep), thin));
          });

          lock.mulAssign(reactiveAmount.oneMinus());

          // Fast motion: whatever a lock keeps is visibly out of date, and the motion blur hides the steps anyway.
          const speedFade = select(lockMaxSpeed.greaterThan(0.0),
            float(1.0).sub(smoothstep(lockMaxSpeed.mul(0.5), lockMaxSpeed, motion)), 1.0);
          // Reused inside the clipHistory branch and again by debug view 1; materialize at this common scope.
          const lockWeight = lock.mul(lockStrength).mul(match).mul(speedFade).toVar('taaLockWeight');

          // The background has no depth to validate against: only matched surfaces get the relaxed clamp.
          const trusted = depthRejection.and(currentDepth.greaterThan(0.0)).and(match.greaterThan(0.0))
            .toVar('taaTrusted');
          const gamma = select(trusted, mix(trustedGamma, varianceGamma, reactiveAmount), varianceGamma)
            .toVar('taaGamma');

          const n = float(neighbourCount);
          const mean = m1.div(n);
          const sigma = sqrt(max(m2.div(n).sub(mean.mul(mean)), vec3(0.0))).mul(gamma);
          const boxMin = mean.sub(sigma).toVar();
          const boxMax = mean.add(sigma).toVar();

          If(boxMode.equal(int(1)), () => {
            // Min/max, scaled around its centre so that the trusted width still applies.
            const center = maxColor.add(minColor).mul(0.5);
            const extents = maxColor.sub(minColor).mul(0.5).mul(gamma);
            boxMin.assign(center.sub(extents));
            boxMax.assign(center.add(extents));
          }).Else(() => {
            If(boxMode.equal(int(2)), () => {
              // Variance clipping can reach past the colours actually present, the intersection can't (Salvi 2016).
              boxMin.assign(max(boxMin, minColor));
              boxMax.assign(min(boxMax, maxColor));
            });
          });

          // Sampled once at this common scope; read again inside the clipHistory branch and debug views.
          const rawHistory = RGBToYCoCg(encode(sampleHistory(historyUv))).toVar('taaRawHistory');
          const resolvedHistory = rawHistory.toVar('taaResolvedHistory');

          // Upscaling: rejected history is replaced by this frame alone, the smooth upscale rather than the sparse
          // samples. Natively both are the same colour.
          const rejected = depthRejection.or(motionRejection).and(match.equal(0.0));
          const target = upscale ? select(rejected, currentSmooth, current).toVar('taaTarget') : current;

          If(clipHistory, () => {
            If(clipTowardsCurrent, () => {
              // The current colour is what the pixel actually shows, so the clipped history keeps its hue and stays
              // on the right side of an edge (Pedersen 2016).
              resolvedHistory.assign(mix(clipTowards(boxMin, boxMax, target, rawHistory), rawHistory, lockWeight));
            }).Else(() => {
              resolvedHistory.assign(mix(clipToBox(boxMin, boxMax, rawHistory), rawHistory, lockWeight));
            });
          });

          const alpha = blend.toVar();

          If(moving, () => {
            If(edgeAdaptiveBlend, () => {
              // High contrast neighbourhoods accumulate longer (Malan 2012): that's where the jitter shows most.
              const contrast = smoothstep(0.05, 0.35, lumaMax.sub(lumaMin));
              alpha.assign(mix(alpha, min(alpha, edgeBlend),
                contrast.mul(match).mul(reactiveAmount.oneMinus())));
            });

            if (upscale) {
              // This frame only counts as much as its nearest sample is close to the output pixel: what accumulates
              // output-resolution detail from render-resolution frames. Replaces the sample confidence.
              alpha.mulAssign(max(nearestConfidence, upscaleConfidenceFloor));
            } else {
              If(sampleConfidence, () => {
                // Blackman-Harris fit, so the worst jitter position still weighs about a third.
                const confidence = max(exp(jitterOffset.dot(jitterOffset).mul(-2.29)), 0.25);
                alpha.mulAssign(confidence);
              });
            }

            If(rejected, () => {
              alpha.assign(max(alpha, disocclusionBlend));
            });
          });

          const result = mix(resolvedHistory, target, alpha);
          const decoded = decode(YCoCgToRGB(result));

          historyColor.assign(vec4(decoded, 1.0));
          outputColor.assign(decoded);
          stateColor.assign(vec4(currentDepth, lock, velocityPixels.x, velocityPixels.y));

          If(debugView.equal(int(1)), () => {
            // Effective locks in red. Dim: the output feeds the bloom.
            outputColor.assign(mix(outputColor, vec3(0.6, 0.0, 0.0), lockWeight.mul(0.8)));
          }).Else(() => {
            If(debugView.equal(int(2)).and(currentDepth.greaterThan(0.0).or(match.equal(0.0))), () => {
              // Depth validation: trusted surfaces in green, disocclusions in red.
              outputColor.assign(mix(outputColor,
                select(trusted, vec3(0.0, 0.08, 0.0), vec3(0.6, 0.0, 0.0)), 0.5));
            }).Else(() => {
              If(debugView.equal(int(3)), () => {
                // Reactive mask in blue.
                outputColor.assign(mix(outputColor, vec3(0.0, 0.05, 0.6), reactiveAmount.mul(0.7)));
              }).Else(() => {
                If(debugView.equal(int(4)), () => {
                  // Own motion in pixels per frame: red right, green up (negatives as their magnitude), blue = blend.
                  outputColor.assign(vec3(abs(velocityPixels.x).mul(0.1),
                    abs(velocityPixels.y).mul(0.1), alpha));
                });
              });
            });
          });
        });
      });
    });

    return vec4(0.0);
  });

  const material = new GPU.MeshBasicNodeMaterial({
    name: upscale ? 'TemporalAAUpscaleMaterial' : 'TemporalAAMaterial',
    depthTest: false,
    depthWrite: false,
    toneMapped: false
  });
  material.blending = GPU.NoBlending;
  material.colorNode = resolve();
  // Member order matches the render target attachment order: history, output, state.
  material.outputNode = outputStruct(historyColor, outputColor, stateColor);

  return material;

}
