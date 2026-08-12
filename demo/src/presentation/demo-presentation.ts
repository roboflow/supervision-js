import {
  BoxStrokeAlignment,
  BoxShape,
  BaseFocusStyle,
  BaseInteractionStyle,
  BaseKeypointStyle,
  BaseLabelStyle,
  BasePolygonStyle,
  BasePolylineStyle,
  DEFAULT_DETECTION_CLASS_STYLES,
  DetectionInteractionState,
  type DetectionClassColorStyle,
  FocusTargetMode,
  LabelPlacement,
  MarkerShape,
  MarkerSizeSpace,
  MaskRenderMode,
  ShapeInstructionKind,
  type BoxDrawInstruction,
  type BoxStyle,
  type BoxStyleContext,
  type Detection,
  type FocusStyle,
  type InteractionStyle,
  type KeypointStyle,
  type KeypointStyleContext,
  type LabelStyle,
  type MaskDrawInstruction,
  type MaskStyle,
  type MediaRendererPresentation,
  type PolygonStyle,
  type PolylineStyle,
  type Rect,
  type ShapeDrawInstruction,
  type ShapeStyle,
  type ShapeStyleContext,
  resolveDetectionClassColorStyle,
} from "supervision";

export type DemoClassStyle = DetectionClassColorStyle;

/**
 * Box-layer annotator variants mirroring the Python Supervision catalog.
 * Every variant lowers to the existing renderer-neutral `BoxDrawInstruction`;
 * no new renderer primitives are involved.
 */
export enum DemoBoxAnnotator {
  Box = "box",
  RoundBox = "roundBox",
  BoxCorner = "boxCorner",
  Circle = "circle",
  Color = "color",
}

/**
 * Marker-layer annotators anchored on the detection box, rendered through
 * the shape decoration slot so they compose with any box annotator.
 */
export enum DemoMarkerAnnotator {
  Dot = "dot",
  Triangle = "triangle",
  Ellipse = "ellipse",
  PercentageBar = "percentageBar",
}

/**
 * Keypoint-layer annotator variants mirroring the Python Supervision
 * vertex/edge annotators.
 */
export enum DemoKeypointAnnotator {
  VerticesAndEdges = "verticesAndEdges",
  Vertices = "vertices",
  Edges = "edges",
}

export interface DemoPresentationSettings {
  readonly boxesEnabled: boolean;
  readonly focusEnabled: boolean;
  readonly keypointsEnabled: boolean;
  readonly labelsEnabled: boolean;
  readonly masksEnabled: boolean;
  readonly polygonsEnabled: boolean;
  readonly polylinesEnabled: boolean;
  readonly boxAnnotator: DemoBoxAnnotator;
  readonly boxColorFillAlpha: number;
  readonly boxCornerLength: number;
  readonly boxCornerRadius: number;
  readonly boxStrokeWidth: number;
  readonly markersEnabled: boolean;
  readonly markerAnnotator: DemoMarkerAnnotator;
  readonly markerBarHeight: number;
  readonly markerDotRadius: number;
  readonly markerStrokeWidth: number;
  readonly markerTriangleSize: number;
  readonly boxStrokeAlignment: BoxStrokeAlignment;
  readonly boxFillAlpha: number;
  readonly classStyles: Record<string, DemoClassStyle>;
  readonly labelBackgroundAlpha: number;
  readonly labelCornerRadius: number;
  readonly labelFontSize: number;
  readonly labelIncludeConfidence: boolean;
  readonly labelShowClass: boolean;
  readonly labelShowId: boolean;
  readonly labelOffsetX: number;
  readonly labelOffsetY: number;
  readonly labelPaddingX: number;
  readonly labelPaddingY: number;
  readonly labelPlacement: LabelPlacement;
  readonly maskMode: MaskRenderMode;
  readonly maskFillAlpha: number;
  readonly maskOpacity: number;
  readonly maskStrokeAlpha: number;
  readonly maskStrokeWidth: number;
  readonly polygonFillAlpha: number;
  readonly polygonStrokeWidth: number;
  readonly polylineStrokeWidth: number;
  readonly keypointAnnotator: DemoKeypointAnnotator;
  readonly keypointRadius: number;
  readonly keypointEdgeWidth: number;
  readonly confidenceThreshold: number;
  readonly hiddenClasses: readonly string[];
  readonly interactionHoverFillAlpha: number;
  readonly interactionHoverStrokeWidth: number;
  readonly interactionSelectedFillAlpha: number;
  readonly interactionSelectedStrokeWidth: number;
  readonly focusCornerRadius: number;
  readonly focusDimColor: number;
  readonly focusDimAlpha: number;
  readonly focusTargetMode: FocusTargetMode;
}

