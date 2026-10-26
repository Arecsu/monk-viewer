import * as GPU from 'three/webgpu';
import * as T from 'three/tsl';
import { createTarget } from './Common.js';

/**
 * Native WebGPU tonemapped resolve and transparent glass.
 *
 * Port of `src/postprocessing/TonemappedResolvePass.ts` plus the depth export the native pipeline needs:
 *
 * 1. Export depth. WebGPU has no implicit hardware depth resolve, so depth sample {@link DEPTH_SAMPLE_INDEX} of the
 *    geometry pass' retained multisampled depth is written into the real single-sample `depth32float` attachment of
 *    {@link WebGpuTransparency#glassTarget}. That attachment depth tests the glass and is the only depth later stages
 *    (TAA) read, so nothing downstream depends on an undefined resolve.
 * 2. Decode. The encoded HDR colour of the geometry pass is decoded back to linear HDR with the exact inverse of the
 *    edge resolve encoding, so bloom and tone mapping see the usual values.
 * 3. Glass. Transparent objects (layer 1, see the geometry contract) are drawn on top of the decoded colour with their
 *    original double-side/blend/depth state, depth tested against the exported opaque depth. Blending does not commute
 *    with the encoding, which is why they are not part of the geometry pass.
 * 4. Reactive mask. 1 where a transparent surface faces the camera, 0 edge on and elsewhere, depth tested against the
 *    same depth: the thin glass edges alias like any other edge and keep their temporal antialiasing.
 *
 * Ownership: this component owns {@link WebGpuTransparency#glassTarget} and
 * {@link WebGpuTransparency#reactiveMaskTarget}; the glass target owns the exported depth texture, the mask target
 * borrows it. The geometry colour and the retained multisampled depth are borrowed and are never resized or disposed
 * here.
 *
 * All colour writes stay linear HDR: the targets are `rg11b10ufloat` / `r8unorm`, never the display canvas.
 */

/**
 * The largest encoded value that is decoded. Keeps `1 - E` away from 0.
 *
 * Same value as `TonemappedResolvePass.MAX_ENCODED` in the WebGL reference.
 */

export const MAX_ENCODED = 0.9995;

/**
 * The decode curves, indexed exactly like the reference `encoding` uniform: 0 `linear`, 1 `rgb`, 2 `max`.
 *
 * @see TonemappedResolvePass.encoding
 */
export const ENCODINGS = ['linear', 'rgb', 'max'];

/**
 * The retained multisampled depth is read at this sample and nowhere else: WebGPU has no hardware depth resolve.
 */

export const DEPTH_SAMPLE_INDEX = 0;

/**
 * Decodes one encoded colour the way the decode shader does.
 *
 * Test oracle for {@link WebGpuTransparency}: the shader performs the same arithmetic. `encoded` is `[r, g, b]` as the
 * geometry pass resolved it, the result is linear HDR.
 *
 * @param {number[]} encoded - The encoded colour as written by the geometry pass.
 * @param {number} exposure - The exposure shared by the encoding and this decode.
 * @param {string} [encoding="rgb"] - One of {@link ENCODINGS}.
 * @return {number[]} The decoded linear HDR colour.
 */

export function decodeEncodedHdr(encoded, exposure, encoding = 'rgb') {

	const index = ENCODINGS.indexOf(encoding);

	if (index === - 1) throw new RangeError(`WebGpuTransparency: unknown encoding "${encoding}"`);

	if (index === 1) {

		const e = encoded.map((c) => Math.min(c, MAX_ENCODED));
		return e.map((c) => c / (exposure * (1.0 - c)));

	} else if (index === 2) {

		const clamped = Math.min(Math.max(encoded[0], Math.max(encoded[1], encoded[2])), MAX_ENCODED);
		return encoded.map((c) => c / (exposure * (1.0 - clamped)));

	}

	return encoded.map((c) => c / exposure);

}

