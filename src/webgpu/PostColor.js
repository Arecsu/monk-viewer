import * as GPU from 'three/webgpu';
import * as T from 'three/tsl';
import { FullscreenPass, createTarget } from './Common.js';
import {
	BLOOM_DOWNSAMPLE_PADDING,
	DitheringType,
	GT7_VIEWER_GRADE,
	bloomDownsampleSizes,
	bloomLevelPlan,
	bloomUpsampleSizes,
	createDownsampleNode,
	createLuminanceNode,
	createToneMappingNode,
	createUpsampleNode,
	gt7Constants,
	normalizeGT7Parameters
} from './PostColorShaders.js';
import { SMAAPreset, WebGpuSMAA } from './SMAA.js';

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function textureOf(color) {

	if(color?.isTexture === true) return color;
	if(color?.texture?.isTexture === true) return color.texture;
	throw new TypeError('WebGpuPostColor.render expects a Texture or a render target with a texture');

}

function imageSize(texture) {

	const image = texture.image;
	if(image && image.width > 0 && image.height > 0) return { width: image.width, height: image.height };
	return null;

}

function vector4Of(value) {

	if(value === null || value === undefined) return null;
	if(Array.isArray(value) && value.length >= 4) return value;
	if(finite(value.x) && finite(value.y) && finite(value.z) && finite(value.w)) {
		return [value.x, value.y, value.z, value.w];
	}
	return null;

}

class BloomControls {

	constructor({
		enabled = true,
		luminanceThreshold = 0.1,
		luminanceSmoothing = 0.4,
		intensity = 0.3,
		radius = 1,
		levels = 8,
		referenceHeight = 1800,
		luminanceEnabled = true,
		clampToBorder = true,
		fullResolutionUpsampling = false
	} = {}) {

		this.enabled = enabled;
		this.luminanceThreshold = luminanceThreshold;
		this.luminanceSmoothing = luminanceSmoothing;
		this.intensity = intensity;
		this.radius = radius;
		// The reference level count; the effective count follows the output height (see bloomLevelPlan).
		this.levels = levels;
		this.referenceHeight = referenceHeight;
		this.luminanceEnabled = luminanceEnabled;
		this.clampToBorder = clampToBorder;
		this.fullResolutionUpsampling = fullResolutionUpsampling;
		// aa-lab's "bloom bounds" toggle. false forces full-screen bloom, like BoundedBloomEffect.backgroundFastPath.
		this.backgroundFastPath = true;
		this.activeLevels = levels;
		this.scale = 1;
		this.luminanceWidth = 1;
		this.luminanceHeight = 1;

	}

}

class GT7Controls {

	constructor(options = {}) {

		this._enabled = options.enabled ?? true;
		this.enabledUniform = T.uniform(this._enabled ? 1 : 0);
		this.exposureUniform = T.uniform(options.exposure ?? GT7_VIEWER_GRADE.exposure);
		this.gradeUniform = T.uniform(new GPU.Vector4(
			options.contrast ?? GT7_VIEWER_GRADE.contrast,
			options.saturation ?? GT7_VIEWER_GRADE.saturation,
			options.vibrance ?? GT7_VIEWER_GRADE.vibrance,
			options.blackPoint ?? GT7_VIEWER_GRADE.blackPoint
		));
		this.curveUniform = T.uniform(new GPU.Vector4());
		this.shoulderUniform = T.uniform(new GPU.Vector4());
		this.blendRatioUniform = T.uniform(0);
		this._parameters = normalizeGT7Parameters({
			alpha: options.highlightHardness ?? GT7_VIEWER_GRADE.highlightHardness,
			midPoint: options.toeLength ?? GT7_VIEWER_GRADE.toeLength,
			linearSection: options.shoulderStart ?? GT7_VIEWER_GRADE.shoulderStart,
			toeStrength: options.shadowToe ?? GT7_VIEWER_GRADE.shadowToe,
			blendRatio: options.chromaPreservation ?? GT7_VIEWER_GRADE.chromaPreservation
		});
		this._updateCurve();

	}

