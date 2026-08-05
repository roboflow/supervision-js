import {
  AnnotationGestureStateKind,
  getAnnotationHandles,
  getDetectionRect,
  lightenColor,
  resolveStyleValue,
  type AnnotationEditingEngine,
  type AnnotationEditingPreviewStyleContext,
  type AnnotationOverlayStyle,
  type AnnotationStyleContext,
  type AnnotationVisibility,
  type BoxFillStyle,
  type BoxStrokeStyle,
  type DetectionFrame,
  type Point,
  type PreviewOverlayData,
} from "supervision-js-core";
import type { Graphics as PixiGraphics } from "pixi.js";
import {
  drawPixiPath,
  resolvePixiStroke,
  resolveScreenLength,
} from "./pixi-path";

export interface PixiAnnotationOverlayLayer {
  attachGraphics(graphics: PixiGraphics): void;
  setStyle(style: AnnotationOverlayStyle | null | undefined): void;
  draw(context: {
    frame: DetectionFrame | undefined;
    selectedDetectionIds: readonly (string | number)[];
    pointer: Point | null;
    marquee: { x: number; y: number; width: number; height: number } | null;
    viewportScale: number;
    mediaWidth: number;
    mediaHeight: number;
    visibility?: AnnotationVisibility;
    previewOverlay?: PreviewOverlayData | null;
    now: number;
  }): void;
}

export function createPixiAnnotationOverlayLayer(
  editingEngine?: AnnotationEditingEngine,
  initialStyle?: AnnotationOverlayStyle | null,
): PixiAnnotationOverlayLayer {
  let graphics: PixiGraphics | undefined;
  let style = resolveAnnotationOverlayStyle(initialStyle);

  return {
    attachGraphics(next) {
      graphics = next;
    },
    setStyle(next) {
      if (next !== undefined) style = resolveAnnotationOverlayStyle(next);
    },
    draw(context) {
      if (!graphics) return;
      graphics.clear();
      drawExternalPreview(
        graphics,
        context.previewOverlay,
        context.viewportScale,
        style,
      );
      drawEditingPreview(graphics, editingEngine, context.viewportScale, style);
      drawSelectionHandles(graphics, context, style);
      drawMarquee(graphics, context.marquee, style);
      drawGuides(graphics, editingEngine, context, style);
      drawLoading(graphics, context, style);
    },
  };
}

function drawEditingPreview(
  graphics: PixiGraphics,
  engine: AnnotationEditingEngine | undefined,
  viewportScale: number,
  style: ResolvedAnnotationOverlayStyle,
) {
  const state = engine?.getState();
  const detection = state?.preview;
  if (!detection) return;
  const styleContext: AnnotationEditingPreviewStyleContext = {
    gestureKind: state.kind,
    viewportScale,
  };
  const stroke = resolveStyleValue(
    style.editingPreview.stroke,
    detection,
    styleContext,
  )!;
  const boxFill = resolveStyleValue(
    style.editingPreview.boxFill,
    detection,
    styleContext,
  )!;
  const polygonFill = resolveStyleValue(
    style.editingPreview.polygonFill,
    detection,
    styleContext,
  )!;
  const closeZoneStroke = resolveStyleValue(
    style.editingPreview.closeZoneStroke,
    detection,
    styleContext,
  )!;
  if (
    detection.rect &&
    !detection.mask &&
    !detection.polygon &&
    !detection.polyline
  ) {
    const { x, y, width, height } = detection.rect;
    if (state.kind === AnnotationGestureStateKind.Creating) {
      graphics
        .roundRect(
          x - width / 2,
          y - height / 2,
          width,
          height,
          resolveScreenLength(1, viewportScale),
        )
        .fill(boxFill);
    }
    drawPixiPath(
      graphics,
      [
        { x: x - width / 2, y: y - height / 2 },
        { x: x + width / 2, y: y - height / 2 },
        { x: x + width / 2, y: y + height / 2 },
        { x: x - width / 2, y: y + height / 2 },
      ],
      true,
      stroke,
      viewportScale,
    );
  }
  if (detection.polygon) {
    if (state.kind === AnnotationGestureStateKind.Creating) {
      drawCreatingPolygon(
        graphics,
        detection.polygon.points,
        viewportScale,
        stroke,
        closeZoneStroke,
      );
      return;
    }
    graphics
      .poly(
        detection.polygon.points.flatMap(({ x, y }) => [x, y]),
        true,
      )
      .fill(polygonFill);
    drawPixiPath(
      graphics,
      detection.polygon.points,
      true,
      stroke,
      viewportScale,
    );
  }
  if (detection.polyline)
    drawPixiPath(
      graphics,
      detection.polyline.points,
      false,
      stroke,
      viewportScale,
    );
}

