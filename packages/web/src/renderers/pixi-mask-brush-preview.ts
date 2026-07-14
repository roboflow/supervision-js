import type { MaskBrushPreviewOptions } from "#editing/mask-brush-editor";
import type {
  CanvasSource as PixiCanvasSource,
  Container as PixiContainer,
  Graphics as PixiGraphics,
  Sprite as PixiSprite,
  Texture as PixiTexture,
} from "pixi.js";

import { resolveScreenLength } from "./pixi-path";

export interface PixiMaskBrushPreview {
  readonly display: PixiContainer;
  setViewportScale(scale: number): void;
  destroy(): void;
}

export function createPixiMaskBrushPreview(options: {
  readonly preview: MaskBrushPreviewOptions;
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
  const source = new options.CanvasSource({
    dynamic: true,
    height: editor.canvas.height,
    resource: editor.canvas,
    width: editor.canvas.width,
  });
  const texture = new options.Texture({ dynamic: true, source });
  const sprite = new options.Sprite({ texture });
  const cursor = new options.Graphics();
  const display = new options.Container();
  let viewportScale = 1;

  sprite.width = editor.canvas.width;
  sprite.height = editor.canvas.height;
  sprite.alpha = options.preview.alpha ?? 0.4;
  sprite.tint = options.preview.color ?? 0x22c55e;
  display.addChild(sprite, cursor);

  const update = () => {
    source.update();
    texture.update();
    drawCursor();
  };
  const unsubscribe = editor.subscribeTextureUpdates(update);
  drawCursor();

  return {
    display,
    setViewportScale(scale) {
      viewportScale = scale;
      drawCursor();
    },
    destroy() {
      unsubscribe();
      texture.destroy();
      source.destroy();
    },
  };

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
