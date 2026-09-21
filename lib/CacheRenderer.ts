import {
	AssetEvent,
	IAssetClass,
	Matrix3D,
	PerspectiveProjection,
	Rectangle,
} from '@awayjs/core';
import {
	AttributesBuffer,
	Image2D,
	ContextGLTriangleFace,
	StageEvent,
	ImageSampler
} from '@awayjs/stage';
import {
	ContainerNode,
	ContainerNodeEvent,
	HierarchicalProperty,
	INode,
	PickGroup
} from '@awayjs/view';

import { IMaterial } from './base/IMaterial';
import { ITexture } from './base/ITexture';
import { Style } from './base/Style';
import { _IRender_MaterialClass } from './base/_IRender_MaterialClass';
import { _Render_RenderableBase } from './base/_Render_RenderableBase';
import { _Render_RendererMaterial } from './base/_Render_RendererMaterial';
import { _Stage_ElementsBase } from './base/_Stage_ElementsBase';
import { TriangleElements, _Stage_TriangleElements } from './elements/TriangleElements';
import { MaterialEvent } from './events/MaterialEvent';
import { RendererBase } from './RendererBase';
import { RenderGroup } from './RenderGroup';
import { ImageTexture2D } from './textures/ImageTexture2D';
import { Settings as StageSettings } from '@awayjs/stage';
import { RenderEntity } from './base/RenderEntity';
import { DefaultRenderer } from './DefaultRenderer';
import { IRenderable } from './base/IRenderable';
import { IRenderContainer } from './base/IRenderContainer';

export class CacheRenderer extends RendererBase implements IMaterial, IRenderable {
	public static assetType: string = '[renderer CacheRenderer]';
	private _blendSource: Image2D = null;

	private _texture: ImageTexture2D;
	private _textures: ITexture[] = [];
	private _onTextureInvalidate: (event: AssetEvent) => void;
	private _onInvalidateSceneTransform: (event: ContainerNodeEvent) => void;
	private _onInvalidateColorTransform: (event: ContainerNodeEvent) => void;

	public animateUVs: boolean = false;

	public bothSides: boolean = false;

	public curves: boolean = false;

	public imageRect: boolean = false;

	public useColorTransform: boolean = true;

	public alphaBlending: boolean = true;

	public alphaThreshold: number = 0;

	public get assetType(): string {
		return CacheRenderer.assetType;
	}

	/**
	* The 2d texture to use as a bitmap cache.
	*/
	public get texture(): ImageTexture2D {

		//TODO check invalidation of _texture

		return this._texture;
	}

	public set texture(value: ImageTexture2D) {
		if (this._texture == value)
			return;

		if (this._texture)
			this.removeTexture(this._texture);

		this._texture = value;

		if (this._texture)
			this.addTexture(this._texture);

		this.invalidatePasses();
	}

	constructor() {
		super();

		this._onTextureInvalidate = (event: AssetEvent) => this.invalidate();
		this._onInvalidateSceneTransform = (event: ContainerNodeEvent) => this.onInvalidateSceneTransform();
		this._onInvalidateColorTransform = (event: ContainerNodeEvent) => this.onInvalidateColorTransform();

		this._traverserGroup = RenderGroup.getInstance(CacheRenderer);
		this._maskGroup = RenderGroup.getInstance(DefaultRenderer);
	}

	public _onInvalidateElements(): void {
		// for (const key in this._abstractionPool)
		// 	(this._abstractionPool[key] as _Render_RenderableBase)._onInvalidateElements();
	}

	public _onInvalidateMaterial(): void {
		// for (const key in this._abstractionPool)
		// 	(this._abstractionPool[key] as _Render_RenderableBase)._onInvalidateMaterial();
	}

	public init(node: INode, group: RenderGroup): void {
		super.init(node, group);

		node.view.stage.addEventListener(StageEvent.INVALIDATE_SIZE, this._onSizeInvalidateDelegate);

		if (this._parentNode) {
			this._parentNode.addEventListener(ContainerNodeEvent.INVALIDATE_MATRIX3D, this._onInvalidateSceneTransform);
			this._parentNode.addEventListener(ContainerNodeEvent.INVALIDATE_COLOR_TRANSFORM, this._onInvalidateColorTransform);
		}

		// for check filters/blends changes
		(<IRenderContainer> node.container)._renderObjects[group.id] = this;

		this.texture = new ImageTexture2D();
	}