/**
 * Reads depth sample {@link DEPTH_SAMPLE_INDEX} of a retained (multisampled) depth texture.
 *
 * For a multisampled depth texture the texture node's level node is the WGSL `textureLoad` sample index — in three the
 * depth attachment is bound as `texture_depth_multisampled_2d` — so this is an explicit sample-0 load, not a resolve.
 * A single-sample depth texture is read at mip level 0, which is the only sample it has.
 *
 * @param {GPU.DepthTexture} depthTexture - The geometry pass' retained depth.
 * @return {GPU.Node} The `float` depth value of sample {@link DEPTH_SAMPLE_INDEX}.
 */

export function loadRetainedDepthSample(depthTexture) {

	return T.textureLoad(depthTexture, T.ivec2(T.screenCoordinate.xy)).level(DEPTH_SAMPLE_INDEX);

}

/**
 * The facing term of the reactive mask: `abs(dot(normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition))),
 * normalize(vViewPosition)))`.
 *
 * Test oracle for the mask shader. The reference builds `vViewPosition = -mvPosition.xyz`, i.e. `-positionView`;
 * negating the derivative vectors and the view position leaves the cross product and the absolute dot product
 * unchanged, and WebGPU's `dFdy` runs along the storage rows where WebGL's ran the other way, which `abs` also
 * cancels. So the shader can use `positionView` directly and still produce the reference value.
 *
 * @param {number[]} viewDx - `dFdx(positionView)`.
 * @param {number[]} viewDy - `dFdy(positionView)`.
 * @param {number[]} viewPosition - The fragment's view position.
 * @return {number} The facing in [0, 1]: 1 facing the camera, 0 edge on.
 */

export function facingFromViewDifferentials(viewDx, viewDy, viewPosition) {

	const cross = [
		viewDx[1] * viewDy[2] - viewDx[2] * viewDy[1],
		viewDx[2] * viewDy[0] - viewDx[0] * viewDy[2],
		viewDx[0] * viewDy[1] - viewDx[1] * viewDy[0]
	];

	const faceNormal = normalize3(cross);
	const view = normalize3(viewPosition);

	return Math.abs(faceNormal[0] * view[0] + faceNormal[1] * view[1] + faceNormal[2] * view[2]);

}

/**
 * The reactive mask value for a facing: `smoothstep(0.1, 0.3, facing)`.
 *
 * Test oracle for the mask shader. Only surfaces seen close to face on (facing above 0.3) are marked reactive, so the
 * thin, bright, grazing glass edges are left to the regular TAA reconstruction instead of the reactive path.
 *
 * @param {number} facing - The facing from {@link facingFromViewDifferentials}.
 * @return {number} The reactive mask value in [0, 1].
 */

export function reactiveMaskValue(facing) {

	const t = Math.min(Math.max((facing - 0.1) / (0.3 - 0.1), 0), 1);
	return t * t * (3 - 2 * t);

}

function normalize3(x) {

	const length = Math.hypot(x[0], x[1], x[2]) || 1;
	return [x[0] / length, x[1] / length, x[2] / length];

}

/**
 * The mask shader, see {@link facingFromViewDifferentials} and {@link reactiveMaskValue}.
 *
 * @return {GPU.Node} A `vec4` mask value: x the facing mask, yzw 0 as in the reference.
 */

function facingMaskNode() {

	// Same expression as the reference for `vViewPosition = -mvPosition.xyz`; see facingFromViewDifferentials for why
	// `positionView` and the storage-space `dFdy` give the identical value.
	const faceNormal = T.cross(T.positionView.dFdx(), T.positionView.dFdy()).normalize();
	const facing = T.abs(T.dot(faceNormal, T.positionView.normalize()));

	return T.vec4(T.smoothstep(0.1, 0.3, facing), 0.0, 0.0, 1.0);

}

/**
 * The decode shader, see {@link decodeEncodedHdr}.
 *
 * @param {GPU.Texture} colorTexture - The encoded HDR colour of the geometry pass.
 * @param {GPU.UniformNode} exposureNode - The shared exposure.
 * @param {GPU.UniformNode} encodingNode - The index of the encoding in {@link ENCODINGS}.
 * @return {GPU.Node} The decoded linear HDR colour.
 */