	get enabled() { return this._enabled; }
	set enabled(value) {

		this._enabled = Boolean(value);
		this.enabledUniform.value = this._enabled ? 1 : 0;

	}

	get exposure() { return this.exposureUniform.value; }
	set exposure(value) { this.exposureUniform.value = value; }

	get contrast() { return this.gradeUniform.value.x; }
	set contrast(value) { this.gradeUniform.value.x = value; }

	get saturation() { return this.gradeUniform.value.y; }
	set saturation(value) { this.gradeUniform.value.y = value; }

	get vibrance() { return this.gradeUniform.value.z; }
	set vibrance(value) { this.gradeUniform.value.z = value; }

	get blackPoint() { return this.gradeUniform.value.w; }
	set blackPoint(value) { this.gradeUniform.value.w = value; }

	get highlightHardness() { return this._parameters.alpha; }
	set highlightHardness(value) { this._parameters.alpha = value; this._updateCurve(); }

	get shoulderStart() { return this._parameters.linearSection; }
	set shoulderStart(value) { this._parameters.linearSection = value; this._updateCurve(); }

	get shadowToe() { return this._parameters.toeStrength; }
	set shadowToe(value) { this._parameters.toeStrength = value; this._updateCurve(); }

	get toeLength() { return this._parameters.midPoint; }
	set toeLength(value) { this._parameters.midPoint = value; this._updateCurve(); }

	get chromaPreservation() { return this._parameters.blendRatio; }
	set chromaPreservation(value) { this._parameters.blendRatio = value; this._updateCurve(); }

	get curve() { return { ...this._parameters }; }

	_updateCurve() {

		this._parameters = normalizeGT7Parameters(this._parameters);
		const { peak, kA, kB, kC, targetUcs } = gt7Constants(this._parameters);
		this.curveUniform.value.set(
			peak, this._parameters.midPoint, this._parameters.linearSection, this._parameters.toeStrength
		);
		this.shoulderUniform.value.set(kA, kB, kC, targetUcs);
		this.blendRatioUniform.value = this._parameters.blendRatio;

	}

}

class ReinhardControls {

	constructor(options = {}) {

		this._enabled = options.enabled ?? false;
		this.enabledUniform = T.uniform(this._enabled ? 1 : 0);
		this.exposureUniform = T.uniform(options.exposure ?? 1.6);
		// postprocessing ToneMapping.REINHARD
		this.toneMapping = 1;

	}

	get enabled() { return this._enabled; }
	set enabled(value) {

		this._enabled = Boolean(value);
		this.enabledUniform.value = this._enabled ? 1 : 0;

	}

	get exposure() { return this.exposureUniform.value; }
	set exposure(value) { this.exposureUniform.value = value; }

}

class DitheringControls {

	constructor(options = {}) {

		this._enabled = options.enabled ?? true;
		this.enabledUniform = T.uniform(this._enabled ? 1 : 0);
		this.intensityUniform = T.uniform(options.intensity ?? 1);
		this.typeUniform = T.uniform(options.ditheringType ?? DitheringType.LUMABASED);

	}

	get enabled() { return this._enabled; }
	set enabled(value) {

		this._enabled = Boolean(value);
		this.enabledUniform.value = this._enabled ? 1 : 0;

	}

	get intensity() { return this.intensityUniform.value; }
	set intensity(value) { this.intensityUniform.value = value; }

	get ditheringType() { return this.typeUniform.value; }
	set ditheringType(value) { this.typeUniform.value = value; }

}

const optionObject = (value, defaults) => {

	if(value === false) return { ...defaults, enabled: false };
	if(value === true || value === null || value === undefined) return { ...defaults };
	return { ...defaults, ...value };

};

