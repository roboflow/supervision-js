import type { MaskBrushPreviewOptions } from "#editing/mask-brush-editor";
import type {
  CanvasSource as PixiCanvasSource,
  Container as PixiContainer,
  Graphics as PixiGraphics,
  Sprite as PixiSprite,
  Texture as PixiTexture,
} from "pixi.js";

import { resolveScreenLength } from "./pixi-path";
import { fitTextureSize } from "./pixi-texture-size";

export interface PixiMaskBrushPreview {
  readonly display: PixiContainer;
  setViewportScale(scale: number): void;
  destroy(): void;
}

export function createPixiMaskBrushPreview(options: {
  readonly preview: MaskBrushPreviewOptions;
  readonly onInvalidate?: () => void;
  /** GPU texture limit; a larger brush canvas is uploaded through a fitted copy. */
  readonly maxTextureSize?: number;
  readonly createCanvas?: () => HTMLCanvasElement;
  readonly CanvasSource: new (options: {
    dynamic: boolean;
    height: number;
    resource: HTMLCanvasElement;
    width: number;
  }) => PixiCanvasSource;
  readonly Container: new () => PixiContainer;
  readonly Graphics: new () => PixiGraphics;
  readonly Sprite: new (options: { texture: PixiTexture }) => PixiSprite;
  readonly Texture: new (options: {
    dynamic: boolean;
    source: PixiCanvasSource;
  }) => PixiTexture;
}): PixiMaskBrushPreview {
  const { editor } = options.preview;
  const upload = createUploadCanvas(
    editor.canvas,
    options.maxTextureSize ?? Infinity,
    options.createCanvas ?? (() => document.createElement("canvas")),
  );
  const source = new options.CanvasSource({
    dynamic: true,
    height: upload.canvas.height,
    resource: upload.canvas,
    width: upload.canvas.width,
  });
  const texture = new options.Texture({ dynamic: true, source });
  const sprite = new options.Sprite({ texture });
  const cursor = new options.Graphics();
  const display = new options.Container();
  let viewportScale = 1;
  let isDestroyed = false;
  let invalidationQueued = false;

  sprite.width = editor.canvas.width;
  sprite.height = editor.canvas.height;
  sprite.alpha = options.preview.alpha ?? 0.4;
  sprite.tint = options.preview.color ?? 0x22c55e;
  display.addChild(sprite, cursor);

  const updateTexture = () => {
    upload.copy();
    source.update();
    scheduleInvalidation();
  };
  const unsubscribeTexture = editor.subscribeTextureUpdates(updateTexture);
  const unsubscribeCursor = editor.subscribeCursorUpdates(() => {
    drawCursor();
    scheduleInvalidation();
  });
  drawCursor();

  return {
    display,
    setViewportScale(scale) {
      viewportScale = scale;
      drawCursor();
    },
    destroy() {
      isDestroyed = true;
      unsubscribeCursor();
      unsubscribeTexture();
      texture.destroy();
      source.destroy();
    },
  };

  /**
   * The brush canvas is media-sized. Over the GPU limit its upload fails and the
   * tinted preview sprite, which covers the whole picture, samples black and dims
   * it; so the texture takes a fitted copy while the sprite keeps media size.
   */
  function createUploadCanvas(
    brushCanvas: HTMLCanvasElement,
    maxTextureSize: number,
    createCanvas: () => HTMLCanvasElement,
  ) {
    const fitted = fitTextureSize(
      brushCanvas.width,
      brushCanvas.height,
      maxTextureSize,
    );
    if (
      fitted.width === brushCanvas.width &&
      fitted.height === brushCanvas.height
    ) {
      return { canvas: brushCanvas, copy: () => undefined };
    }

    const canvas = createCanvas();
    canvas.width = fitted.width;
    canvas.height = fitted.height;
    const context = canvas.getContext("2d");
    const copy = () => {
      if (!context) return;
      context.clearRect(0, 0, fitted.width, fitted.height);
      context.drawImage(brushCanvas, 0, 0, fitted.width, fitted.height);
    };
    copy();
    return { canvas, copy };
  }

  function scheduleInvalidation() {
    const onInvalidate = options.onInvalidate;
    if (!onInvalidate || isDestroyed || invalidationQueued) return;
    invalidationQueued = true;
    queueMicrotask(() => {
      invalidationQueued = false;
      if (!isDestroyed) onInvalidate();
    });
  }

  function drawCursor() {
    cursor.clear();
    const state = editor.getCursor();
    if (!state.point) return;
    cursor.circle(state.point.x, state.point.y, state.radius);
    cursor.stroke({
      alpha: 1,
      color: options.preview.cursorColor ?? 0xffffff,
      width: resolveScreenLength(1, viewportScale),
    });
  }
}
