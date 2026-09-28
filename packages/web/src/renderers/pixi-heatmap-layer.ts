import type {
  BufferedDetectionTimeline,
  Detection,
  DetectionFrame,
  HeatmapAnnotationRenderer,
} from "supervision-js-core";
import type {
  CanvasSource as PixiCanvasSource,
  Container as PixiContainer,
  Sprite as PixiSprite,
  Texture as PixiTexture,
} from "pixi.js";
import { colorizeHeatmap } from "./heatmap-color";

export function createPixiHeatmapLayer(options: {
  readonly CanvasSource: new (options: {
    resource: HTMLCanvasElement;
    width: number;
    height: number;
  }) => PixiCanvasSource;
  readonly Container: new () => PixiContainer;
  readonly Sprite: new (options: { texture: PixiTexture }) => PixiSprite;
  readonly Texture: new (options: { source: PixiCanvasSource }) => PixiTexture;
  readonly detectionTimeline: BufferedDetectionTimeline;
  readonly isVisible: (detection: Detection) => boolean;
  readonly renderers: readonly HeatmapAnnotationRenderer[];
}) {
  const container = new options.Container();
  let renderers = options.renderers;
  let lastFrame: DetectionFrame | undefined;
  let dirty = true;
  let warnedInvalidHeatmap = false;
  const positionedSprites: {
    readonly sprite: PixiSprite;
    readonly detectionId: string | number | undefined;
    readonly x: number;
    readonly y: number;
  }[] = [];

  const clear = () => {
    for (const { sprite } of positionedSprites) {
      const texture = sprite.texture;
      sprite.removeFromParent();
      sprite.destroy();
      texture.destroy(true);
    }
    positionedSprites.length = 0;
  };

  return {
    createContainer: () => container,
    setRenderers(next: readonly HeatmapAnnotationRenderer[]) {
      renderers = next;
      dirty = true;
    },
    invalidate() {
      dirty = true;
    },
    translateDetection(id: string | number, dx: number, dy: number) {
      let translated = false;
      for (const entry of positionedSprites) {
        if (entry.detectionId !== id) continue;
        entry.sprite.x = entry.x + dx;
        entry.sprite.y = entry.y + dy;
        translated = true;
      }
      return translated;
    },
    drawFrame(mediaTime: number) {
      const frame = options.detectionTimeline.selectFrame(mediaTime);
      if (!dirty && frame === lastFrame) return;
      clear();
      if (!frame || renderers.length === 0) {
        lastFrame = frame;
        dirty = false;
        return;
      }

      const orderedDetections = frame.detections
        .map((detection, index) => ({ detection, index }))
        .sort(
          (left, right) =>
            (left.detection.zIndex ?? left.index) -
              (right.detection.zIndex ?? right.index) ||
            left.index - right.index,
        );
      for (const { detection } of orderedDetections) {
        const map = detection.heatmap;
        if (!map || !options.isVisible(detection)) continue;
        for (const renderer of renderers) {
          let rgba: Uint8ClampedArray;
          try {
            // Reject malformed or oversized rasters before canvas allocation.
            rgba = colorizeHeatmap(map, renderer);
          } catch (error) {
            if (!(error instanceof RangeError)) throw error;
            if (!warnedInvalidHeatmap) {
              console.warn("Skipping an invalid detection heatmap.", error);
              warnedInvalidHeatmap = true;
            }
            continue;
          }
          const canvas = document.createElement("canvas");
          canvas.width = map.width;
          canvas.height = map.height;
          const context = canvas.getContext("2d");
          if (!context) continue;
          const pixels = context.createImageData(map.width, map.height);
          pixels.data.set(rgba);
          context.putImageData(pixels, 0, 0);
          const texture = new options.Texture({
            source: new options.CanvasSource({
              resource: canvas,
              width: map.width,
              height: map.height,
            }),
          });
          const sprite = new options.Sprite({ texture });
          sprite.x = map.bounds.x - map.bounds.width / 2;
          sprite.y = map.bounds.y - map.bounds.height / 2;
          sprite.width = map.bounds.width;
          sprite.height = map.bounds.height;
          container.addChild(sprite);
          positionedSprites.push({
            sprite,
            detectionId: detection.id,
            x: sprite.x,
            y: sprite.y,
          });
        }
      }
      lastFrame = frame;
      dirty = false;
    },
    destroy() {
      clear();
      container.destroy();
    },
  };
}
