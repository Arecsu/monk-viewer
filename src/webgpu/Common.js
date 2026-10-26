import * as GPU from 'three/webgpu';
import * as T from 'three/tsl';

// Algorithmic UVs/pixels match the WebGL reference; storage alone is top-left.
export const logicalUV = T.vec2(T.screenUV.x, T.float(1).sub(T.screenUV.y));
export const logicalPixel = (height) => T.ivec2(T.screenCoordinate.x, T.int(height).sub(1).sub(T.int(T.screenCoordinate.y)));
export const sampleLogical = (source, uv = logicalUV) => T.texture(source, T.vec2(uv.x, T.float(1).sub(uv.y)));
export const loadLogical = (source, pixel, height) => T.textureLoad(source, T.ivec2(pixel.x, T.int(height).sub(1).sub(pixel.y)));

export function webglProjection(camera, projection = camera.projectionMatrix) {
  const result = projection.clone();
  if (camera.coordinateSystem === GPU.WebGPUCoordinateSystem) {
    const a = result.elements;
    for (let col = 0; col < 4; ++col) a[col * 4 + 2] = 2 * a[col * 4 + 2] - a[col * 4 + 3];
  }
  return result;
}

export function createTarget(width = 1, height = 1, { format = 'rg11b10ufloat', depth = false, count = 1, samples = 0, nearest = false } = {}) {
  const target = new GPU.RenderTarget(width, height, { depthBuffer: depth, stencilBuffer: false, samples, count });
  for (const texture of target.textures) {
    texture.type = format === 'r8unorm' ? GPU.UnsignedByteType : format === 'r32float' ? GPU.FloatType : GPU.HalfFloatType;
    texture.format = format === 'rg11b10ufloat' ? GPU.RGBFormat : format === 'r8unorm' || format === 'r32float' ? GPU.RedFormat : GPU.RGBAFormat;
    texture.internalFormat = format;
    texture.colorSpace = GPU.NoColorSpace;
    texture.minFilter = texture.magFilter = nearest ? GPU.NearestFilter : GPU.LinearFilter;
    texture.generateMipmaps = false;
  }
  if (depth) target.depthTexture = new GPU.DepthTexture(width, height, GPU.FloatType);
  return target;
}

export class FullscreenPass {
  constructor(renderer, fragmentNode, { target = null, name = 'NativeFullscreen' } = {}) {
    this.renderer = renderer;
    this.target = target;
    this.material = new GPU.MeshBasicNodeMaterial({ name, depthTest: false, depthWrite: false, toneMapped: false });
    this.material.fragmentNode = fragmentNode;
    this.quad = new GPU.QuadMesh(this.material);
    this.disposed = false;
  }
  render(target = this.target) {
    this.renderer.setMRT(null);
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
    return target?.texture ?? null;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.material.dispose();
  }
}
