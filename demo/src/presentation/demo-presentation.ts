import {
  BoxStrokeAlignment,
  BoxShape,
  BaseMarkerStyle,
  BaseFocusStyle,
  BaseBoxCornerStyle,
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
  MaskRenderMode,
  annotationRenderers,
  type BoxDrawInstruction,
  type BoxCornerStyle,
  type BoxStyle,
  type BoxStyleContext,
  type Detection,
  type EllipseStyle,
  type FocusStyle,
  type InteractionStyle,
  type KeypointStyle,
  type LabelStyle,
  type MaskDrawInstruction,
  type MaskHaloStyle,
  type MaskStyle,
  type MarkerStyle,
  type MediaRendererPresentation,
  type PolygonStyle,
  type PolylineStyle,
  resolveDetectionClassColorStyle,
} from "supervision";

export type DemoClassStyle = DetectionClassColorStyle;

export const demoMarkerPositionOffsets = {
  "top-left": { x: -0.5, y: -0.5 },
  "top-center": { x: 0, y: -0.5 },
  "top-right": { x: 0.5, y: -0.5 },
  "center-left": { x: -0.5, y: 0 },
  center: { x: 0, y: 0 },
  "center-right": { x: 0.5, y: 0 },
  "bottom-left": { x: -0.5, y: 0.5 },
  "bottom-center": { x: 0, y: 0.5 },
  "bottom-right": { x: 0.5, y: 0.5 },
} as const;

export type DemoMarkerPosition = keyof typeof demoMarkerPositionOffsets;

