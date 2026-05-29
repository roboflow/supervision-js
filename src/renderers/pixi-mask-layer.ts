import {
  createPreparedRenderWindow,
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
  let isDestroyed = false;
  const maskTextures = new Map<string, PixiTexture>();
  const preparedRenderWindow = createPreparedRenderWindow({
    detectionTimeline: options.detectionTimeline,
    maskStyle: options.maskStyle,
    onMaskFrameEvicted(key) {
      destroyTexture(key);
      if (key === activeFrameKey) {
        activeFrameKey = null;
        hideSprite();
      }
    },
    onMaskFramePrepared(maskFrame) {
      if (!isDestroyed && maskFrame.key === activeFrameKey) {
        showMaskFrame(maskFrame);
      }
    },
    onMaskFramesCleared() {
      activeFrameKey = null;
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
      maskSprite.visible = false;
      maskSprite.width = mediaWidth;
      maskSprite.height = mediaHeight;
      return maskSprite;
    },

    drawFrame(mediaTime) {
      const preparedFrame = preparedRenderWindow.getFrame(mediaTime);

      if (!preparedFrame?.maskFrame || !maskSprite) {
        activeFrameKey = preparedFrame?.key ?? null;
        hideSprite();
        return;
      }

      activeFrameKey = preparedFrame.key;
      showMaskFrame(preparedFrame.maskFrame);
    },

    setMaskStyle(nextMaskStyle) {
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

  function showMaskFrame(maskFrame: PreparedMaskFrame) {
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
    maskSprite.width = mediaWidth;
    maskSprite.height = mediaHeight;
    maskSprite.visible = true;
  }

  function hideSprite() {
    if (maskSprite) {
      maskSprite.visible = false;
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
