import {
  BaseKeypointStyle,
  BasePolygonStyle,
  BasePolylineStyle,
  KeypointMarkerShape,
  type BufferedDetectionTimeline,
  type Detection,
  type DetectionFrame,
  type AnnotationStyleContext,
  type KeypointDrawInstruction,
  type KeypointStyle,
  type PolygonDrawInstruction,
  type PolygonStyle,
  type PolylineDrawInstruction,
  type PolylineStyle,
} from "supervision-js-core";
import type {
  Container as PixiContainer,
  Graphics as PixiGraphics,
} from "pixi.js";
import { drawPixiPath, resolveScreenLength } from "./pixi-path";

interface RetainedVectorEntry {
  readonly display: PixiGraphics;
  cleared: boolean;
}

interface ResolvedVectorDetection {
  readonly key: string;
  readonly zIndex: number;
  readonly polygon?: PolygonDrawInstruction;
  readonly polyline?: PolylineDrawInstruction;
  readonly keypoints?: KeypointDrawInstruction;
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
  const entryPool: RetainedVectorEntry[] = [];
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
        releaseInactiveEntries(new Set<string>());
        invalidated.clear();
        return;
      }

      const resolvedDetections = frame.detections.flatMap(
        (detection, detectionIndex) => {
          if (
            !detection.polygon &&
            !detection.polyline &&
            !detection.keypoints
          ) {
            return [];
          }

          const resolved = resolveDetection(
            detection,
            detectionIndex,
            frame,
            mediaTime,
            viewportScale,
          );

          return resolved ? [resolved] : [];
        },
      );
      const activeKeys = new Set<string>(
        resolvedDetections.map((detection) => detection.key),
      );
      releaseInactiveEntries(activeKeys);

      for (const detection of resolvedDetections) {
        const entry = ensureEntry(detection.key);
        entry.display.visible = true;
        entry.display.zIndex = detection.zIndex;
        entry.display.position?.set?.(0, 0);
        drawDetection(entry, detection, viewportScale);
      }

      invalidated.clear();
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
      entryPool.length = 0;
      invalidated.clear();
      container = undefined;
    },
  };

  function ensureEntry(key: string) {
    let entry = entries.get(key);

    if (!entry) {
      entry = entryPool.pop();

      if (!entry) {
        entry = { cleared: false, display: new options.Graphics() };
        container?.addChild(entry.display);
      }

      entries.set(key, entry);
    }

    return entry;
  }

  function releaseInactiveEntries(activeKeys: ReadonlySet<string>) {
    for (const [key, entry] of entries) {
      if (activeKeys.has(key)) continue;

      entries.delete(key);
      entry.display.clear();
      entry.cleared = true;
      entry.display.visible = false;
      entry.display.position?.set?.(0, 0);
      entryPool.push(entry);
    }
  }

  function resolveDetection(
    detection: Detection,
    detectionIndex: number,
    frame: DetectionFrame,
    mediaTime: number,
    viewportScale: number,
  ): ResolvedVectorDetection | undefined {
    const context = {
      detectionIndex,
      frame,
      mediaTime,
      viewportScale,
      ...options.resolveContextState?.(detection),
    };
    const polygon = polygonStyle?.resolve(detection, context);
    const polyline = polylineStyle?.resolve(detection, context);
    const keypoints = keypointStyle?.resolve(detection, context);

    if (!polygon && !polyline && !keypoints) return undefined;

    return {
      key: detectionKey(detection, detectionIndex),
      keypoints,
      polygon,
      polyline,
      zIndex: detection.zIndex ?? detectionIndex,
    };
  }

  function drawDetection(
    entry: RetainedVectorEntry,
    detection: ResolvedVectorDetection,
    viewportScale: number,
  ) {
    const graphics = entry.display;
    if (!entry.cleared) graphics.clear();
    entry.cleared = false;
    const { keypoints, polygon, polyline } = detection;

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

    if (polyline)
      drawPixiPath(
        graphics,
        polyline.points,
        false,
        polyline.stroke,
        viewportScale,
      );

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