function createDecodeNode(colorTexture, exposureNode, encodingNode) {

	// Storage pixel for pixel: the resolve is a 1:1 full screen pass, so no UV flip or filtering can move a sample.
	const encoded = T.textureLoad(colorTexture, T.ivec2(T.screenCoordinate.xy)).level(0).rgb;

	// Same three curves and the same branch order as the reference `encoding` uniform, built eagerly from `select` so
	// the whole graph is constructed here rather than lazily inside an `Fn`.
	const linear = encoded.div(exposureNode);

	const clampedRgb = T.min(encoded, T.vec3(MAX_ENCODED));
	const rgb = clampedRgb.div(exposureNode.mul(T.float(1.0).sub(clampedRgb)));

	const clampedMax = T.min(T.max(encoded.r, T.max(encoded.g, encoded.b)), T.float(MAX_ENCODED));
	const max = encoded.div(exposureNode.mul(T.float(1.0).sub(clampedMax)));

	const isRgb = encodingNode.equal(T.int(1));
	const isMax = encodingNode.equal(T.int(2));

	return T.vec4(isRgb.select(rgb, isMax.select(max, linear)), 1.0);

}

/**
 * Decodes the tonemapped MSAA resolve back to linear HDR, exports the retained depth sample and renders transparent
 * objects on top of the decoded colour.
 */

export class WebGpuTransparency {

	/**
	 * @param {GPU.WebGPURenderer} renderer - The native renderer.
	 * @param {Object} options - The options.
	 * @param {GPU.Scene} options.scene - The scene holding the converted materials.
	 * @param {GPU.Camera} options.camera - The camera the geometry pass rendered with.
	 * @param {number} [options.exposure=1.6] - The exposure shared by the encoding in the materials and this decode.
	 * @param {string} [options.encoding="rgb"] - The curve the MSAA samples were averaged through.
	 * @param {boolean} [options.reactiveMask=true] - Whether the reactive facing mask is rendered.
	 * @param {number} [options.layer=1] - The layer that holds transparent objects.
	 */

