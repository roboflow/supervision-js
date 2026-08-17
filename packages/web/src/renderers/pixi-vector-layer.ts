import {
  BaseKeypointStyle,
  BasePolygonStyle,
  BasePolylineStyle,
  KeypointMarkerShape,
  MarkerShape,
  MarkerSizeSpace,
  ShapeInstructionKind,
  resolveEllipseSegmentCount,
  resolveMarkerGeometry,
  sampleEllipseArc,
  type BufferedDetectionTimeline,
  type Detection,
  type DetectionFrame,
  type AnnotationStyleContext,
  type KeypointDrawInstruction,
  type KeypointStyle,
  type MarkerShapeInstruction,
  type OpenStrokeStyle,
  type PolygonDrawInstruction,
  type PolygonStyle,
  type PolylineDrawInstruction,
  type PolylineStyle,
  type ShapeDrawInstruction,
  type ShapeStyle,
} from "supervision-js-core";
import type {
  Container as PixiContainer,
  Graphics as PixiGraphics,
} from "pixi.js";
import { drawPixiPath, resolvePixiStroke } from "./pixi-path";

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
  readonly shapes?: readonly ShapeDrawInstruction[];
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
    shapeStyle?: ShapeStyle | null;
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
  readonly shapeStyle?: ShapeStyle | null;
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
  // Shape decorations are opt-in; no default style exists so configuring
  // nothing keeps the semantic-geometry skip untouched.
  let shapeStyle = options.shapeStyle ?? null;
  let styleVersion = 0;
  let drawnStyleVersion = -1;
  // A versioned source can replace a frame without changing its timeline key.
  // Buffered frames are immutable snapshots, so retain by object identity.
  let lastFrame: DetectionFrame | undefined;
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

      if (
        frame === lastFrame &&
        drawnStyleVersion === styleVersion &&
        viewportScale === lastViewportScale &&
        invalidated.size === 0
      ) {
        return;
      }

      lastFrame = frame;
      drawnStyleVersion = styleVersion;
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
            !detection.keypoints &&
            !shapeStyle
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
      if (styles.shapeStyle !== undefined) shapeStyle = styles.shapeStyle;
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
    const shapes = shapeStyle?.resolve(detection, context);

    if (!polygon && !polyline && !keypoints && !shapes?.length) {
      return undefined;
    }

    return {
      key: detectionKey(detection, detectionIndex),
      keypoints,
      polygon,
      polyline,
      shapes,
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
    const { keypoints, polygon, polyline, shapes } = detection;

    for (const shape of shapes ?? []) {
      drawShapeInstruction(graphics, shape, viewportScale);
    }

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

    if (keypoints)
      drawPixiKeypointInstruction(graphics, keypoints, viewportScale);
  }
}

export function drawPixiKeypointInstruction(
  graphics: PixiGraphics,
  instruction: KeypointDrawInstruction,
  viewportScale: number,
) {
  for (const edge of instruction.edges) {
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

  for (const marker of instruction.markers) {
    if (marker.shape === KeypointMarkerShape.Cross) {
      drawMarkerInstruction(
        graphics,
        {
          center: marker.point,
          kind: ShapeInstructionKind.Marker,
          shape: MarkerShape.Cross,
          size: marker.radius * 2,
          sizeSpace: MarkerSizeSpace.Screen,
          stroke: asOpenStroke(
            marker.stroke ?? { alpha: 1, color: 0xffffff, width: 2 },
          ),
        },
        viewportScale,
      );
    } else {
      drawMarkerInstruction(
        graphics,
        {
          center: marker.point,
          fill: marker.fill,
          kind: ShapeInstructionKind.Marker,
          shape: MarkerShape.Circle,
          size: marker.radius * 2,
          sizeSpace: MarkerSizeSpace.Screen,
          stroke: marker.stroke,
        },
        viewportScale,
      );
    }
  }
}

function drawShapeInstruction(
  graphics: PixiGraphics,
  instruction: ShapeDrawInstruction,
  viewportScale: number,
) {
  if (instruction.kind === ShapeInstructionKind.Ellipse) {
    const { closed, points } = sampleEllipseArc(
      instruction,
      resolveEllipseSegmentCount(instruction, viewportScale),
    );

    if (closed && instruction.fill) {
      graphics.poly(
        points.flatMap(({ x, y }) => [x, y]),
        true,
      );
      graphics.fill(instruction.fill);
    }

    if (instruction.stroke) {
      drawPixiPath(graphics, points, closed, instruction.stroke, viewportScale);
    }

    return;
  }

  if (instruction.kind === ShapeInstructionKind.Marker) {
    drawMarkerInstruction(graphics, instruction, viewportScale);
    return;
  }

  for (const segment of instruction.segments) {
    if (instruction.closed && instruction.fill) {
      graphics.poly(
        segment.flatMap(({ x, y }) => [x, y]),
        true,
      );
      graphics.fill(instruction.fill);
    }

    drawPixiPath(
      graphics,
      segment,
      instruction.closed,
      instruction.stroke,
      viewportScale,
    );
  }
}

function drawMarkerInstruction(
  graphics: PixiGraphics,
  instruction: MarkerShapeInstruction,
  viewportScale: number,
) {
  const geometry = resolveMarkerGeometry(instruction, viewportScale);

  if (geometry.kind === "circle") {
    const dashed = Boolean(instruction.stroke?.dash?.length);

    if (instruction.fill || !dashed) {
      graphics.circle(geometry.center.x, geometry.center.y, geometry.radius);
      if (instruction.fill) graphics.fill(instruction.fill);
    }

    if (instruction.stroke) {
      if (dashed) {
        const ellipse = {
          center: geometry.center,
          radiusX: geometry.radius,
          radiusY: geometry.radius,
        };
        const { points } = sampleEllipseArc(
          ellipse,
          resolveEllipseSegmentCount(ellipse, viewportScale),
        );
        drawPixiPath(graphics, points, true, instruction.stroke, viewportScale);
      } else {
        graphics.stroke(resolvePixiStroke(instruction.stroke, viewportScale));
      }
    }
    return;
  }

  for (const subpath of geometry.subpaths) {
    if (geometry.closed && instruction.fill) {
      graphics.poly(
        subpath.flatMap(({ x, y }) => [x, y]),
        true,
      );
      graphics.fill(instruction.fill);
    }

    if (instruction.stroke) {
      drawPixiPath(
        graphics,
        subpath,
        geometry.closed,
        instruction.stroke,
        viewportScale,
      );
    }
  }
}

function asOpenStroke(
  stroke: MarkerShapeInstruction["stroke"],
): OpenStrokeStyle | undefined {
  if (!stroke) return undefined;
  return {
    alpha: stroke.alpha,
    cap: stroke.cap,
    color: stroke.color,
    dash: stroke.dash,
    join: stroke.join,
    miterLimit: stroke.miterLimit,
    width: stroke.width,
  };
}

function detectionKey(detection: Detection, detectionIndex: number) {
  return detection.id === undefined
    ? `index:${detectionIndex}`
    : `id:${String(detection.id)}`;
}
