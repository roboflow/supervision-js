import {
  DEFAULT_OVERLAY_STROKE_ALPHA,
  DEFAULT_OVERLAY_STROKE_COLOR,
  DEFAULT_OVERLAY_STROKE_WIDTH,
} from "#constants/media-renderer";
import type { MediaOverlayFrame } from "#types/media-renderer";
import {
  copySortedOverlayFrames,
  selectOverlayFrame,
} from "#utils/overlay-frames";
import type { Graphics as PixiGraphics } from "pixi.js";

export interface PixiOverlayLayerState {
  readonly activeOverlayFrameTime: number | null;
  readonly activeOverlayRectCount: number;
}

export interface PixiOverlayLayer {
  attachGraphics(graphics: PixiGraphics): void;
  drawFrame(mediaTime: number): PixiOverlayLayerState;
}

export function createPixiOverlayLayer(options: {
  readonly overlayFrames: readonly MediaOverlayFrame[] | undefined;
}): PixiOverlayLayer {
  const overlayFrames = copySortedOverlayFrames(options.overlayFrames);
  let overlayGraphics: PixiGraphics | undefined;
  let lastDrawnOverlayFrame: MediaOverlayFrame | undefined;
  let hasDrawnOverlayFrame = false;

  return {
    attachGraphics(graphics) {
      overlayGraphics = graphics;
    },

    drawFrame(mediaTime) {
      const overlayFrame = selectOverlayFrame(overlayFrames, mediaTime);

      if (hasDrawnOverlayFrame && overlayFrame === lastDrawnOverlayFrame) {
        return getOverlayLayerState(overlayFrame);
      }

      hasDrawnOverlayFrame = true;
      lastDrawnOverlayFrame = overlayFrame;
      overlayGraphics?.clear();

      for (const rect of overlayFrame?.rects ?? []) {
        overlayGraphics?.rect(rect.x, rect.y, rect.width, rect.height).stroke({
          alpha: rect.strokeAlpha ?? DEFAULT_OVERLAY_STROKE_ALPHA,
          color: rect.strokeColor ?? DEFAULT_OVERLAY_STROKE_COLOR,
          width: rect.strokeWidth ?? DEFAULT_OVERLAY_STROKE_WIDTH,
        });
      }

      return getOverlayLayerState(overlayFrame);
    },
  };
}

function getOverlayLayerState(
  overlayFrame: MediaOverlayFrame | undefined,
): PixiOverlayLayerState {
  return {
    activeOverlayFrameTime: overlayFrame?.mediaTime ?? null,
    activeOverlayRectCount: overlayFrame?.rects.length ?? 0,
  };
}