/**
 * Native WebGPU post-color chain: bounded/resolution-independent bloom, GT7 tone mapping with the viewer grade,
 * optional Reinhard comparison, exact dithering, optional SMAA.
 *
 * `render()` returns display-linear color (not sRGB-encoded). The supervisor presents it with the renderer's single
 * sRGB output transform. When SMAA is active the internal intermediate is quantized like the reference's sRGB8 target,
 * then returned to display-linear before the blend; the final output is still display-linear.
 */
export class WebGpuPostColor {

	constructor(renderer, options = {}) {

		if(renderer === null || renderer === undefined) throw new TypeError('WebGpuPostColor requires a renderer');
		this.renderer = renderer;
		this.disposed = false;
		this.width = 1;
		this.height = 1;

		this.bloom = new BloomControls(optionObject(options.bloom, {
			enabled: true,
			luminanceThreshold: 0.1,
			luminanceSmoothing: 0.4,
			intensity: 0.3,
			radius: 1,
			levels: 8,
			referenceHeight: 1800,
			luminanceEnabled: true,
			clampToBorder: true,
			fullResolutionUpsampling: false
		}));
		this.gt7ToneMapping = new GT7Controls(optionObject(options.gt7ToneMapping, {
			enabled: true,
			...GT7_VIEWER_GRADE
		}));
		this.reinhardToneMapping = new ReinhardControls(optionObject(options.reinhardToneMapping, {
			enabled: false,
			exposure: 1.6
		}));
		this.dithering = new DitheringControls(optionObject(options.dithering, {
			enabled: true,
			intensity: 1,
			ditheringType: DitheringType.LUMABASED
		}));

		this.uResolution = T.uniform(new GPU.Vector2(1, 1));
		this.uBloomBounds = T.uniform(new GPU.Vector4(0, 0, 1, 1));
		this.uBloomThreshold = T.uniform(this.bloom.luminanceThreshold);
		this.uBloomSmoothing = T.uniform(this.bloom.luminanceSmoothing);
		this.uBloomIntensity = T.uniform(this.bloom.intensity);
		this.uBloomRadius = T.uniform(this.bloom.radius);
		this.uBloomClamp = T.uniform(this.bloom.clampToBorder ? 1 : 0);
		this.uQuantize = T.uniform(0);

		this.outputTarget = createTarget(1, 1, { format: 'rgba16float' });
		this.displayTarget = createTarget(1, 1, { format: 'rgba16float' });
		this.luminanceTarget = createTarget(1, 1, { format: 'rg11b10ufloat' });

		this._downTargets = [];
		this._upTargets = [];
		this._downPasses = [];
		this._upPasses = [];
		this._upCount = 0;

		this._luminanceSource = T.texture(this.outputTarget.texture, T.vec2(0, 0));
		this._luminanceTexel = T.uniform(new GPU.Vector2(1, 1));
		this._luminancePadding = T.vec2(BLOOM_DOWNSAMPLE_PADDING, BLOOM_DOWNSAMPLE_PADDING)
			.mul(this._luminanceTexel);
		this._luminancePass = new FullscreenPass(renderer, createLuminanceNode({
			source: this._luminanceSource,
			threshold: this.uBloomThreshold,
			smoothing: this.uBloomSmoothing,
			bounds: this.uBloomBounds,
			padding: this._luminancePadding
		}), { target: this.luminanceTarget, name: 'BloomLuminance' });

		this._toneSource = T.texture(this.outputTarget.texture, T.vec2(0, 0));
		this._toneBloom = T.texture(this.outputTarget.texture, T.vec2(0, 0));
		this._tonePass = new FullscreenPass(renderer, createToneMappingNode({
			source: this._toneSource,
			bloom: this._toneBloom,
			bloomIntensity: this.uBloomIntensity,
			resolution: this.uResolution,
			gt7Enabled: this.gt7ToneMapping.enabledUniform,
			gt7Exposure: this.gt7ToneMapping.exposureUniform,
			gt7Grade: this.gt7ToneMapping.gradeUniform,
			gt7Curve: this.gt7ToneMapping.curveUniform,
			gt7Shoulder: this.gt7ToneMapping.shoulderUniform,
			gt7BlendRatio: this.gt7ToneMapping.blendRatioUniform,
			reinhardEnabled: this.reinhardToneMapping.enabledUniform,
			reinhardExposure: this.reinhardToneMapping.exposureUniform,
			ditheringEnabled: this.dithering.enabledUniform,
			ditheringIntensity: this.dithering.intensityUniform,
			ditheringType: this.dithering.typeUniform,
			quantize: this.uQuantize
		}), { target: this.outputTarget, name: 'PostColorToneMapping' });

		const smaaOption = options.smaa ?? false;
		if(smaaOption === false || smaaOption === null) {
			this.smaaPass = null;
		} else {
			const smaaOptions = smaaOption === true ? {} : smaaOption;
			this.smaaPass = new WebGpuSMAA(renderer, {
				width: options.width ?? 1,
				height: options.height ?? 1,
				preset: smaaOptions.preset ?? options.smaaPreset ?? SMAAPreset.HIGH,
				lookup: smaaOptions.lookup ?? options.smaaLookup ?? null,
				searchURL: smaaOptions.searchURL ?? options.smaaSearchURL ?? undefined,
				areaURL: smaaOptions.areaURL ?? options.smaaAreaURL ?? undefined,
				enabled: smaaOptions.enabled ?? true,
				predicationMode: smaaOptions.predicationMode,
				predicationThreshold: smaaOptions.predicationThreshold,
				predicationScale: smaaOptions.predicationScale,
				predicationStrength: smaaOptions.predicationStrength
			});
		}

		this.ready = this.smaaPass === null ? Promise.resolve(true) : this.smaaPass.readyPromise;
		this.setSize(options.width ?? 1, options.height ?? 1);

	}