const CREATION_VERTEX_RADIUS = 6;
const CREATION_VERTEX_STROKE_WIDTH = 1.5;
const CREATION_CLOSE_ZONE_RADIUS = 8;
const CREATION_CLOSE_DOT_RADIUS = 6;
const CREATION_CLOSE_COLOR_MIN_DISTANCE = 100;

/**
 * Render a multi-click polygon as an open, progressive gesture. The editing
 * engine stores the live cursor as the final point, while every preceding
 * point is a committed vertex in the current gesture.
 */
function drawCreatingPolygon(
  graphics: PixiGraphics,
  points: readonly Point[],
  viewportScale: number,
  stroke: BoxStrokeStyle,
  closeZoneStroke: BoxStrokeStyle,
) {
  if (points.length < 2) return;

  const placed = points.slice(0, -1);
  const cursor = points.at(-1)!;
  const first = placed[0]!;
  const last = placed.at(-1)!;
  const nearClose =
    placed.length >= 3 &&
    Math.hypot(cursor.x - first.x, cursor.y - first.y) * viewportScale <=
      CREATION_CLOSE_ZONE_RADIUS;

  drawPixiPath(graphics, placed, false, stroke, viewportScale);

  if (nearClose) {
    drawPixiPath(
      graphics,
      [last, first],
      false,
      {
        ...closeZoneStroke,
        color: resolveCloseHighlightColor(stroke.color, closeZoneStroke.color),
        width: stroke.width * 1.5,
      },
      viewportScale,
    );
  } else {
    const ghostStroke: BoxStrokeStyle = {
      ...stroke,
      alpha: stroke.alpha * 0.6,
      dash: [6, 4],
      width: stroke.width * 0.8,
    };
    drawPixiPath(graphics, [last, cursor], false, ghostStroke, viewportScale);
    if (placed.length >= 3) {
      drawPixiPath(
        graphics,
        [cursor, first],
        false,
        ghostStroke,
        viewportScale,
      );
    }
  }

  const vertexFill = {
    alpha: stroke.alpha,
    color: lightenColor(stroke.color, 0.5),
  };
  const vertexStroke = resolvePixiStroke(
    {
      alpha: stroke.alpha,
      color: stroke.color,
      width: CREATION_VERTEX_STROKE_WIDTH,
    },
    viewportScale,
  );
  for (const [index, point] of placed.entries()) {
    if (nearClose && index === 0) continue;
    graphics
      .circle(
        point.x,
        point.y,
        resolveScreenLength(CREATION_VERTEX_RADIUS, viewportScale),
      )
      .fill(vertexFill)
      .stroke(vertexStroke);
  }

  if (placed.length < 3) return;
  const closeRadius = resolveScreenLength(
    CREATION_CLOSE_ZONE_RADIUS,
    viewportScale,
  );
  if (!nearClose) {
    graphics
      .circle(first.x, first.y, closeRadius)
      .stroke(
        resolvePixiStroke(
          { ...stroke, alpha: stroke.alpha * 0.5, width: stroke.width * 0.5 },
          viewportScale,
        ),
      );
    return;
  }

  const highlightColor = resolveCloseHighlightColor(
    stroke.color,
    closeZoneStroke.color,
  );
  graphics
    .circle(first.x, first.y, closeRadius)
    .fill({ alpha: 0.2, color: highlightColor })
    .stroke(
      resolvePixiStroke(
        {
          ...closeZoneStroke,
          color: highlightColor,
          width: stroke.width,
        },
        viewportScale,
      ),
    );
  graphics
    .circle(
      first.x,
      first.y,
      resolveScreenLength(CREATION_CLOSE_DOT_RADIUS, viewportScale),
    )
    .fill({ alpha: 1, color: highlightColor });
}

function resolveCloseHighlightColor(
  creationColor: number,
  preferredHighlight: number,
) {
  const red =
    ((creationColor >> 16) & 0xff) - ((preferredHighlight >> 16) & 0xff);
  const green =
    ((creationColor >> 8) & 0xff) - ((preferredHighlight >> 8) & 0xff);
  const blue = (creationColor & 0xff) - (preferredHighlight & 0xff);
  return Math.hypot(red, green, blue) >= CREATION_CLOSE_COLOR_MIN_DISTANCE
    ? preferredHighlight
    : 0xffffff;
}