export type DemoPresentationLayerSetting =
  | "boxesEnabled"
  | "focusEnabled"
  | "keypointsEnabled"
  | "labelsEnabled"
  | "markersEnabled"
  | "masksEnabled"
  | "polygonsEnabled"
  | "polylinesEnabled";

export type DemoPresentationAvailability = Partial<
  Record<DemoPresentationLayerSetting, boolean>
>;

const demoPresentationLayerSettings: readonly DemoPresentationLayerSetting[] = [
  "boxesEnabled",
  "focusEnabled",
  "keypointsEnabled",
  "labelsEnabled",
  "markersEnabled",
  "masksEnabled",
  "polygonsEnabled",
  "polylinesEnabled",
];

export function constrainDemoPresentationSettings(
  settings: DemoPresentationSettings,
  availability?: DemoPresentationAvailability,
): DemoPresentationSettings {
  if (!availability) return settings;

  const constrained = { ...settings };

  for (const key of demoPresentationLayerSettings) {
    if (availability[key] === false) constrained[key] = false;
  }

  return constrained;
}

export const defaultDemoClassNames = ["person", "horse", "cow"];

const defaultDemoClassStyles: Record<string, DemoClassStyle> = {
  basketball: createCanonicalDemoClassStyle(
    DEFAULT_DETECTION_CLASS_STYLES.basketball,
  ),
  cow: createCanonicalDemoClassStyle(DEFAULT_DETECTION_CLASS_STYLES.cow),
  horse: createCanonicalDemoClassStyle(DEFAULT_DETECTION_CLASS_STYLES.horse),
  person: createCanonicalDemoClassStyle(DEFAULT_DETECTION_CLASS_STYLES.person),
  "white team player": createCanonicalDemoClassStyle(
    DEFAULT_DETECTION_CLASS_STYLES["white team player"],
  ),
  "yellow team player": createCanonicalDemoClassStyle(
    DEFAULT_DETECTION_CLASS_STYLES["yellow team player"],
  ),
};

export const defaultDemoPresentationSettings: DemoPresentationSettings = {
  boxAnnotator: DemoBoxAnnotator.Box,
  boxColorFillAlpha: 0.5,
  boxCornerLength: 15,
  boxCornerRadius: 1,
  boxesEnabled: true,
  boxFillAlpha: 0.08,
  boxStrokeAlignment: BoxStrokeAlignment.Center,
  boxStrokeWidth: 2,
  classStyles: defaultDemoClassStyles,
  confidenceThreshold: 0,
  focusCornerRadius: 1,
  focusDimAlpha: 0.4,
  focusDimColor: 0x000000,
  focusEnabled: true,
  focusTargetMode: FocusTargetMode.Ambient,
  hiddenClasses: [],
  interactionHoverFillAlpha: 0.08,
  interactionHoverStrokeWidth: 2,
  interactionSelectedFillAlpha: 0.22,
  interactionSelectedStrokeWidth: 3.5,
  keypointAnnotator: DemoKeypointAnnotator.VerticesAndEdges,
  keypointEdgeWidth: 1.5,
  keypointRadius: 3.5,
  keypointsEnabled: true,
  labelBackgroundAlpha: 1,
  labelCornerRadius: 4,
  labelFontSize: 12,
  labelIncludeConfidence: false,
  labelShowClass: true,
  labelShowId: false,
  labelOffsetX: 0,
  labelOffsetY: 0,
  labelPaddingX: 6,
  labelPaddingY: 3,
  labelPlacement: LabelPlacement.Top,
  labelsEnabled: true,
  markerAnnotator: DemoMarkerAnnotator.Dot,
  markerBarHeight: 8,
  markerDotRadius: 5,
  markersEnabled: false,
  markerStrokeWidth: 2,
  markerTriangleSize: 14,
  maskMode: MaskRenderMode.FillAndStroke,
  maskFillAlpha: 0.45,
  maskOpacity: 1,
  maskStrokeAlpha: 1,
  maskStrokeWidth: 2,
  masksEnabled: true,
  polygonFillAlpha: 0.08,
  polygonStrokeWidth: 2,
  polygonsEnabled: true,
  polylineStrokeWidth: 2,
  polylinesEnabled: true,
};