export interface DemoPresentationSettings {
  readonly boxesEnabled: boolean;
  readonly boxCornersEnabled: boolean;
  readonly ellipsesEnabled: boolean;
  readonly focusEnabled: boolean;
  readonly keypointsEnabled: boolean;
  readonly labelsEnabled: boolean;
  readonly masksEnabled: boolean;
  readonly markersEnabled: boolean;
  readonly polygonsEnabled: boolean;
  readonly polylinesEnabled: boolean;
  readonly boxCornerRadius: number;
  readonly boxCornerLength: number;
  readonly boxCornerStrokeWidth: number;
  readonly boxStrokeWidth: number;
  readonly boxStrokeAlignment: BoxStrokeAlignment;
  readonly boxFillAlpha: number;
  readonly classStyles: Record<string, DemoClassStyle>;
  readonly labelBackgroundAlpha: number;
  readonly labelCornerRadius: number;
  readonly labelFontSize: number;
  readonly labelIncludeConfidence: boolean;
  readonly maskHaloAlpha: number;
  /** Fixed glow color; null follows each detection's class color. */
  readonly maskHaloColor: number | null;
  readonly maskHaloEnabled: boolean;
  readonly maskHaloSpread: number;
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
  readonly markerPosition: DemoMarkerPosition;
  readonly markerShape: MarkerShape;
  readonly markerSize: number;
  readonly markerStrokeWidth: number;
  readonly polygonFillAlpha: number;
  readonly polygonStrokeWidth: number;
  readonly polylineStrokeWidth: number;
  readonly ellipseAxisRatio: number;
  /** Fixed arc color; null follows each detection's class color. */
  readonly ellipseColor: number | null;
  readonly ellipseStrokeWidth: number;
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
  | "boxCornersEnabled"
  | "ellipsesEnabled"
  | "focusEnabled"
  | "keypointsEnabled"
  | "labelsEnabled"
  | "masksEnabled"
  | "markersEnabled"
  | "polygonsEnabled"
  | "polylinesEnabled";

export type DemoPresentationAvailability = Partial<
  Record<DemoPresentationLayerSetting, boolean>
>;

const demoPresentationLayerSettings: readonly DemoPresentationLayerSetting[] = [
  "boxesEnabled",
  "boxCornersEnabled",
  "ellipsesEnabled",
  "focusEnabled",
  "keypointsEnabled",
  "labelsEnabled",
  "masksEnabled",
  "markersEnabled",
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
  boxesEnabled: true,
  boxCornersEnabled: false,
  boxCornerLength: 20,
  boxCornerStrokeWidth: 2,
  boxCornerRadius: 1,
  boxFillAlpha: 0.08,
  boxStrokeAlignment: BoxStrokeAlignment.Center,
  boxStrokeWidth: 2,
  classStyles: defaultDemoClassStyles,
  confidenceThreshold: 0,
  ellipseAxisRatio: 0.35,
  ellipseColor: null,
  ellipseStrokeWidth: 2,
  ellipsesEnabled: false,
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
  keypointEdgeWidth: 1.5,
  keypointRadius: 3.5,
  keypointsEnabled: true,
  labelBackgroundAlpha: 1,
  labelCornerRadius: 4,
  labelFontSize: 12,
  labelIncludeConfidence: false,
  maskHaloAlpha: 0.6,
  maskHaloColor: null,
  maskHaloEnabled: false,
  maskHaloSpread: 12,
  labelOffsetX: 0,
  labelOffsetY: 0,
  labelPaddingX: 6,
  labelPaddingY: 3,
  labelPlacement: LabelPlacement.Top,
  labelsEnabled: true,
  maskMode: MaskRenderMode.FillAndStroke,
  maskFillAlpha: 0.45,
  maskOpacity: 1,
  maskStrokeAlpha: 1,
  maskStrokeWidth: 2,
  masksEnabled: true,
  markerPosition: "center",
  markerShape: MarkerShape.Circle,
  markerSize: 14,
  markerStrokeWidth: 2,
  markersEnabled: false,
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
  const boxCornerStyle = settings.boxCornersEnabled
    ? createDemoBoxCornerStyle(settings)
    : null;
  const ellipseStyle = settings.ellipsesEnabled
    ? createDemoEllipseStyle(settings)
    : null;
  const keypointStyle = settings.keypointsEnabled
    ? createDemoKeypointStyle(settings)
    : null;
  const labelStyle = settings.labelsEnabled
    ? createDemoLabelStyle(settings)
    : null;
  const maskStyle = settings.masksEnabled
    ? createDemoMaskStyle(settings)
    : null;
  const maskHaloStyle = settings.maskHaloEnabled
    ? createDemoMaskHaloStyle(settings)
    : null;
  const markerStyle = settings.markersEnabled
    ? createDemoMarkerStyle(settings)
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
    boxCornerStyle,
    // Class visibility rides the renderer-owned visibility contract so every
    // layer and the prepared-mask cache invalidate consistently.
    visibility: { hiddenClasses: settings.hiddenClasses },
    ellipseStyle,
    focusStyle: settings.focusEnabled ? createDemoFocusStyle(settings) : null,
    interactionStyle: createDemoInteractionStyle(settings),
    keypointStyle,
    labelStyle,
    maskStyle,
    markerStyle,
    polygonStyle,
    polylineStyle,
    maskHaloStyle,
    renderers: [
      ...(boxStyle ? [annotationRenderers.box({ style: boxStyle })] : []),
      ...(boxCornerStyle
        ? [annotationRenderers.boxCorners({ style: boxCornerStyle })]
        : []),
      ...(ellipseStyle
        ? [annotationRenderers.ellipse({ style: ellipseStyle })]
        : []),
      ...(maskStyle ? [annotationRenderers.mask({ style: maskStyle })] : []),
      ...(maskHaloStyle
        ? [annotationRenderers.maskHalo({ style: maskHaloStyle })]
        : []),
      ...(markerStyle
        ? [annotationRenderers.marker({ style: markerStyle })]
        : []),
      ...(polygonStyle
        ? [annotationRenderers.polygon({ style: polygonStyle })]
        : []),
      ...(polylineStyle
        ? [annotationRenderers.polyline({ style: polylineStyle })]
        : []),
      ...(keypointStyle
        ? [annotationRenderers.keypoints({ style: keypointStyle })]
        : []),
      ...(labelStyle ? [annotationRenderers.label({ style: labelStyle })] : []),
    ],
  };
}