function drawSelectionHandles(
  graphics: PixiGraphics,
  context: Parameters<PixiAnnotationOverlayLayer["draw"]>[0],
  style: ResolvedAnnotationOverlayStyle,
) {
  const selected = new Set(context.selectedDetectionIds);
  for (const [detectionIndex, detection] of (
    context.frame?.detections ?? []
  ).entries()) {
    if (detection.id === undefined || !selected.has(detection.id)) continue;
    const styleContext: AnnotationStyleContext = {
      detectionIndex,
      frame: context.frame!,
      mediaTime: context.frame!.mediaTime,
      selected: true,
      viewportScale: context.viewportScale,
    };
    const fill = resolveStyleValue(
      style.selectionHandle.fill,
      detection,
      styleContext,
    ) ?? { alpha: 1, color: 0xffffff };
    const stroke = resolveStyleValue(
      style.selectionHandle.stroke,
      detection,
      styleContext,
    ) ?? { alpha: 1, color: 0x2563eb, width: 2 };
    for (const handle of getAnnotationHandles(
      detection,
      context.viewportScale,
    )) {
      graphics.circle(handle.point.x, handle.point.y, handle.radius);
      graphics.fill({
        ...fill,
        alpha:
          handle.kind === "addVertex"
            ? style.selectionHandle.addVertexAlpha
            : fill.alpha,
      });
      graphics.stroke(resolvePixiStroke(stroke, context.viewportScale));
    }
  }
}

function drawMarquee(
  graphics: PixiGraphics,
  marquee: { x: number; y: number; width: number; height: number } | null,
  style: ResolvedAnnotationOverlayStyle,
) {
  if (!marquee) return;
  graphics.rect(marquee.x, marquee.y, marquee.width, marquee.height);
  graphics.fill(style.marquee.fill);
}

function drawGuides(
  graphics: PixiGraphics,
  engine: AnnotationEditingEngine | undefined,
  context: Parameters<PixiAnnotationOverlayLayer["draw"]>[0],
  style: ResolvedAnnotationOverlayStyle,
) {
  if (!engine?.hasCreationTool() || !context.pointer || !context.frame) return;
  for (const stroke of [style.guide.shadowStroke, style.guide.stroke]) {
    drawPixiPath(
      graphics,
      [
        { x: 0, y: context.pointer.y },
        { x: context.mediaWidth, y: context.pointer.y },
      ],
      false,
      stroke,
      context.viewportScale,
    );
    drawPixiPath(
      graphics,
      [
        { x: context.pointer.x, y: 0 },
        { x: context.pointer.x, y: context.mediaHeight },
      ],
      false,
      stroke,
      context.viewportScale,
    );
  }
}

function drawExternalPreview(
  graphics: PixiGraphics,
  preview: PreviewOverlayData | null | undefined,
  viewportScale: number,
  style: ResolvedAnnotationOverlayStyle,
) {
  if (!preview) return;
  for (const points of preview.hoverPolygons ?? []) {
    graphics
      .poly(
        points.flatMap(({ x, y }) => [x, y]),
        true,
      )
      .fill(style.externalPreview.hoverFill);
    drawPixiPath(
      graphics,
      points,
      true,
      style.externalPreview.hoverStroke,
      viewportScale,
    );
  }
  for (const points of preview.draftPolygons ?? []) {
    graphics
      .poly(
        points.flatMap(({ x, y }) => [x, y]),
        true,
      )
      .fill(style.externalPreview.draftFill);
    drawPixiPath(
      graphics,
      points,
      true,
      style.externalPreview.draftStroke,
      viewportScale,
    );
  }
  for (const point of preview.points ?? []) {
    const radius = resolveScreenLength(5, viewportScale);
    graphics
      .circle(point.x, point.y, radius)
      .fill(
        point.positive
          ? style.externalPreview.positivePointFill
          : style.externalPreview.negativePointFill,
      );
    graphics.stroke(
      resolvePixiStroke(style.externalPreview.pointStroke, viewportScale),
    );
  }
}

function drawLoading(
  graphics: PixiGraphics,
  context: Parameters<PixiAnnotationOverlayLayer["draw"]>[0],
  style: ResolvedAnnotationOverlayStyle,
) {
  const values = context.visibility?.loadingDetectionIds;
  if (!values) return;
  const loading = values instanceof Set ? values : new Set(values);
  const angle = (context.now / 500) % (Math.PI * 2);
  for (const detection of context.frame?.detections ?? []) {
    if (detection.id === undefined || !loading.has(detection.id)) continue;
    const rect = getDetectionRect(detection);
    if (!rect) continue;
    graphics.arc(
      rect.x,
      rect.y,
      resolveScreenLength(10, context.viewportScale),
      angle,
      angle + Math.PI * 1.5,
    );
    const stroke = resolvePixiStroke(
      style.loading.stroke,
      context.viewportScale,
    );
    graphics.stroke({
      ...stroke,
      alpha: stroke.alpha * (0.5 + Math.sin(angle) * 0.25),
    });
  }
}