export function createDemoPresentation(
  settings: DemoPresentationSettings,
): MediaRendererPresentation {
  const boxStyle = settings.boxesEnabled ? createDemoBoxStyle(settings) : null;
  const keypointStyle = settings.keypointsEnabled
    ? createDemoKeypointStyle(settings)
    : null;
  const labelStyle = settings.labelsEnabled
    ? createDemoLabelStyle(settings)
    : null;
  const maskStyle = settings.masksEnabled
    ? createDemoMaskStyle(settings)
    : null;
  const polygonStyle = settings.polygonsEnabled
    ? createDemoPolygonStyle(settings)
    : null;
  const polylineStyle = settings.polylinesEnabled
    ? createDemoPolylineStyle(settings)
    : null;

  return {
    // The demo uses contain-fit media, so this colour is visible in the
    // letterbox around non-matching aspect ratios.
    backgroundColor: 0xf3f4f6,
    boxStyle,
    // Class visibility rides the renderer-owned visibility contract so every
    // layer and the prepared-mask cache invalidate consistently.
    visibility: { hiddenClasses: settings.hiddenClasses },
    focusStyle: settings.focusEnabled ? createDemoFocusStyle(settings) : null,
    interactionStyle: createDemoInteractionStyle(settings),
    keypointStyle: settings.keypointsEnabled
      ? createDemoKeypointStyle(settings)
      : null,
    labelStyle: settings.labelsEnabled ? createDemoLabelStyle(settings) : null,
    maskStyle: settings.masksEnabled ? createDemoMaskStyle(settings) : null,
    polygonStyle: settings.polygonsEnabled
      ? createDemoPolygonStyle(settings)
      : null,
    polylineStyle: settings.polylinesEnabled
      ? createDemoPolylineStyle(settings)
      : null,
    shapeStyle: settings.markersEnabled ? createDemoShapeStyle(settings) : null,
  };
}

// Python's EllipseAnnotator draws an open arc from -45 to 235 degrees.
const ELLIPSE_ARC_START = -Math.PI / 4;
const ELLIPSE_ARC_END = (235 * Math.PI) / 180;

function createDemoShapeStyle(settings: DemoPresentationSettings): ShapeStyle {
  return {
    resolve(
      detection: Detection,
      context: ShapeStyleContext,
    ): readonly ShapeDrawInstruction[] | undefined {
      if (!detection.rect || !passesDetectionFilters(detection, settings)) {
        return undefined;
      }

      const rect = detection.rect;
      const style = resolveClassStyle(detection, settings);
      const scale = Math.max(context.viewportScale ?? 1, Number.EPSILON);

      switch (settings.markerAnnotator) {
        case DemoMarkerAnnotator.Ellipse:
          return [
            {
              center: { x: rect.x, y: rect.y + rect.height / 2 },
              endAngle: ELLIPSE_ARC_END,
              kind: ShapeInstructionKind.Ellipse,
              radiusX: rect.width / 2,
              radiusY: (rect.width * 0.35) / 2,
              startAngle: ELLIPSE_ARC_START,
              stroke: {
                alpha: 1,
                color: style.stroke,
                width: settings.markerStrokeWidth,
              },
            },
          ];
        case DemoMarkerAnnotator.Triangle: {
          // Anchored above the box, tip touching the top edge.
          const mediaSize = settings.markerTriangleSize / scale;

          return [
            {
              fill: { alpha: 1, color: style.fill },
              kind: ShapeInstructionKind.Marker,
              point: { x: rect.x, y: rect.y - rect.height / 2 - mediaSize / 2 },
              shape: MarkerShape.Triangle,
              size: settings.markerTriangleSize,
              sizeSpace: MarkerSizeSpace.Screen,
              stroke: { alpha: 1, color: 0xffffff, width: 1 },
            },
          ];
        }
        case DemoMarkerAnnotator.PercentageBar: {
          // Confidence bar above the box: background track plus a filled
          // portion proportional to the detection confidence.
          const barHeight = settings.markerBarHeight / scale;
          const gap = 4 / scale;
          const top = rect.y - rect.height / 2 - gap - barHeight;
          const left = rect.x - rect.width / 2;
          const value = Math.min(Math.max(detection.confidence ?? 1, 0), 1);
          const trackRect = barRect(left, top, rect.width, barHeight);
          const valueRect = barRect(left, top, rect.width * value, barHeight);

          return [
            {
              closed: true,
              fill: { alpha: 0.55, color: 0x111111 },
              kind: ShapeInstructionKind.Path,
              segments: [trackRect],
              stroke: { alpha: 1, color: 0xffffff, width: 1 },
            },
            {
              closed: true,
              fill: { alpha: 1, color: style.fill },
              kind: ShapeInstructionKind.Path,
              segments: [valueRect],
              stroke: { alpha: 0, color: style.fill, width: 0.001 },
            },
          ];
        }
        default:
          // Dot: a filled circle marker at the box center.
          return [
            {
              fill: { alpha: 1, color: style.fill },
              kind: ShapeInstructionKind.Marker,
              point: { x: rect.x, y: rect.y },
              shape: MarkerShape.Circle,
              size: settings.markerDotRadius * 2,
              sizeSpace: MarkerSizeSpace.Screen,
              stroke: { alpha: 1, color: 0xffffff, width: 1 },
            },
          ];
      }
    },
  };
}

