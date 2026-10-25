// Dev-only GPU check, run from aa-lab.html: the GLSL GT7 operator against its CPU port, which tests/gt7-tone-mapping.test.ts
// checks against Polyphony Digital's reference implementation.
import { GT7_PARAMETERS, gt7Constants, gt7ToneMapping, gt7ToneMappingShader } from '../src/postprocessing/GT7ToneMappingEffect.ts';

function inputs() {
  const colors = [];
  for(let i = 0; i <= 64; ++i) {
    const l = Math.pow(10, -3 + i * 5 / 64); // 0.001 to 100, through the toe, linear section, shoulder and clip
    colors.push([l, l, l]);
    for(const [r, g, b] of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0.5, 0.1], [0.2, 0.6, 1], [0.9, 0.85, 0.7], [0.6, 0.1, 0.8]]) {
      colors.push([r * l, g * l, b * l]);
    }
  }
  return colors;
}

// GT7's parameters by default, or the tuned ones: validateGT7(mgr, THREE, mgr.gt7ToneMapping.curve)
export async function validateGT7(mgr, THREE, curve = GT7_PARAMETERS) {
  const renderer = mgr.renderer;
  const colors = inputs();
  const width = colors.length;
  const data = new Float32Array(width * 4);
  colors.forEach(([r, g, b], i) => data.set([r, g, b, 1], i * 4));
  const texture = new THREE.DataTexture(data, width, 1, THREE.RGBAFormat, THREE.FloatType);
  texture.needsUpdate = true;

  const { peak, kA, kB, kC, targetUcs } = gt7Constants(curve);
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      inputBuffer: { value: texture },
      gt7Curve: { value: new THREE.Vector4(peak, curve.midPoint, curve.linearSection, curve.toeStrength) },
      gt7Shoulder: { value: new THREE.Vector4(kA, kB, kC, targetUcs) },
      gt7BlendRatio: { value: curve.blendRatio },
    },
    vertexShader: `in vec3 position; void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `precision highp float;
      uniform highp sampler2D inputBuffer;
      ${gt7ToneMappingShader}
      out vec4 color;
      void main() { color = vec4(gt7ToneMapping(texelFetch(inputBuffer, ivec2(gl_FragCoord.xy), 0).rgb), 1.0); }`,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  const camera = new THREE.Camera();
  const target = new THREE.WebGLRenderTarget(width, 1, { type: THREE.FloatType, depthBuffer: false });
  const output = new Float32Array(width * 4);
  const saved = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(target);
    renderer.render(quad, camera);
    renderer.readRenderTargetPixels(target, 0, 0, width, 1, output);
  } finally {
    renderer.setRenderTarget(saved);
    [texture, material, quad.geometry, target].forEach((x) => x.dispose());
  }

  let maxError = 0, worst = null;
  colors.forEach((color, i) => {
    const expected = gt7ToneMapping(color, curve);
    for(let c = 0; c < 3; ++c) {
      const error = Math.abs(output[i * 4 + c] - expected[c]);
      if(!(error <= maxError)) { maxError = error; worst = { input: color, gpu: [...output.slice(i * 4, i * 4 + 3)], cpu: expected }; }
    }
  });
  // An 8-bit step is 1/255 ≈ 0.0039
  return { samples: width, maxError, maxErrorIn8BitSteps: maxError * 255, pass: maxError < 0.5 / 255, worst };
}