	_syncControls() {

		this.uBloomThreshold.value = this.bloom.luminanceThreshold;
		this.uBloomSmoothing.value = this.bloom.luminanceSmoothing;
		this.uBloomIntensity.value = this.bloom.enabled ? this.bloom.intensity : 0;
		this.uBloomRadius.value = this.bloom.radius;
		this.uBloomClamp.value = this.bloom.clampToBorder ? 1 : 0;

	}

	_resizeTargets(targets, sizes) {

		while(targets.length < sizes.length) targets.push(createTarget(1, 1, { format: 'rg11b10ufloat' }));
		while(targets.length > sizes.length) targets.pop().dispose();
		for(let i = 0; i < sizes.length; ++i) targets[i].setSize(sizes[i][0], sizes[i][1]);

	}

	_buildBloomPasses(levels, upCount) {

		for(const entry of this._downPasses) entry.pass.dispose();
		for(const entry of this._upPasses) entry.pass.dispose();
		this._downPasses = [];
		this._upPasses = [];

		for(let i = 0; i < levels; ++i) {
			const source = T.texture(this.outputTarget.texture, T.vec2(0, 0));
			const sourceTexel = T.uniform(new GPU.Vector2(1, 1));
			const padding = T.vec2(BLOOM_DOWNSAMPLE_PADDING, BLOOM_DOWNSAMPLE_PADDING).mul(sourceTexel);
			const fragment = createDownsampleNode({
				source,
				sourceTexel,
				bounds: this.uBloomBounds,
				padding,
				clampToBorder: this.uBloomClamp
			});
			this._downPasses.push({
				source,
				sourceTexel,
				pass: new FullscreenPass(this.renderer, fragment, {
					target: this._downTargets[i], name: `BloomDownsample${i}`
				})
			});
		}

		for(let i = 0; i < upCount; ++i) {
			const source = T.texture(this.outputTarget.texture, T.vec2(0, 0));
			const support = T.texture(this.outputTarget.texture, T.vec2(0, 0));
			const sourceTexel = T.uniform(new GPU.Vector2(1, 1));
			const fragment = createUpsampleNode({
				source, support, radius: this.uBloomRadius, sourceTexel
			});
			this._upPasses.push({
				source,
				support,
				sourceTexel,
				pass: new FullscreenPass(this.renderer, fragment, {
					target: this._upTargets[i], name: `BloomUpsample${i}`
				})
			});
		}

		this._upCount = upCount;

	}