function barRect(
  left: number,
  top: number,
  width: number,
  height: number,
): readonly { x: number; y: number }[] {
  return [
    { x: left, y: top },
    { x: left + width, y: top },
    { x: left + width, y: top + height },
    { x: left, y: top + height },
  ];
}

function createDemoPolygonStyle(
  settings: DemoPresentationSettings,
): PolygonStyle {
  return new BasePolygonStyle({
    fill: (detection) => ({
      alpha: settings.polygonFillAlpha,
      color: resolveClassStyle(detection, settings).fill,
    }),
    shouldRender: (detection) => passesDetectionFilters(detection, settings),
    stroke: (detection) => ({
      alpha: 1,
      color: resolveClassStyle(detection, settings).stroke,
      width: settings.polygonStrokeWidth,
    }),
  });
}

function createDemoPolylineStyle(
  settings: DemoPresentationSettings,
): PolylineStyle {
  return new BasePolylineStyle({
    shouldRender: (detection) => passesDetectionFilters(detection, settings),
    stroke: (detection) => ({
      alpha: 1,
      color: resolveClassStyle(detection, settings).stroke,
      width: settings.polylineStrokeWidth,
    }),
  });
}

function createDemoKeypointStyle(
  settings: DemoPresentationSettings,
): KeypointStyle {
  return applyDemoKeypointAnnotator(
    new BaseKeypointStyle({
      edgeShadowStroke: {
        alpha: 0.25,
        color: 0x000000,
        width: 3,
      },
      edgeStroke: (detection) => ({
        alpha: 1,
        color: resolveClassStyle(detection, settings).stroke,
        width: settings.keypointEdgeWidth,
      }),
      markerFill: (detection) => ({
        alpha: 1,
        color: resolveClassStyle(detection, settings).fill,
      }),
      markerStroke: () => ({
        alpha: 1,
        color: 0xffffff,
        width: 1,
      }),
      radius: settings.keypointRadius,
      shouldRender: (detection) => passesDetectionFilters(detection, settings),
    }),
    settings,
  );
}

/**
 * Restricts a keypoint style to the selected annotator variant by stripping
 * markers or edges from the resolved instruction, mirroring the Python
 * vertex/edge annotator split without new renderer work.
 */
function applyDemoKeypointAnnotator(
  style: KeypointStyle,
  settings: DemoPresentationSettings,
): KeypointStyle {
  if (settings.keypointAnnotator === DemoKeypointAnnotator.VerticesAndEdges) {
    return style;
  }

  return {
    resolve(detection: Detection, context: KeypointStyleContext) {
      const instruction = style.resolve(detection, context);

      if (!instruction) {
        return undefined;
      }

      return settings.keypointAnnotator === DemoKeypointAnnotator.Vertices
        ? { ...instruction, edges: [] }
        : { ...instruction, markers: [] };
    },
  };
}

