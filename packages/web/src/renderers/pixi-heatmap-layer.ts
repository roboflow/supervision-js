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
  const sprites: PixiSprite[] = [];

  const clear = () => {
    for (const sprite of sprites) {
      const texture = sprite.texture;
      sprite.removeFromParent();
      sprite.destroy();
      texture.destroy(true);
    }
    sprites.length = 0;
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
    drawFrame(mediaTime: number) {
      const frame = options.detectionTimeline.selectFrame(mediaTime);
      if (!dirty && frame === lastFrame) return;
      lastFrame = frame;
      dirty = false;
      clear();
      if (!frame || renderers.length === 0) return;

      for (const detection of frame.detections) {
        const map = detection.heatmap;
        if (!map || !options.isVisible(detection)) continue;
        for (const renderer of renderers) {
          const canvas = document.createElement("canvas");
          canvas.width = map.width;
          canvas.height = map.height;
          const context = canvas.getContext("2d");
          if (!context) continue;
          const pixels = context.createImageData(map.width, map.height);
          pixels.data.set(colorizeHeatmap(map, renderer));
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
          sprites.push(sprite);
        }
      }
    },
    destroy() {
      clear();
      container.destroy();
    },
  };
}