	setSize(width, height) {

		if(this.disposed) return;
		const w = Math.max(1, Math.floor(width));
		const h = Math.max(1, Math.floor(height));
		const plan = bloomLevelPlan(h, {
			referenceHeight: this.bloom.referenceHeight,
			referenceLevels: this.bloom.levels,
			luminanceEnabled: this.bloom.luminanceEnabled
		});
		if(plan === null) return;

		const lumWidth = Math.max(1, Math.floor(w * plan.scale));
		const lumHeight = Math.max(1, Math.floor(h * plan.scale));
		const downSizes = bloomDownsampleSizes(lumWidth, lumHeight, plan.levels);
		const upSizes = bloomUpsampleSizes(w, h, plan.levels, this.bloom.fullResolutionUpsampling);

		this.width = w;
		this.height = h;
		this.uResolution.value.set(w, h);
		this.outputTarget.setSize(w, h);
		this.displayTarget.setSize(w, h);
		this.luminanceTarget.setSize(lumWidth, lumHeight);
		this._resizeTargets(this._downTargets, downSizes);
		this._resizeTargets(this._upTargets, upSizes);

		if(this._downPasses.length !== plan.levels || this._upPasses.length !== upSizes.length) {
			this._buildBloomPasses(plan.levels, upSizes.length);
		}

		this.bloom.activeLevels = plan.levels;
		this.bloom.scale = plan.scale;
		this.bloom.luminanceWidth = lumWidth;
		this.bloom.luminanceHeight = lumHeight;

		this.smaaPass?.setSize(w, h);

	}

	_updateBounds(bounds) {

		if(this.bloom.backgroundFastPath === false) {
			this.uBloomBounds.value.set(0, 0, 1, 1);
			return;
		}
		const b = vector4Of(bounds);
		if(b === null || !b.every(finite) || b[2] <= b[0] || b[3] <= b[1]) {
			this.uBloomBounds.value.set(0, 0, 1, 1);
			return;
		}
		// BoundedBloomEffect expands the certified footprint by one source pixel; the shaders add their own
		// conservative filter padding. Doing it here keeps the shader identical to the reference filter.
		const padX = 1 / this.width;
		const padY = 1 / this.height;
		this.uBloomBounds.value.set(b[0] - padX, b[1] - padY, b[2] + padX, b[3] + padY);

	}

	_syncPlan() {

		const plan = bloomLevelPlan(this.height, {
			referenceHeight: this.bloom.referenceHeight,
			referenceLevels: this.bloom.levels,
			luminanceEnabled: this.bloom.luminanceEnabled
		});
		if(plan === null) return;
		const upCount = bloomUpsampleSizes(this.width, this.height, plan.levels, this.bloom.fullResolutionUpsampling).length;
		if(plan.levels !== this.bloom.activeLevels || plan.scale !== this.bloom.scale ||
			Math.floor(this.width * plan.scale) !== this.bloom.luminanceWidth ||
			upCount !== this._upCount) {
			this.setSize(this.width, this.height);
		}

	}