function createDemoBoxStyle(settings: DemoPresentationSettings): BoxStyle {
  return {
    resolve(
      detection: Detection,
      context: BoxStyleContext,
    ): BoxDrawInstruction | undefined {
      if (!detection.rect || !passesDetectionFilters(detection, settings)) {
        return undefined;
      }

      return resolveDemoBoxInstruction(
        detection.rect,
        settings,
        resolveClassStyle(detection, settings),
        context,
      );
    },
  };
}

interface DemoBoxEmphasis {
  readonly fillAlpha: number;
  readonly strokeWidth: number;
}

/**
 * Lowers the selected box annotator variant to a renderer-neutral
 * `BoxDrawInstruction`. Circle and dot reuse the rounded-rectangle shape with
 * a full corner radius; box corners reuse the dashed stroke with a
 * per-detection pattern, so every variant stays on existing primitives.
 */
function resolveDemoBoxInstruction(
  rect: Rect,
  settings: DemoPresentationSettings,
  style: DemoClassStyle,
  context: BoxStyleContext,
  emphasis?: DemoBoxEmphasis,
): BoxDrawInstruction {
  const fillAlpha = emphasis?.fillAlpha ?? settings.boxFillAlpha;
  const strokeWidth = emphasis?.strokeWidth ?? settings.boxStrokeWidth;
  const stroke = {
    ...(settings.boxStrokeAlignment === BoxStrokeAlignment.Center
      ? {}
      : { alignment: settings.boxStrokeAlignment }),
    alpha: 1,
    color: style.stroke,
    width: strokeWidth,
  };

  switch (settings.boxAnnotator) {
    case DemoBoxAnnotator.Color:
      return {
        fill: {
          alpha: emphasis?.fillAlpha ?? settings.boxColorFillAlpha,
          color: style.fill,
        },
        rect,
        shape: BoxShape.Rect,
      };
    case DemoBoxAnnotator.Circle: {
      const side = Math.hypot(rect.width, rect.height);

      return {
        cornerRadius: side / 2,
        fill: { alpha: fillAlpha, color: style.fill },
        rect: { height: side, width: side, x: rect.x, y: rect.y },
        shape: BoxShape.RoundedRect,
        stroke,
      };
    }
    case DemoBoxAnnotator.BoxCorner: {
      const scale = Math.max(context.viewportScale ?? 1, Number.EPSILON);
      const screenWidth = rect.width * scale;
      const screenHeight = rect.height * scale;
      const arm = Math.min(
        settings.boxCornerLength,
        screenWidth / 2,
        screenHeight / 2,
      );
      const horizontalGap = screenWidth - 2 * arm;
      const verticalGap = screenHeight - 2 * arm;
      const cornerStroke = {
        alpha: 1,
        color: style.stroke,
        width: strokeWidth,
      };

      // Arms meet in the middle of an edge: a solid border is the honest
      // rendering for boxes this small on screen.
      if (horizontalGap <= 1 || verticalGap <= 1) {
        return { rect, shape: BoxShape.Rect, stroke: cornerStroke };
      }

      // Dash pattern in screen pixels, clockwise from the top-left vertex:
      // half of the first corner, an edge gap, then two arms across each
      // remaining vertex, closing with the first corner's other half.
      return {
        rect,
        shape: BoxShape.Rect,
        stroke: {
          ...cornerStroke,
          dash: [
            arm,
            horizontalGap,
            2 * arm,
            verticalGap,
            2 * arm,
            horizontalGap,
            2 * arm,
            verticalGap,
            arm,
          ],
        },
      };
    }
    case DemoBoxAnnotator.RoundBox:
      return {
        cornerRadius: settings.boxCornerRadius,
        fill: { alpha: fillAlpha, color: style.fill },
        rect,
        shape: BoxShape.RoundedRect,
        stroke,
      };
    default: {
      // The plain box keeps the canonical radius-driven shape so the default
      // demo presentation stays identical to the Core annotation presentation.
      const shape = resolveBoxShape(settings.boxCornerRadius);

      return {
        cornerRadius:
          shape === BoxShape.RoundedRect ? settings.boxCornerRadius : undefined,
        fill: { alpha: fillAlpha, color: style.fill },
        rect,
        shape,
        stroke,
      };
    }
  }
}

