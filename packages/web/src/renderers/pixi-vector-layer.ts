import {
  BaseKeypointStyle,
  BasePolygonStyle,
  BasePolylineStyle,
  KeypointMarkerShape,
  type BufferedDetectionTimeline,
  type Detection,
  type DetectionFrame,
  type AnnotationStyleContext,
  type KeypointStyle,
  type PolygonStyle,
  type PolylineStyle,
} from "supervision-js-core";
import type {
  Container as PixiContainer,
  Graphics as PixiGraphics,
} from "pixi.js";
import { drawPixiPath, resolveScreenLength } from "./pixi-path";

interface RetainedVectorEntry {
  readonly display: PixiGraphics;
  key: string;
}

export interface PixiVectorLayer {
  createContainer(): PixiContainer;
  drawFrame(mediaTime: number, viewportScale?: number): void;
  invalidateDetection(id: string | number): void;
  translateDetection(id: string | number, x: number, y: number): boolean;
  setStyles(styles: {
    polygonStyle?: PolygonStyle | null;
    polylineStyle?: PolylineStyle | null;
    keypointStyle?: KeypointStyle | null;
  }): void;
  destroy(): void;
}

export function createPixiVectorLayer(options: {
  readonly Container: new () => PixiContainer;
  readonly Graphics: new () => PixiGraphics;
  readonly detectionTimeline: BufferedDetectionTimeline;
  readonly polygonStyle?: PolygonStyle | null;
  readonly polylineStyle?: PolylineStyle | null;
  readonly keypointStyle?: KeypointStyle | null;
  readonly resolveContextState?: (
    detection: Detection,
  ) => Partial<AnnotationStyleContext>;
}): PixiVectorLayer {
  let container: PixiContainer | undefined;
  let polygonStyle =
    options.polygonStyle === undefined
      ? new BasePolygonStyle()
      : options.polygonStyle;
  let polylineStyle =
    options.polylineStyle === undefined
      ? new BasePolylineStyle()
      : options.polylineStyle;
  let keypointStyle =
    options.keypointStyle === undefined
      ? new BaseKeypointStyle()
      : options.keypointStyle;
  let styleVersion = 0;
  let lastFrameKey = "";
  let lastViewportScale = 0;
  const entries = new Map<string, RetainedVectorEntry>();
  const invalidated = new Set<string>();

  return {
    createContainer() {
      if (!container) {
        container = new options.Container();
        container.sortableChildren = true;
      }

      return container;
    },

    drawFrame(mediaTime, viewportScale = 1) {
      const frame = options.detectionTimeline.selectFrame(mediaTime);
      const frameKey = frame
        ? `${frame.frameIndex ?? "time"}:${frame.mediaTime}:${styleVersion}`
        : "none";

      if (
        frameKey === lastFrameKey &&
        viewportScale === lastViewportScale &&
        invalidated.size === 0
      ) {
        return;
      }

      lastFrameKey = frameKey;
      lastViewportScale = viewportScale;

      if (!frame) {
        hideAll();
        return;
      }

      const activeKeys = new Set<string>();

      frame.detections.forEach((detection, detectionIndex) => {
        if (!detection.polygon && !detection.polyline && !detection.keypoints) {
          return;
        }
        const key = detectionKey(detection, detectionIndex);
        activeKeys.add(key);
        const entry = ensureEntry(key);
        entry.display.visible = true;
        entry.display.zIndex = detection.zIndex ?? detectionIndex;
        entry.display.position?.set?.(0, 0);
        drawDetection(
          entry.display,
          detection,
          detectionIndex,
          frame,
          mediaTime,
          viewportScale,
        );
        invalidated.delete(key);
      });

      for (const [key, entry] of entries) {
        if (!activeKeys.has(key)) {
          entry.display.visible = false;
        }
      }
    },

    invalidateDetection(id) {
      invalidated.add(`id:${String(id)}`);
    },

    translateDetection(id, x, y) {
      const entry = entries.get(`id:${String(id)}`);

      if (!entry) {
        return false;
      }

      entry.display.position?.set?.(x, y);
      return true;
    },

    setStyles(styles) {
      if (styles.polygonStyle !== undefined) polygonStyle = styles.polygonStyle;
      if (styles.polylineStyle !== undefined)
        polylineStyle = styles.polylineStyle;
      if (styles.keypointStyle !== undefined)
        keypointStyle = styles.keypointStyle;
      styleVersion += 1;
    },

    destroy() {
      entries.clear();
      invalidated.clear();
      container = undefined;
    },
  };

  function ensureEntry(key: string) {
    let entry = entries.get(key);

    if (!entry) {
      entry = { display: new options.Graphics(), key };
      entries.set(key, entry);
      container?.addChild(entry.display);
    }

    return entry;
  }

  function hideAll() {
    for (const entry of entries.values()) entry.display.visible = false;
  }

  function drawDetection(
    graphics: PixiGraphics,
    detection: Detection,
    detectionIndex: number,
    frame: DetectionFrame,
    mediaTime: number,
    viewportScale: number,
  ) {
    graphics.clear();
    const context = {
      detectionIndex,
      frame,
      mediaTime,
      viewportScale,
      ...options.resolveContextState?.(detection),
    };
    const polygon = polygonStyle?.resolve(detection, context);

    if (polygon) {
      graphics.poly(
        polygon.points.flatMap(({ x, y }) => [x, y]),
        true,
      );
      if (polygon.fill) graphics.fill(polygon.fill);
      if (polygon.stroke)
        drawPixiPath(
          graphics,
          polygon.points,
          true,
          polygon.stroke,
          viewportScale,
        );
    }

    const polyline = polylineStyle?.resolve(detection, context);
    if (polyline)
      drawPixiPath(
        graphics,
        polyline.points,
        false,
        polyline.stroke,
        viewportScale,
      );

    const keypoints = keypointStyle?.resolve(detection, context);
    if (!keypoints) return;

    for (const edge of keypoints.edges) {
      if (edge.shadowStroke)
        drawPixiPath(
          graphics,
          [edge.from, edge.to],
          false,
          edge.shadowStroke,
          viewportScale,
        );
      drawPixiPath(
        graphics,
        [edge.from, edge.to],
        false,
        edge.stroke,
        viewportScale,
      );
    }

    for (const marker of keypoints.markers) {
      const radius = resolveScreenLength(marker.radius, viewportScale);
      if (marker.shape === KeypointMarkerShape.Cross) {
        drawPixiPath(
          graphics,
          [
            { x: marker.point.x - radius, y: marker.point.y - radius },
            { x: marker.point.x + radius, y: marker.point.y + radius },
          ],
          false,
          marker.stroke ?? { alpha: 1, color: 0xffffff, width: 2 },
          viewportScale,
        );
        drawPixiPath(
          graphics,
          [
            { x: marker.point.x + radius, y: marker.point.y - radius },
            { x: marker.point.x - radius, y: marker.point.y + radius },
          ],
          false,
          marker.stroke ?? { alpha: 1, color: 0xffffff, width: 2 },
          viewportScale,
        );
      } else {
        graphics.circle(marker.point.x, marker.point.y, radius);
        if (marker.fill) graphics.fill(marker.fill);
        if (marker.stroke)
          graphics.stroke({
            alpha: marker.stroke.alpha,
            color: marker.stroke.color,
            width: resolveScreenLength(marker.stroke.width, viewportScale),
          });
      }
    }
  }
}

function detectionKey(detection: Detection, detectionIndex: number) {
  return detection.id === undefined
    ? `index:${detectionIndex}`
    : `id:${String(detection.id)}`;
}