function createDemoMarkerStyle(
  settings: DemoPresentationSettings,
): MarkerStyle {
  const positionOffset = demoMarkerPositionOffsets[settings.markerPosition];

  return new BaseMarkerStyle({
    center: (detection) =>
      detection.rect
        ? {
            x: detection.rect.x + detection.rect.width * positionOffset.x,
            y: detection.rect.y + detection.rect.height * positionOffset.y,
          }
        : undefined,
    fill: (detection) => ({
      color: resolveClassStyle(detection, settings).fill,
    }),
    shape: settings.markerShape,
    shouldRender: (detection) => passesConfidenceThreshold(detection, settings),
    size: settings.markerSize,
    stroke: (detection) => ({
      color: resolveClassStyle(detection, settings).stroke,
      width: settings.markerStrokeWidth,
    }),
  });
}

function createDemoBoxCornerStyle(
  settings: DemoPresentationSettings,
): BoxCornerStyle {
  return new BaseBoxCornerStyle({
    length: settings.boxCornerLength,
    shouldRender: (detection) => passesConfidenceThreshold(detection, settings),
    stroke: (detection) => ({
      color: resolveClassStyle(detection, settings).stroke,
      width: settings.boxCornerStrokeWidth,
    }),
  });
}

/**
 * The Python Supervision EllipseAnnotator look: an elliptical footprint arc
 * swept from -45deg to 235deg under the detection box.
 */
function createDemoEllipseStyle(
  settings: DemoPresentationSettings,
): EllipseStyle {
  return {
    resolve(detection, context) {
      if (
        !detection.rect ||
        context.hidden ||
        !passesConfidenceThreshold(detection, settings)
      ) {
        return undefined;
      }

      const radiusX = detection.rect.width / 2;
      const radiusY = radiusX * settings.ellipseAxisRatio;

      return {
        center: {
          x: detection.rect.x,
          // Bottom-tangent so the arc hugs the detection instead of dipping
          // below its feet.
          y: detection.rect.y + detection.rect.height / 2 - radiusY,
        },
        endAngle: (235 * Math.PI) / 180,
        radiusX,
        radiusY,
        startAngle: (-45 * Math.PI) / 180,
        stroke: {
          alpha: 1,
          color:
            settings.ellipseColor ??
            resolveClassStyle(detection, settings).stroke,
          width: settings.ellipseStrokeWidth,
        },
      };
    },
  };
}

function createDemoPolygonStyle(
  settings: DemoPresentationSettings,
): PolygonStyle {
  return new BasePolygonStyle({
    fill: (detection) => ({
      alpha: settings.polygonFillAlpha,
      color: resolveClassStyle(detection, settings).fill,
    }),
    shouldRender: (detection) => passesConfidenceThreshold(detection, settings),
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
    shadowStroke: createDemoPolylineShadowStroke(settings.polylineStrokeWidth),
    shouldRender: (detection) =>
      passesTrajectoryConfidenceThreshold(detection, settings),
    stroke: (detection) => ({
      alpha: 1,
      color: resolveClassStyle(detection, settings).stroke,
      width: settings.polylineStrokeWidth,
    }),
  });
}

/**
 * Contrast under a path that crosses whatever the media happens to show.
 *
 * A trajectory is drawn in its class color so it stays tied to the object it
 * describes, and the basketball's orange over a wooden court is the case where
 * that color alone leaves the path unreadable.
 */
export function createDemoPolylineShadowStroke(strokeWidth: number) {
  return {
    alpha: 0.55,
    color: 0x000000,
    width: strokeWidth + 2,
  };
}

function createDemoKeypointStyle(
  settings: DemoPresentationSettings,
): KeypointStyle {
  return new BaseKeypointStyle({
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
    shouldRender: (detection) => passesConfidenceThreshold(detection, settings),
  });
}