function createDemoFocusStyle(settings: DemoPresentationSettings): FocusStyle {
  const baseStyle = new BaseFocusStyle({
    cornerRadius: settings.focusCornerRadius,
    fill: {
      alpha: settings.focusDimAlpha,
      color: settings.focusDimColor,
    },
    shape: resolveBoxShape(settings.focusCornerRadius),
    shouldRender: (context) =>
      settings.focusTargetMode === FocusTargetMode.Ambient ||
      hasRenderableFocusTarget(context, settings),
    targetMode: settings.focusTargetMode,
  });

  return {
    resolve(context) {
      const contextWithVisiblePicks =
        settings.focusTargetMode === FocusTargetMode.Ambient
          ? {
              ...context,
              hoveredPick:
                context.hoveredPick &&
                passesDetectionFilters(context.hoveredPick.detection, settings)
                  ? context.hoveredPick
                  : null,
              selectedPick:
                context.selectedPick &&
                passesDetectionFilters(context.selectedPick.detection, settings)
                  ? context.selectedPick
                  : null,
            }
          : context;
      const instruction = baseStyle.resolve(contextWithVisiblePicks);

      if (!instruction) {
        return undefined;
      }

      const targets = instruction.targets.filter((target) =>
        passesDetectionFilters(target.detection, settings),
      );

      return targets.length === 0 ? undefined : { ...instruction, targets };
    },
  };
}

function hasRenderableFocusTarget(
  context: Parameters<BaseFocusStyle["resolve"]>[0],
  settings: DemoPresentationSettings,
) {
  const picks = [];

  if (
    (settings.focusTargetMode === FocusTargetMode.Selected ||
      settings.focusTargetMode === FocusTargetMode.HoveredAndSelected) &&
    context.selectedPick
  ) {
    picks.push(context.selectedPick);
  }

  if (
    (settings.focusTargetMode === FocusTargetMode.Hovered ||
      settings.focusTargetMode === FocusTargetMode.HoveredAndSelected) &&
    context.hoveredPick
  ) {
    picks.push(context.hoveredPick);
  }

  return picks.some((pick) => passesDetectionFilters(pick.detection, settings));
}

function resolveBoxShape(cornerRadius: number): BoxShape {
  return cornerRadius > 0 ? BoxShape.RoundedRect : BoxShape.Rect;
}

function createDemoMaskStyle(settings: DemoPresentationSettings): MaskStyle {
  return {
    artifactKey: [
      "demo-mask",
      settings.confidenceThreshold,
      serializeHiddenClasses(settings.hiddenClasses),
      settings.maskMode,
      settings.maskFillAlpha,
      settings.maskStrokeAlpha,
      settings.maskStrokeWidth,
      serializeMaskClassStyles(settings.classStyles),
    ].join(":"),
    opacity: settings.maskOpacity,

    resolve(detection: Detection): MaskDrawInstruction | undefined {
      if (!detection.mask || !passesDetectionFilters(detection, settings)) {
        return undefined;
      }

      const style = resolveClassStyle(detection, settings);

      return {
        alpha:
          settings.maskMode === MaskRenderMode.StrokeOnly
            ? 0
            : settings.maskFillAlpha,
        color: style.fill,
        mask: detection.mask,
        stroke:
          settings.maskMode !== MaskRenderMode.FillOnly &&
          settings.maskStrokeWidth > 0 &&
          settings.maskStrokeAlpha > 0
            ? {
                alpha: settings.maskStrokeAlpha,
                color: style.stroke,
                width: settings.maskStrokeWidth,
              }
            : undefined,
      };
    },
  };
}

function resolveDemoLabelText(
  detection: Detection,
  settings: DemoPresentationSettings,
) {
  const parts: string[] = [];

  if (settings.labelShowClass && detection.className) {
    parts.push(detection.className);
  }

  if (settings.labelShowId && detection.id !== undefined) {
    parts.push(`#${String(detection.id)}`);
  }

  if (settings.labelIncludeConfidence && detection.confidence !== undefined) {
    parts.push(`${Math.round(detection.confidence * 100)}%`);
  }

  return parts.join(" ");
}