	_renderBloom(source) {

		let previous = source;
		let previousWidth = this.width;
		let previousHeight = this.height;

		if(this.bloom.luminanceEnabled) {
			this._luminanceSource.value = source;
			this._luminanceTexel.value.set(1 / this.width, 1 / this.height);
			this._luminancePass.render(this.luminanceTarget);
			previous = this.luminanceTarget.texture;
			previousWidth = this.luminanceTarget.width;
			previousHeight = this.luminanceTarget.height;
		}

		const blurInput = previous;

		for(let i = 0; i < this._downPasses.length; ++i) {
			const entry = this._downPasses[i];
			entry.source.value = previous;
			entry.sourceTexel.value.set(1 / previousWidth, 1 / previousHeight);
			entry.pass.render(this._downTargets[i]);
			previous = this._downTargets[i].texture;
			previousWidth = this._downTargets[i].width;
			previousHeight = this._downTargets[i].height;
		}

		let bloomTexture;
		if(this._upCount === 0) {
			bloomTexture = this._downTargets[this._downTargets.length - 1].texture;
		} else {
			let upPrevious = this._downTargets[this._downTargets.length - 1].texture;
			let upWidth = this._downTargets[this._downTargets.length - 1].width;
			let upHeight = this._downTargets[this._downTargets.length - 1].height;
			for(let i = this._upCount - 1; i >= 0; --i) {
				const entry = this._upPasses[i];
				entry.source.value = upPrevious;
				entry.sourceTexel.value.set(1 / upWidth, 1 / upHeight);
				if(this.bloom.fullResolutionUpsampling) {
					entry.support.value = i === 0 ? blurInput : this._downTargets[i - 1].texture;
				} else {
					entry.support.value = this._downTargets[i].texture;
				}
				entry.pass.render(this._upTargets[i]);
				upPrevious = this._upTargets[i].texture;
				upWidth = this._upTargets[i].width;
				upHeight = this._upTargets[i].height;
			}
			bloomTexture = upPrevious;
		}

		return bloomTexture;

	}

	render({ color, bounds, depth, camera, present = false } = {}) {

		if(this.disposed) throw new Error('WebGpuPostColor is disposed');
		const source = textureOf(color);
		const size = imageSize(source);
		if(size !== null && (size.width !== this.width || size.height !== this.height)) {
			this.setSize(size.width, size.height);
		}
		this._syncPlan();
		this._syncControls();
		this._updateBounds(bounds);

		const smaaActive = this.smaaPass !== null && this.smaaPass.enabled && this.smaaPass.ready;
		if(smaaActive) this.smaaPass.validatePredication(depth, camera);

		let bloomTexture = source;
		if(this.bloom.enabled) bloomTexture = this._renderBloom(source);

		this.uQuantize.value = smaaActive ? 1 : 0;
		this._toneSource.value = source;
		this._toneBloom.value = bloomTexture;

		// Without SMAA the tone-mapping pass can write straight to the canvas: one less full-resolution pass and one
		// less full-resolution texture, and the renderer's output transform remains the single sRGB boundary.
		if(present && !smaaActive) {
			this._tonePass.render(null);
			return { color: null, target: null, presented: true };
		}

		const target = smaaActive ? this.displayTarget : this.outputTarget;
		this._tonePass.render(target);

		if(smaaActive) {
			this.smaaPass.render(this.displayTarget.texture, this.outputTarget, { depth, camera });
			if(present) return { color: this.outputTarget.texture, target: this.outputTarget, presentAfter: true };
		}
		return { color: this.outputTarget.texture, target: this.outputTarget };

	}

	dispose() {

		if(this.disposed) return;
		this.disposed = true;
		this._luminancePass.dispose();
		this._tonePass.dispose();
		for(const entry of this._downPasses) entry.pass.dispose();
		for(const entry of this._upPasses) entry.pass.dispose();
		this._downPasses = [];
		this._upPasses = [];
		this.outputTarget.dispose();
		this.displayTarget.dispose();
		this.luminanceTarget.dispose();
		for(const target of this._downTargets) target.dispose();
		for(const target of this._upTargets) target.dispose();
		this._downTargets = [];
		this._upTargets = [];
		this.smaaPass?.dispose();

	}

}