	constructor( renderer, { scene, camera, exposure = 1.6, encoding = 'rgb', reactiveMask = true, layer = 1 } = {} ) {

		if ( renderer === null || renderer === undefined ) throw new TypeError( 'WebGpuTransparency: a native renderer is required' );
		if ( scene === null || scene === undefined ) throw new TypeError( 'WebGpuTransparency: a scene is required' );
		if ( camera === null || camera === undefined ) throw new TypeError( 'WebGpuTransparency: a camera is required' );
		if ( ENCODINGS.includes( encoding ) === false ) throw new RangeError( `WebGpuTransparency: unknown encoding "${ encoding }"` );
		if ( Number.isInteger( layer ) === false || layer < 0 || layer > 31 ) throw new RangeError( `WebGpuTransparency: invalid layer ${ layer }` );

		this.renderer = renderer;
		this.scene = scene;
		this.camera = camera;
		this.layer = layer;

		/**
		 * Same meaning as the reference pass' `reactiveMaskEnabled`: the mask costs one more draw of the glass.
		 *
		 * @type {boolean}
		 */

		this.reactiveMaskEnabled = reactiveMask;

		/**
		 * Whether {@link WebGpuTransparency#render} runs. A disabled resolve passes the encoded colour and the retained
		 * multisampled depth through unchanged, exactly like disabling the reference pass: no decoded colour and no
		 * single-sample depth exist for later stages.
		 *
		 * @type {boolean}
		 */

		this.enabled = true;

		this.exposureNode = T.uniform( exposure );
		this.encodingNode = T.uniform( ENCODINGS.indexOf( encoding ), 'int' );

		// Writes depth only: the decoded colour attachment must survive (`colorWrite: false`) and the quad covers the
		// whole attachment, so `depthTest: false` is correct.
		this.exportMaterial = new GPU.MeshBasicNodeMaterial( {
			name: 'TransparencyDepthExportMaterial',
			depthTest: false,
			depthWrite: true,
			colorWrite: false,
			fog: false
		} );
		this.exportMaterial.fragmentNode = T.vec4( 0.0 );

		this.decodeMaterial = new GPU.MeshBasicNodeMaterial( {
			name: 'TransparencyDecodeMaterial',
			depthTest: false,
			depthWrite: false,
			fog: false
		} );

		// Reference ReactiveMaskMaterial: double sided, no depth write. Three's scene override marks it transparent
		// because the glass is, so `forceSinglePass` keeps one draw per object like the reference instead of splitting
		// the two faces into two passes. The mask writes alpha 1, so the resulting blending is an exact write.
		this.reactiveMaskMaterial = new GPU.MeshBasicNodeMaterial( {
			name: 'TransparencyReactiveMaskMaterial',
			side: GPU.DoubleSide,
			depthTest: true,
			depthWrite: false,
			fog: false
		} );
		this.reactiveMaskMaterial.forceSinglePass = true;
		// WebGPU does not allow blending into a single-channel r8unorm attachment, and three's scene-override path
		// forces `transparent` on the override material. The mask shader writes alpha 1 for every fragment, so the
		// reference normal blend was already an exact write: NoBlending keeps the pipeline valid and the values equal.
		this.reactiveMaskMaterial.blending = GPU.NoBlending;
		this.reactiveMaskMaterial.fragmentNode = facingMaskNode();

		this.exportQuad = new GPU.QuadMesh( this.exportMaterial );
		this.decodeQuad = new GPU.QuadMesh( this.decodeMaterial );

		this.glassTarget = null;
		this.reactiveMaskTarget = null;
		this.depthTexture = null;
		this.sourceColor = null;
		this.sourceDepth = null;
		this.width = 0;
		this.height = 0;
		this.disposed = false;

		this.setSize( 1, 1 );

	}

	/**
	 * The HDR colour with the glass composited on top. Equivalent to `glassTarget.texture`.
	 *
	 * @type {GPU.Texture}
	 */

	get color() {

		return this.glassTarget.texture;

	}

	/**
	 * The single-sample `depth32float` depth attachment: depth sample 0 of the retained multisampled depth, depth
	 * tested by the glass and read by later stages.
	 *
	 * @type {GPU.DepthTexture}
	 */

	get depth() {

		return this.depthTexture;

	}

	/**
	 * Where the transparent objects cover the image: 1 facing the camera, 0 edge on and elsewhere. Only rendered while
	 * {@link WebGpuTransparency#reactiveMaskEnabled}; without the mask this returns the mask target's (stale) texture,
	 * so consumers must use `render()`'s result.
	 *
	 * @type {GPU.Texture}
	 */

	get reactiveMask() {

		return this.reactiveMaskTarget.texture;

	}

	/**
	 * The exposure shared by the encoding in the scene materials and the decoding in this component.
	 *
	 * @type {number}
	 */

	get exposure() {

		return this.exposureNode.value;

	}

	set exposure( value ) {

		this.exposureNode.value = value;

	}

	/**
	 * The curve the MSAA samples were averaged through: `rgb` per channel, `max` on the largest channel, `linear` for
	 * plain MSAA. The background clear colour must be encoded with the same curve.
	 *
	 * @type {string}
	 */

	get encoding() {

		return ENCODINGS[ this.encodingNode.value ];

	}

	set encoding( value ) {

		const index = ENCODINGS.indexOf( value );

		if ( index === - 1 ) throw new RangeError( `WebGpuTransparency: unknown encoding "${ value }"` );

		this.encodingNode.value = index;

	}

	/**
	 * Sets the physical size of the owned targets. Reallocates only when the size changes.
	 *
	 * @param {number} width - Physical width in pixels.
	 * @param {number} height - Physical height in pixels.
	 */