function createDemoLabelStyle(settings: DemoPresentationSettings): LabelStyle {
  return new BaseLabelStyle({
    background: (detection) => ({
      alpha: settings.labelBackgroundAlpha,
      color: resolveClassStyle(detection, settings).labelBackground,
      cornerRadius: settings.labelCornerRadius,
      paddingX: settings.labelPaddingX,
      paddingY: settings.labelPaddingY,
      topCornersOnly: true,
    }),
    text: (detection) => resolveDemoLabelText(detection, settings),
    offset: {
      ...(settings.labelOffsetX === 0 ? {} : { x: settings.labelOffsetX }),
      y: settings.labelOffsetY,
    },
    placement: settings.labelPlacement,
    shouldRender: (detection) =>
      passesDetectionFilters(detection, settings) &&
      resolveDemoLabelText(detection, settings).length > 0,
    textStyle: (detection) => ({
      color: resolveClassStyle(detection, settings).labelText,
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
      fontSize: settings.labelFontSize,
      fontWeight: "600",
    }),
  });
}

function createDemoInteractionStyle(
  settings: DemoPresentationSettings,
): InteractionStyle {
  return new BaseInteractionStyle({
    hovered: createDemoInteractionPresentation(
      settings,
      DetectionInteractionState.Hovered,
    ),
    selected: createDemoInteractionPresentation(
      settings,
      DetectionInteractionState.Selected,
    ),
    shouldRender: (detection) =>
      passesDetectionFilters(detection, settings) &&
      (settings.boxesEnabled ||
        settings.masksEnabled ||
        settings.polygonsEnabled ||
        settings.polylinesEnabled ||
        settings.keypointsEnabled),
  });
}

function createDemoInteractionPresentation(
  settings: DemoPresentationSettings,
  state: DetectionInteractionState,
) {
  return {
    boxStyle: settings.boxesEnabled
      ? createDemoInteractionBoxStyle(settings, state)
      : null,
    keypointStyle: settings.keypointsEnabled
      ? createDemoInteractionKeypointStyle(settings, state)
      : null,
    maskStyle: settings.masksEnabled
      ? createDemoInteractionMaskStyle(settings, state)
      : null,
    polygonStyle: settings.polygonsEnabled
      ? createDemoInteractionPolygonStyle(settings, state)
      : null,
    polylineStyle: settings.polylinesEnabled
      ? createDemoInteractionPolylineStyle(settings, state)
      : null,
  };
}

function createDemoInteractionPolygonStyle(
  settings: DemoPresentationSettings,
  state: DetectionInteractionState,
): PolygonStyle {
  const isSelected = state === DetectionInteractionState.Selected;

  return new BasePolygonStyle({
    fill: (detection) => ({
      alpha: isSelected
        ? settings.interactionSelectedFillAlpha
        : settings.interactionHoverFillAlpha,
      color: resolveClassStyle(detection, settings).fill,
    }),
    shouldRender: (detection) => passesDetectionFilters(detection, settings),
    stroke: (detection) => ({
      alpha: 1,
      color: resolveClassStyle(detection, settings).stroke,
      width: isSelected
        ? settings.interactionSelectedStrokeWidth
        : settings.interactionHoverStrokeWidth,
    }),
  });
}

function createDemoInteractionPolylineStyle(
  settings: DemoPresentationSettings,
  state: DetectionInteractionState,
): PolylineStyle {
  const isSelected = state === DetectionInteractionState.Selected;

  return new BasePolylineStyle({
    shouldRender: (detection) => passesDetectionFilters(detection, settings),
    stroke: (detection) => ({
      alpha: 1,
      color: resolveClassStyle(detection, settings).stroke,
      width: isSelected
        ? settings.interactionSelectedStrokeWidth
        : settings.interactionHoverStrokeWidth,
    }),
  });
}