function createDemoBoxStyle(settings: DemoPresentationSettings): BoxStyle {
  return {
    resolve(
      detection: Detection,
      context: BoxStyleContext,
    ): BoxDrawInstruction | undefined {
      if (
        !detection.rect ||
        context.hidden ||
        !passesConfidenceThreshold(detection, settings)
      ) {
        return undefined;
      }

      const style = resolveClassStyle(detection, settings);
      const shape = resolveBoxShape(settings.boxCornerRadius);

      return {
        cornerRadius:
          shape === BoxShape.RoundedRect ? settings.boxCornerRadius : undefined,
        fill: {
          alpha: settings.boxFillAlpha,
          color: style.fill,
        },
        rect: detection.rect,
        shape,
        stroke: {
          ...(settings.boxStrokeAlignment === BoxStrokeAlignment.Center
            ? {}
            : { alignment: settings.boxStrokeAlignment }),
          alpha: 1,
          color: style.stroke,
          width: settings.boxStrokeWidth,
        },
      };
    },
  };
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
                passesConfidenceThreshold(
                  context.hoveredPick.detection,
                  settings,
                )
                  ? context.hoveredPick
                  : null,
              selectedPick:
                context.selectedPick &&
                passesConfidenceThreshold(
                  context.selectedPick.detection,
                  settings,
                )
                  ? context.selectedPick
                  : null,
            }
          : context;
      const instruction = baseStyle.resolve(contextWithVisiblePicks);

      if (!instruction) {
        return undefined;
      }

      const targets = instruction.targets.filter((target) =>
        passesConfidenceThreshold(target.detection, settings),
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

  return picks.some((pick) =>
    passesConfidenceThreshold(pick.detection, settings),
  );
}

function resolveBoxShape(cornerRadius: number): BoxShape {
  return cornerRadius > 0 ? BoxShape.RoundedRect : BoxShape.Rect;
}