interface ResolvedAnnotationOverlayStyle {
  readonly editingPreview: {
    readonly stroke: NonNullable<
      NonNullable<AnnotationOverlayStyle["editingPreview"]>["stroke"]
    >;
    readonly boxFill: NonNullable<
      NonNullable<AnnotationOverlayStyle["editingPreview"]>["boxFill"]
    >;
    readonly polygonFill: NonNullable<
      NonNullable<AnnotationOverlayStyle["editingPreview"]>["polygonFill"]
    >;
    readonly closeZoneStroke: NonNullable<
      NonNullable<AnnotationOverlayStyle["editingPreview"]>["closeZoneStroke"]
    >;
  };
  readonly selectionHandle: {
    readonly fill: NonNullable<
      NonNullable<AnnotationOverlayStyle["selectionHandle"]>["fill"]
    >;
    readonly stroke: NonNullable<
      NonNullable<AnnotationOverlayStyle["selectionHandle"]>["stroke"]
    >;
    readonly addVertexAlpha: number;
  };
  readonly marquee: { readonly fill: BoxFillStyle };
  readonly guide: {
    readonly stroke: BoxStrokeStyle;
    readonly shadowStroke: BoxStrokeStyle;
  };
  readonly externalPreview: {
    readonly hoverFill: BoxFillStyle;
    readonly hoverStroke: BoxStrokeStyle;
    readonly draftFill: BoxFillStyle;
    readonly draftStroke: BoxStrokeStyle;
    readonly positivePointFill: BoxFillStyle;
    readonly negativePointFill: BoxFillStyle;
    readonly pointStroke: BoxStrokeStyle;
  };
  readonly loading: { readonly stroke: BoxStrokeStyle };
}

const DEFAULT_ANNOTATION_OVERLAY_STYLE: ResolvedAnnotationOverlayStyle = {
  editingPreview: {
    stroke: { alpha: 1, color: 0x00ff66, width: 2 },
    boxFill: { alpha: 0.08, color: 0x00ff66 },
    polygonFill: { alpha: 0.16, color: 0x22c55e },
    closeZoneStroke: { alpha: 1, color: 0x22c55e, width: 2 },
  },
  selectionHandle: {
    fill: { alpha: 1, color: 0xffffff },
    stroke: { alpha: 1, color: 0x2563eb, width: 2 },
    addVertexAlpha: 0.55,
  },
  marquee: { fill: { alpha: 0.2, color: 0x3b82f6 } },
  guide: {
    stroke: { alpha: 1, color: 0xffffff, dash: [6, 4], width: 1 },
    shadowStroke: { alpha: 0.75, color: 0x000000, dash: [6, 4], width: 3 },
  },
  externalPreview: {
    hoverFill: { alpha: 0.12, color: 0x60a5fa },
    hoverStroke: { alpha: 0.8, color: 0x60a5fa, width: 2 },
    draftFill: { alpha: 0.2, color: 0x22c55e },
    draftStroke: { alpha: 1, color: 0x22c55e, width: 2 },
    positivePointFill: { alpha: 1, color: 0x22c55e },
    negativePointFill: { alpha: 1, color: 0xef4444 },
    pointStroke: { alpha: 1, color: 0xffffff, width: 2 },
  },
  loading: { stroke: { alpha: 1, color: 0xffffff, width: 2 } },
};

function resolveAnnotationOverlayStyle(
  style: AnnotationOverlayStyle | null | undefined,
): ResolvedAnnotationOverlayStyle {
  return {
    editingPreview: {
      ...DEFAULT_ANNOTATION_OVERLAY_STYLE.editingPreview,
      ...style?.editingPreview,
    },
    selectionHandle: {
      ...DEFAULT_ANNOTATION_OVERLAY_STYLE.selectionHandle,
      ...style?.selectionHandle,
    },
    marquee: {
      ...DEFAULT_ANNOTATION_OVERLAY_STYLE.marquee,
      ...style?.marquee,
    },
    guide: {
      ...DEFAULT_ANNOTATION_OVERLAY_STYLE.guide,
      ...style?.guide,
    },
    externalPreview: {
      ...DEFAULT_ANNOTATION_OVERLAY_STYLE.externalPreview,
      ...style?.externalPreview,
    },
    loading: {
      ...DEFAULT_ANNOTATION_OVERLAY_STYLE.loading,
      ...style?.loading,
    },
  };
}