	setSize( width, height ) {

		this.#assertUsable( 'setSize' );

		if ( Number.isInteger( width ) === false || Number.isInteger( height ) === false || width <= 0 || height <= 0 ) {

			throw new RangeError( `WebGpuTransparency: sizes must be positive integers, got ${ width }x${ height }` );

		}

		if ( this.width === width && this.height === height ) return;

		this.width = width;
		this.height = height;

		if ( this.glassTarget === null ) {

			// Decoded HDR plus glass compositing: same format as the geometry pass colour, never the display canvas.
			this.glassTarget = createTarget( width, height, { format: 'rgba16float', depth: true } );

			// The exported depth is the glass target's real depth attachment; the mask target borrows the same texture,
			// so the mask is depth tested against the very opaque depth the glass tests against. Neither target is
			// given the geometry depth, which this component must not resize or dispose.
			this.depthTexture = new GPU.DepthTexture( width, height, GPU.FloatType );
			this.depthTexture.name = 'transparency-depth32float';
			this.glassTarget.depthTexture = this.depthTexture;

			this.reactiveMaskTarget = createTarget( width, height, { format: 'r8unorm', depth: true } );
			this.reactiveMaskTarget.depthTexture = this.depthTexture;

		} else {

			// The retained depth texture object survives a resize so consumers can keep referencing it; three resizes an
			// owned depth attachment on the next render target update. The borrower goes first, then the owner.
			this.reactiveMaskTarget.setSize( width, height );
			this.glassTarget.setSize( width, height );

		}

	}

	/**
	 * Renders the resolve, the glass and the reactive mask.
	 *
	 * @param {Object} geometry - The geometry pass result.
	 * @param {GPU.Texture} geometry.color - The resolved encoded HDR colour.
	 * @param {GPU.DepthTexture} geometry.depth - The retained multisampled depth.
	 * @param {GPU.RenderTarget} [geometry.target] - The geometry pass target (borrowed, unused: kept for the contract).
	 * @return {{color: GPU.Texture, depth: GPU.DepthTexture, reactiveMask: ?GPU.Texture, target: GPU.RenderTarget}}
	 */

	render( { color, depth, target = null } = {} ) {

		this.#assertUsable( 'render' );

		if ( color === undefined || color === null || depth === undefined || depth === null ) {

			throw new TypeError( 'WebGpuTransparency: render() requires the geometry {color, depth}' );

		}

		if ( color.image.width !== this.width || color.image.height !== this.height ) {

			this.setSize( color.image.width, color.image.height );

		}

		if ( depth.image.width !== color.image.width || depth.image.height !== color.image.height ) {

			throw new RangeError( 'WebGpuTransparency: the retained depth and the resolved colour must have the same size' );

		}

		if ( this.enabled === false ) {

			return { color, depth, reactiveMask: null, target };

		}

		const renderer = this.renderer;
		const scene = this.scene;
		const camera = this.camera;

		const previousRenderTarget = renderer.getRenderTarget();
		const previousMRT = renderer.getMRT();
		const previousAutoClear = renderer.autoClear;
		const previousClearColor = renderer.getClearColor( new GPU.Color() );
		const previousClearAlpha = renderer.getClearAlpha();
		const previousBackground = scene.background;
		const previousOverrideMaterial = scene.overrideMaterial;
		const previousLayerMask = camera.layers.mask;

		try {

			// No pass in this sequence may clear: the decoded colour has to survive the glass pass and the exported depth
			// has to survive every pass after the export. A scene background colour would make three force a colour and
			// depth clear on the scene render, so it is dropped for the whole sequence.
			renderer.autoClear = false;
			renderer.setMRT( null );
			scene.background = null;

			this.syncSources( color, depth );

			this.exportDepth( renderer );
			this.decode( renderer );
			this.drawGlass( renderer );

			if ( this.reactiveMaskEnabled ) this.drawReactiveMask( renderer );

			return {
				color: this.glassTarget.texture,
				depth: this.depthTexture,
				reactiveMask: this.reactiveMaskEnabled ? this.reactiveMaskTarget.texture : null,
				target: this.glassTarget
			};

		} finally {

			camera.layers.mask = previousLayerMask;
			scene.background = previousBackground;
			scene.overrideMaterial = previousOverrideMaterial;
			renderer.setClearColor( previousClearColor, previousClearAlpha );
			renderer.setMRT( previousMRT );
			renderer.autoClear = previousAutoClear;
			renderer.setRenderTarget( previousRenderTarget );

		}

	}