function createDemoMaskStyle(settings: DemoPresentationSettings): MaskStyle {
  return {
    artifactKey: [
      "demo-mask",
      settings.confidenceThreshold,
      settings.maskMode,
      settings.maskFillAlpha,
      settings.maskStrokeAlpha,
      settings.maskStrokeWidth,
      serializeMaskClassStyles(settings.classStyles),
    ].join(":"),
    opacity: settings.maskOpacity,

    resolve(detection: Detection): MaskDrawInstruction | undefined {
      if (!detection.mask || !passesConfidenceThreshold(detection, settings)) {
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

function createDemoMaskHaloStyle(
  settings: DemoPresentationSettings,
): MaskHaloStyle {
  return {
    resolve(detection, context) {
      if (
        !detection.mask ||
        context.hidden ||
        !passesConfidenceThreshold(detection, settings)
      ) {
        return undefined;
      }

      return {
        alpha: settings.maskHaloAlpha,
        color:
          settings.maskHaloColor ?? resolveClassStyle(detection, settings).fill,
        spread: settings.maskHaloSpread,
      };
    },
  };
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
    includeConfidence: settings.labelIncludeConfidence,
    offset: {
      ...(settings.labelOffsetX === 0 ? {} : { x: settings.labelOffsetX }),
      y: settings.labelOffsetY,
    },
    placement: settings.labelPlacement,
    shouldRender: (detection) =>
      passesConfidenceThreshold(detection, settings) &&
      hasDrawnGeometry(detection, settings),
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
      passesConfidenceThreshold(detection, settings) &&
      hasDrawnGeometry(detection, settings),
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
    shouldRender: (detection) => passesConfidenceThreshold(detection, settings),
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

  const strokeWidth = isSelected
    ? settings.interactionSelectedStrokeWidth
    : settings.interactionHoverStrokeWidth;

  return new BasePolylineStyle({
    shadowStroke: createDemoPolylineShadowStroke(strokeWidth),
    shouldRender: (detection) =>
      passesTrajectoryConfidenceThreshold(detection, settings),
    stroke: (detection) => ({
      alpha: 1,
      color: resolveClassStyle(detection, settings).stroke,
      width: strokeWidth,
    }),
  });
}

function createDemoInteractionKeypointStyle(
  settings: DemoPresentationSettings,
  state: DetectionInteractionState,
): KeypointStyle {
  const isSelected = state === DetectionInteractionState.Selected;

  return new BaseKeypointStyle({
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
    shouldRender: (detection) => passesConfidenceThreshold(detection, settings),
  });
}

function createDemoInteractionBoxStyle(
  settings: DemoPresentationSettings,
  state: DetectionInteractionState,
): BoxStyle {
  return {
    resolve(
      detection: Detection,
      context: BoxStyleContext,
    ): BoxDrawInstruction | undefined {
      if (
        !detection.rect ||
        context.hidden ||
        !passesConfidenceThreshold(detection, settings)
      ) {
        return undefined;
      }

      const style = resolveClassStyle(detection, settings);
      const isSelected = state === DetectionInteractionState.Selected;
      const shape = resolveBoxShape(settings.boxCornerRadius);

      return {
        cornerRadius:
          shape === BoxShape.RoundedRect ? settings.boxCornerRadius : undefined,
        fill: {
          alpha: isSelected
            ? settings.interactionSelectedFillAlpha
            : settings.interactionHoverFillAlpha,
          color: style.fill,
        },
        rect: detection.rect,
        shape,
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

function createDemoInteractionMaskStyle(
  settings: DemoPresentationSettings,
  state: DetectionInteractionState,
): MaskStyle {
  return {
    resolve(detection: Detection): MaskDrawInstruction | undefined {
      if (!detection.mask || !passesConfidenceThreshold(detection, settings)) {
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

function passesConfidenceThreshold(
  detection: Detection,
  settings: DemoPresentationSettings,
) {
  return (detection.confidence ?? 1) >= settings.confidenceThreshold;
}

/**
 * The confidence threshold applied to a path rather than to a frame.
 *
 * Every other layer draws what the detection is claimed to be at this moment,
 * so its own confidence is the number to filter on. A trajectory draws up to a
 * second of accepted observations, and filtering that on the newest frame's
 * score lets one weak frame erase a path built from twenty-five strong ones,
 * which a viewer reads as the trail blinking. A fixture that measures its own
 * tracks publishes that measurement, and the threshold keeps biting: a path
 * whose observations are weak throughout still disappears.
 */
function passesTrajectoryConfidenceThreshold(
  detection: Detection,
  settings: DemoPresentationSettings,
) {
  const trajectoryConfidence = detection.metadata?.trajectoryConfidence;

  return typeof trajectoryConfidence === "number"
    ? trajectoryConfidence >= settings.confidenceThreshold
    : passesConfidenceThreshold(detection, settings);
}

/**
 * Whether any enabled layer draws geometry this detection actually carries.
 *
 * Each geometry layer draws only its own field, so a detection whose fields
 * are all either absent or switched off contributes nothing to the picture,
 * and a label or hover highlight over it would name a shape that is not there.
 */
function hasDrawnGeometry(
  detection: Detection,
  settings: DemoPresentationSettings,
) {
  return (
    (settings.boxesEnabled && detection.rect !== undefined) ||
    (settings.masksEnabled && detection.mask !== undefined) ||
    (settings.polygonsEnabled && detection.polygon !== undefined) ||
    (settings.polylinesEnabled && detection.polyline !== undefined) ||
    (settings.keypointsEnabled && detection.keypoints !== undefined)
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

function serializeMaskClassStyles(styles: Record<string, DemoClassStyle>) {
  return Object.entries(styles)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([className, style]) => `${className}:${style.fill}:${style.stroke}`)
    .join("|");
}
