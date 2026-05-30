import {
  createPreparedRenderWindow,
  PreparedRenderFrameMaskStatus,
  type PreparedMaskFrame,
} from "#render-preparation/prepared-render-window";
import type { BufferedDetectionTimeline } from "#types/detection-timeline";
import type { MaskStyle } from "#types/mask-style";
import type { RenderPreparationOptions } from "#types/render-preparation";
import type {
  ImageSource as PixiImageSource,
  Sprite as PixiSprite,
  Texture as PixiTexture,
} from "pixi.js";

const MAX_PENDING_MASK_HOLD_SECONDS = 0.05;

type ImageSourceConstructor = new (options: {
  dynamic: boolean;
  height: number;
  resource: HTMLCanvasElement | ImageBitmap;
  width: number;
}) => PixiImageSource;

type TextureConstructor = new (options: {
  dynamic: boolean;
  source: PixiImageSource;
}) => PixiTexture;

type SpriteConstructor = new (options?: {
  texture?: PixiTexture;
}) => PixiSprite;

export interface PixiMaskLayer {
  createSprite(dimensions: { width: number; height: number }): PixiSprite;
  drawFrame(mediaTime: number): void;
  setMaskStyle(maskStyle: MaskStyle | null | undefined): void;
  destroy(): void;
}

export function createPixiMaskLayer(options: {
  readonly ImageSource: ImageSourceConstructor;
  readonly Sprite: SpriteConstructor;
  readonly Texture: TextureConstructor;
  readonly detectionTimeline: BufferedDetectionTimeline;
  readonly maskStyle: MaskStyle;
  readonly renderPreparation?: RenderPreparationOptions;
}): PixiMaskLayer {
  let mediaHeight = 0;
  let mediaWidth = 0;
  let maskSprite: PixiSprite | undefined;
  let activeFrameKey: string | null = null;
  let activeFrameMediaTime: number | null = null;
  let maskOpacity = resolveMaskOpacity(options.maskStyle);
  let visibleMaskMediaTime: number | null = null;
  let isDestroyed = false;
  const maskTextures = new Map<string, PixiTexture>();
  const preparedRenderWindow = createPreparedRenderWindow({
    detectionTimeline: options.detectionTimeline,
    maskStyle: options.maskStyle,
    onMaskFrameEvicted(key) {
      destroyTexture(key);
      if (key === activeFrameKey) {
        activeFrameKey = null;
        activeFrameMediaTime = null;
        hideSprite();
      }
    },
    onMaskFramePrepared(maskFrame) {
      if (!isDestroyed && maskFrame.key === activeFrameKey) {
        showMaskFrame(maskFrame, activeFrameMediaTime);
      }
    },
    onMaskFramesCleared() {
      activeFrameKey = null;
      activeFrameMediaTime = null;
      destroyTextures();
      hideSprite();
    },
    renderPreparation: options.renderPreparation,
  });

  return {
    createSprite({ width, height }) {
      mediaWidth = width;
      mediaHeight = height;
      maskSprite = new options.Sprite();
      maskSprite.alpha = maskOpacity;
      maskSprite.visible = false;
      maskSprite.width = mediaWidth;
      maskSprite.height = mediaHeight;
      return maskSprite;
    },

    drawFrame(mediaTime) {
      const preparedFrame = preparedRenderWindow.getFrame(mediaTime);

      if (!preparedFrame || !maskSprite) {
        activeFrameKey = preparedFrame?.key ?? null;
        activeFrameMediaTime = preparedFrame?.detectionFrame.mediaTime ?? null;
        hideSprite();
        return;
      }

      activeFrameKey = preparedFrame.key;
      activeFrameMediaTime = preparedFrame.detectionFrame.mediaTime;

      if (preparedFrame.maskFrame) {
        showMaskFrame(
          preparedFrame.maskFrame,
          preparedFrame.detectionFrame.mediaTime,
        );
        return;
      }

      if (
        preparedFrame.maskStatus === PreparedRenderFrameMaskStatus.Empty ||
        preparedFrame.maskStatus === PreparedRenderFrameMaskStatus.Disabled
      ) {
        hideSprite();
        return;
      }

      if (!canHoldVisibleMaskFor(preparedFrame.detectionFrame.mediaTime)) {
        hideSprite();
      }
    },

    setMaskStyle(nextMaskStyle) {
      if (nextMaskStyle !== undefined) {
        maskOpacity = resolveMaskOpacity(nextMaskStyle);
        applyMaskOpacity();
      }

      preparedRenderWindow.setMaskStyle(nextMaskStyle);
    },

    destroy() {
      if (isDestroyed) {
        return;
      }

      isDestroyed = true;
      preparedRenderWindow.destroy();
      destroyTextures();
    },
  };

  function showMaskFrame(
    maskFrame: PreparedMaskFrame,
    mediaTime: number | null,
  ) {
    visibleMaskMediaTime = mediaTime;
    showTexture(getTexture(maskFrame));
  }

  function getTexture(maskFrame: PreparedMaskFrame) {
    const existingTexture = maskTextures.get(maskFrame.key);

    if (existingTexture) {
      return existingTexture;
    }

    const imageSource = new options.ImageSource({
      dynamic: false,
      height: maskFrame.height,
      resource: maskFrame.source,
      width: maskFrame.width,
    });
    const texture = new options.Texture({
      dynamic: false,
      source: imageSource,
    });

    maskTextures.set(maskFrame.key, texture);

    return texture;
  }

  function showTexture(texture: PixiTexture) {
    if (!maskSprite) {
      return;
    }

    maskSprite.texture = texture;
    applyMaskOpacity();
    maskSprite.width = mediaWidth;
    maskSprite.height = mediaHeight;
    maskSprite.visible = true;
  }

  function hideSprite() {
    visibleMaskMediaTime = null;

    if (maskSprite) {
      maskSprite.visible = false;
    }
  }

  function canHoldVisibleMaskFor(mediaTime: number) {
    return (
      visibleMaskMediaTime !== null &&
      Math.abs(mediaTime - visibleMaskMediaTime) <=
        MAX_PENDING_MASK_HOLD_SECONDS
    );
  }

  function applyMaskOpacity() {
    if (maskSprite) {
      maskSprite.alpha = maskOpacity;
    }
  }

  function destroyTexture(key: string) {
    const texture = maskTextures.get(key);

    maskTextures.delete(key);
    texture?.destroy(true);
  }

  function destroyTextures() {
    for (const texture of maskTextures.values()) {
      texture.destroy(true);
    }

    maskTextures.clear();
  }
}

function resolveMaskOpacity(maskStyle: MaskStyle | null | undefined) {
  const opacity = maskStyle?.opacity;

  if (opacity === undefined) {
    return 1;
  }

  return Number.isFinite(opacity) ? Math.max(0, Math.min(opacity, 1)) : 1;
}