	public render(
		enableDepthAndStencil: boolean = true,
		surfaceSelector: number = 0,
		mipmapSelector: number = 0,
		maskConfig: number = 0
	): void {
		const bounds = this.getPaddedBounds();
		if (bounds.width <= 0 || bounds.height <= 0)
			return;

		const container = this.node.container;

		const stage = this.stage;
		const useNonNativeBlend = this.useNonNativeBlend;
		const targetImage = <Image2D> this._style.image;

		if (!targetImage) {
			return super.render(enableDepthAndStencil, surfaceSelector, mipmapSelector, maskConfig);
		}

		// Nested caches and filters must restore the caller's render target.
		stage.pushRenderTargetConfig();
		const manager = stage.filterManager;
		const msaa = stage.context.glVersion === 2 && StageSettings.ENABLE_MULTISAMPLE_TEXTURE;
		const temporaryImages: Image2D[] = [];
		const temporary = (multisample: boolean = false): Image2D => {
			const image = manager.popTemp(targetImage.width, targetImage.height, multisample);
			temporaryImages.push(image);
			return image;
		};

		try {
			// The source must be isolated from the backdrop even without MSAA.
			const reuseSource = this.useCroppedBlend && this._blendSource && !this._invalid;
			let sourceImage = reuseSource ? this._blendSource
				: (msaa || useNonNativeBlend) ? temporary(msaa) : targetImage;

			let backdropImage: Image2D;
			let backdropRect: Rectangle;
			if (useNonNativeBlend && this.useCroppedBlend) {
				const parent = this.parentRenderer;
				backdropImage = parent.flushBlendBackdrop();
				const parentBounds = parent.getPaddedBounds();
				const rect = bounds.clone();
				rect.x -= parentBounds.x;
				rect.y -= parentBounds.y;
				backdropRect = rect;
				this._disableClear = false;
			} else if (useNonNativeBlend) {
				const parent = this.parentRenderer;
				const projection = parent.view.projection;
				const previousTarget = parent.view.target;
				// Preserve antialiasing for all preceding siblings, including text.
				const backdrop = msaa ? temporary(true) : targetImage;
				try {
					parent.view.projection = new PerspectiveProjection();
					parent._initRender(backdrop);
					parent.executeRender(true);
					// A masked composite covers only part of the backdrop. Keep
					// earlier siblings so their pixels outside the mask survive.
					if (!this._parentNode?.getMaskOwners()?.length)
						parent.resetHead();
				} finally {
					parent.view.target = previousTarget;
					parent.view.projection = projection;
				}
				if (backdrop !== targetImage)
					manager.copyPixels(backdrop, targetImage, targetImage.rect, targetImage.rect.topLeft);
				this._disableClear = false;
			}

			let filtered = false;
			if (!reuseSource) {
				this._initRender(sourceImage);
				super.render(enableDepthAndStencil, surfaceSelector, mipmapSelector, maskConfig);

				//@ts-ignore
				const filters = container.filters;
				if (filters && filters.length > 0) {
					const scale = this.getBoundsScale();
					filters.forEach((e) => e && (e.imageScale = scale));
					// Filters affect the isolated object, never its captured backdrop.
					const filterTarget = useNonNativeBlend ? temporary() : targetImage;
					filtered = manager.applyFilters(
						sourceImage, filterTarget, targetImage.rect, targetImage.rect, filters);
					if (filtered)
						sourceImage = filterTarget;
				}

				if (this.useCroppedBlend) {
					if (!this._blendSource)
						this._blendSource = new Image2D(targetImage.width, targetImage.height, false);
					else
						this._blendSource._setSize(targetImage.width, targetImage.height);
					manager.copyPixels(sourceImage, this._blendSource, targetImage.rect, targetImage.rect.topLeft);
					sourceImage = this._blendSource;
				} else if (this._blendSource) {
					this._blendSource.clear();
					this._blendSource = null;
				}
			}

			const composed = backdropImage && manager.compositePixels(
				sourceImage, backdropImage, targetImage, targetImage.rect, backdropRect, <string> container.blendMode);
			if (!composed && (useNonNativeBlend || (!filtered && sourceImage !== targetImage))) {
				if (backdropImage)
					manager.copyPixels(backdropImage, targetImage, backdropRect, targetImage.rect.topLeft);
				manager.copyPixels(sourceImage, targetImage, targetImage.rect, targetImage.rect.topLeft,
					useNonNativeBlend, useNonNativeBlend ? <string> container.blendMode : '');
			}
		} catch (error) {
			this._invalid = true;
			throw error;
		} finally {
			for (const image of temporaryImages)
				manager.pushTemp(image);
			stage.popRenderTarget();
		}
	}

	public _updateBounds(): void {
		super._updateBounds();

		const image =  <Image2D> this._style.image;
		const pad = this._paddedBounds;
		// Do not allocate a zero-sized texture or shrink an existing cache to
		// zero. Traversal skips it until content/bounds are invalidated again.
		if (pad.width <= 0 || pad.height <= 0)
			return;

		if (image) {
			(<Image2D> this._style.image)._setSize(pad.width, pad.height);
		} else {

			this._style.image = new Image2D(pad.width, pad.height, false);
			this._style.sampler = new ImageSampler(false, false, false);
			//this._view.target = this._style.image;
		}
	}

	// apply blend modes and swap texture if needed
	public preActivateRenderPass() {

	}

	public getNumTextures(): number {
		return this._textures.length;
	}

	public getTextureAt(index: number): ITexture {
		return this._textures[index];
	}

	public addTexture(texture: ITexture): void {
		this._textures.push(texture);

		texture.addEventListener(AssetEvent.INVALIDATE, this._onTextureInvalidate);

		this.invalidate();
	}