	/**
	 * Releases the owned targets, the exported depth and the materials. Idempotent. Borrowed textures are untouched.
	 */

	dispose() {

		if ( this.disposed ) return;

		this.disposed = true;

		// The mask target borrows the depth texture, so it goes before its owner.
		this.reactiveMaskTarget.dispose();
		this.glassTarget.dispose();
		this.exportMaterial.dispose();
		this.decodeMaterial.dispose();
		this.reactiveMaskMaterial.dispose();

		this.glassTarget = null;
		this.reactiveMaskTarget = null;
		this.depthTexture = null;
		this.sourceColor = null;
		this.sourceDepth = null;
		this.width = 0;
		this.height = 0;

	}

	/**
	 * Rebinds the decode and depth export shaders when the geometry pass' textures change (a resize replaces them).
	 *
	 * @param {GPU.Texture} color - The resolved encoded HDR colour.
	 * @param {GPU.DepthTexture} depth - The retained multisampled depth.
	 */

	syncSources( color, depth ) {

		if ( this.sourceColor === color && this.sourceDepth === depth ) return;

		this.sourceColor = color;
		this.sourceDepth = depth;

		this.exportMaterial.depthNode = loadRetainedDepthSample( depth );
		this.exportMaterial.needsUpdate = true;

		this.decodeMaterial.fragmentNode = createDecodeNode( color, this.exposureNode, this.encodingNode );
		this.decodeMaterial.needsUpdate = true;

	}

	/**
	 * Writes depth sample {@link DEPTH_SAMPLE_INDEX} into the single-sample depth attachment.
	 *
	 * @param {GPU.WebGPURenderer} renderer - The native renderer.
	 */

	exportDepth( renderer ) {

		renderer.setRenderTarget( this.glassTarget );
		this.exportQuad.render( renderer );

	}

	/**
	 * Decodes the encoded colour into the HDR colour attachment.
	 *
	 * @param {GPU.WebGPURenderer} renderer - The native renderer.
	 */

	decode( renderer ) {

		renderer.setRenderTarget( this.glassTarget );
		this.decodeQuad.render( renderer );

	}

	/**
	 * Draws the transparent objects on top of the decoded colour with their own materials, depth tested against the
	 * exported depth. The layer mask is set so the opaque layer (already in the decoded colour) is not drawn again.
	 *
	 * @param {GPU.WebGPURenderer} renderer - The native renderer.
	 */

	drawGlass( renderer ) {

		const scene = this.scene;
		const camera = this.camera;

		camera.layers.set( this.layer );

		renderer.setRenderTarget( this.glassTarget );
		renderer.render( scene, camera );

	}

	/**
	 * Renders the reactive facing mask of the transparent objects, depth tested against the shared depth.
	 *
	 * The colour-only clear also tells three the mask target's depth attachment is initialised; without it three would
	 * clear the shared depth on the mask target's first render and destroy the exported depth.
	 *
	 * @param {GPU.WebGPURenderer} renderer - The native renderer.
	 */

	drawReactiveMask( renderer ) {

		const scene = this.scene;
		const camera = this.camera;

		renderer.setClearColor( 0x000000, 0.0 );
		renderer.setRenderTarget( this.reactiveMaskTarget );
		renderer.clear( true, false, false );

		scene.overrideMaterial = this.reactiveMaskMaterial;
		renderer.render( scene, camera );
		scene.overrideMaterial = null;

	}

	#assertUsable( operation ) {

		if ( this.disposed ) throw new Error( `WebGpuTransparency: ${ operation }() after dispose()` );

	}

}
