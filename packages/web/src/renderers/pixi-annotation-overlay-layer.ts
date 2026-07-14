import {
  AnnotationGestureStateKind,
  getAnnotationHandles,
  getDetectionRect,
  type AnnotationEditingEngine,
  type AnnotationOverlayStyle,
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
  const detection = engine?.getState().preview;
  if (!detection) return;
  const stroke = style.editingPreview.stroke;
  if (detection.rect) {
    const { x, y, width, height } = detection.rect;
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
    graphics
      .poly(
        detection.polygon.points.flatMap(({ x, y }) => [x, y]),
        true,
      )
      .fill(style.editingPreview.polygonFill);
    drawPixiPath(
      graphics,
      detection.polygon.points,
      true,
      stroke,
      viewportScale,
    );
    const state = engine?.getState();
    if (
      state?.kind === AnnotationGestureStateKind.Creating &&
      detection.polygon.points.length >= 4
    ) {
      const first = detection.polygon.points[0]!;
      graphics.circle(first.x, first.y, resolveScreenLength(12, viewportScale));
      graphics.stroke(
        resolvePixiStroke(style.editingPreview.closeZoneStroke, viewportScale),
      );
    }
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

function drawSelectionHandles(
  graphics: PixiGraphics,
  context: Parameters<PixiAnnotationOverlayLayer["draw"]>[0],
  style: ResolvedAnnotationOverlayStyle,
) {
  const selected = new Set(context.selectedDetectionIds);
  for (const detection of context.frame?.detections ?? []) {
    if (detection.id === undefined || !selected.has(detection.id)) continue;
    for (const handle of getAnnotationHandles(
      detection,
      context.viewportScale,
    )) {
      graphics.circle(handle.point.x, handle.point.y, handle.radius);
      graphics.fill({
        ...style.selectionHandle.fill,
        alpha:
          handle.kind === "addVertex"
            ? style.selectionHandle.addVertexAlpha
            : style.selectionHandle.fill.alpha,
      });
      graphics.stroke(
        resolvePixiStroke(style.selectionHandle.stroke, context.viewportScale),
      );
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
    readonly stroke: BoxStrokeStyle;
    readonly polygonFill: BoxFillStyle;
    readonly closeZoneStroke: BoxStrokeStyle;
  };
  readonly selectionHandle: {
    readonly fill: BoxFillStyle;
    readonly stroke: BoxStrokeStyle;
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