	public removeTexture(texture: ITexture): void {
		this._textures.splice(this._textures.indexOf(texture), 1);

		texture.removeEventListener(AssetEvent.INVALIDATE, this._onTextureInvalidate);

		this.invalidate();
	}

	/**
	 * Marks the shader programs for all passes as invalid, so they will be recompiled before the next use.
	 *
	 * @private
	 */
	public invalidatePasses(): void {
		this.dispatchEvent(new MaterialEvent(MaterialEvent.INVALIDATE_PASSES, this));
	}

	/**
	 *
	 */
	public enterNode(node: ContainerNode): boolean {
		const enter: boolean = super.enterNode(node);

		if (enter && node.boundsVisible)
			this.applyEntity(node.getBoundsPrimitive(PickGroup.getInstance()));

		return enter;
	}

	public onInvalidate(): void {
		super.onInvalidate();

		for (const key in this._renderObjects)
			this._renderObjects[key]._onInvalidateElements();

		for (const key in this._renderObjects)
			this._renderObjects[key]._onInvalidateStyle();

		this.invalidate();
		this.invalidatePasses();
	}

	public onInvalidateSceneTransform(): void {
		(<ContainerNode> this._asset).invalidateHierarchicalProperty(HierarchicalProperty.SCENE_TRANSFORM);
		this.onInvalidate();
	}

	public onInvalidateColorTransform(): void {
		this._invalid = true;
		(<ContainerNode> this._asset).invalidateHierarchicalProperty(HierarchicalProperty.COLOR_TRANSFORM);
		this.invalidate();
	}

	public onClear(): void {
		if (this._blendSource)
			this._blendSource.clear();
		this._blendSource = null;

		this.removeTexture(this._texture);
		this._texture.clear();
		this._texture = null;
		if (this._style.image)
			this._style.image.clear();
		this._style.image = null;

		(<ContainerNode> this._asset).view.stage.removeEventListener(StageEvent.INVALIDATE_SIZE, this._onSizeInvalidateDelegate);

		if (this._parentNode) {
			this._parentNode.removeEventListener(ContainerNodeEvent.INVALIDATE_MATRIX3D, this._onInvalidateSceneTransform);
			this._parentNode.removeEventListener(ContainerNodeEvent.INVALIDATE_COLOR_TRANSFORM, this._onInvalidateColorTransform);
		}

		const container: IRenderContainer = <IRenderContainer> (<ContainerNode> this._asset).container;

		if (container)
			delete container._renderObjects[this.group.id];

		super.onClear();
	}

	public static registerMaterial(renderMaterialClass: _IRender_MaterialClass, materialClass: IAssetClass): void {
		RenderGroup.getInstance(CacheRenderer).registerMaterial(renderMaterialClass, materialClass);
	}
}

export class _Render_Renderer extends _Render_RenderableBase {

	public static assetType: string = '[render Renderer]';

	private _elements: TriangleElements;

	protected _getStageElements(): _Stage_ElementsBase {

		const asset = <CacheRenderer> this.renderable;
		const paddedBounds = asset.getPaddedBounds();
		const matrix3D: Matrix3D = Matrix3D.CALCULATION_MATRIX;
		const scale: number = asset.getBoundsScale();

		matrix3D.copyFrom(this.entity.renderSceneTransform);
		matrix3D.appendScale(scale, scale, scale);
		matrix3D.invert();

		const vectors: number[] = [
			paddedBounds.left, paddedBounds.top, 0,
			paddedBounds.right, paddedBounds.bottom, 0,
			paddedBounds.right, paddedBounds.top, 0,

			paddedBounds.left, paddedBounds.top, 0,
			paddedBounds.left, paddedBounds.bottom, 0,
			paddedBounds.right, paddedBounds.bottom, 0,
		];

		matrix3D.transformVectors(vectors, vectors);

		let elements: TriangleElements = this._elements;

		if (!elements) {
			elements = this._elements = new TriangleElements(new AttributesBuffer(5, 6));
			elements.setPositions(vectors);
			elements.setUVs([0, 0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1]);
		} else {
			elements.setPositions(vectors);
		}

		return this._stage.abstractions.getAbstraction<_Stage_TriangleElements>(elements);
	}

	public draw(
		enableDepthAndStencil: boolean = true,
		surfaceSelector: number = 0, mipmapSelector: number = 0, maskConfig: number = 0): void {

		// disable cull, because for render to texture it is bugged
		this._stage.context.setCulling(ContextGLTriangleFace.NONE);
		super.draw();
	}

	protected _getRenderMaterial(): _Render_RendererMaterial {
		return this.entity.renderer
			.getRenderElements(this.stageElements.elements).abstractions
			.getAbstraction<_Render_RendererMaterial>((<CacheRenderer> this.renderable));
	}

	protected _getStyle(): Style {

		return this.renderable.style;
	}
}
DefaultRenderer.registerMaterial(_Render_RendererMaterial, CacheRenderer);
CacheRenderer.registerMaterial(_Render_RendererMaterial, CacheRenderer);
RenderEntity.registerRenderable(_Render_Renderer, CacheRenderer);