function createDemoInteractionKeypointStyle(
  settings: DemoPresentationSettings,
  state: DetectionInteractionState,
): KeypointStyle {
  const isSelected = state === DetectionInteractionState.Selected;

  return applyDemoKeypointAnnotator(
    new BaseKeypointStyle({
      edgeShadowStroke: {
        alpha: 0.25,
        color: 0x000000,
        width: 3,
      },
      edgeStroke: (detection) => ({
        alpha: 1,
        color: resolveClassStyle(detection, settings).stroke,
        width: isSelected
          ? settings.interactionSelectedStrokeWidth
          : settings.interactionHoverStrokeWidth,
      }),
      markerFill: (detection) => ({
        alpha: 1,
        color: resolveClassStyle(detection, settings).fill,
      }),
      markerStroke: () => ({
        alpha: 1,
        color: 0xffffff,
        width: 1,
      }),
      radius: settings.keypointRadius,
      shouldRender: (detection) => passesDetectionFilters(detection, settings),
    }),
    settings,
  );
}

function createDemoInteractionBoxStyle(
  settings: DemoPresentationSettings,
  state: DetectionInteractionState,
): BoxStyle {
  const isSelected = state === DetectionInteractionState.Selected;

  return {
    resolve(
      detection: Detection,
      context: BoxStyleContext,
    ): BoxDrawInstruction | undefined {
      if (!detection.rect || !passesDetectionFilters(detection, settings)) {
        return undefined;
      }

      return resolveDemoBoxInstruction(
        detection.rect,
        settings,
        resolveClassStyle(detection, settings),
        context,
        {
          fillAlpha: isSelected
            ? settings.interactionSelectedFillAlpha
            : settings.interactionHoverFillAlpha,
          strokeWidth: isSelected
            ? settings.interactionSelectedStrokeWidth
            : settings.interactionHoverStrokeWidth,
        },
      );
    },
  };
}

function createDemoInteractionMaskStyle(
  settings: DemoPresentationSettings,
  state: DetectionInteractionState,
): MaskStyle {
  return {
    resolve(detection: Detection): MaskDrawInstruction | undefined {
      if (!detection.mask || !passesDetectionFilters(detection, settings)) {
        return undefined;
      }

      const style = resolveClassStyle(detection, settings);
      const isSelected = state === DetectionInteractionState.Selected;

      return {
        alpha: isSelected
          ? settings.interactionSelectedFillAlpha
          : settings.interactionHoverFillAlpha,
        color: style.fill,
        mask: detection.mask,
        stroke: {
          alpha: 1,
          color: style.stroke,
          width: isSelected
            ? settings.interactionSelectedStrokeWidth
            : settings.interactionHoverStrokeWidth,
        },
      };
    },
  };
}

function passesDetectionFilters(
  detection: Detection,
  settings: DemoPresentationSettings,
) {
  return (
    (detection.confidence ?? 1) >= settings.confidenceThreshold &&
    (!detection.className ||
      !settings.hiddenClasses.includes(detection.className))
  );
}

export function resolveDemoClassStyle(
  settings: DemoPresentationSettings,
  className: string,
) {
  return (
    settings.classStyles[className] ??
    createCanonicalDemoClassStyle(resolveDetectionClassColorStyle(className))
  );
}

function resolveClassStyle(
  detection: Detection,
  settings: DemoPresentationSettings,
) {
  return detection.className
    ? resolveDemoClassStyle(settings, detection.className)
    : createCanonicalDemoClassStyle(resolveDetectionClassColorStyle(undefined));
}

function createCanonicalDemoClassStyle(
  style: DetectionClassColorStyle,
): DemoClassStyle {
  return {
    fill: style.fill,
    labelBackground: style.fill,
    labelText: resolveDemoLabelTextColor(style.fill),
    stroke: style.fill,
  };
}

function resolveDemoLabelTextColor(color: number) {
  const red = (color >> 16) & 0xff;
  const green = (color >> 8) & 0xff;
  const blue = color & 0xff;
  const luminance = (red * 299 + green * 587 + blue * 114) / 1000;

  return luminance >= 150 ? 0x111111 : 0xffffff;
}

function serializeHiddenClasses(hiddenClasses: readonly string[]) {
  return [...hiddenClasses].sort().join(",");
}

function serializeMaskClassStyles(styles: Record<string, DemoClassStyle>) {
  return Object.entries(styles)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([className, style]) => `${className}:${style.fill}:${style.stroke}`)
    .join("|");
}
