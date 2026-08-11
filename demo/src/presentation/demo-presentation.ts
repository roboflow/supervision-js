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
  MaskRenderMode,
  annotationRenderers,
  type BoxDrawInstruction,
  type BoxStyle,
  type Detection,
  type FocusStyle,
  type InteractionStyle,
  type KeypointStyle,
  type LabelStyle,
  type MaskDrawInstruction,
  type MaskStyle,
  type MediaRendererPresentation,
  type PolygonStyle,
  type PolylineStyle,
  resolveDetectionClassColorStyle,
} from "supervision";

export type DemoClassStyle = DetectionClassColorStyle;

export interface DemoPresentationSettings {
  readonly boxesEnabled: boolean;
  readonly focusEnabled: boolean;
  readonly keypointsEnabled: boolean;
  readonly labelsEnabled: boolean;
  readonly masksEnabled: boolean;
  readonly polygonsEnabled: boolean;
  readonly polylinesEnabled: boolean;
  readonly boxCornerRadius: number;
  readonly boxStrokeWidth: number;
  readonly boxStrokeAlignment: BoxStrokeAlignment;
  readonly boxFillAlpha: number;
  readonly classStyles: Record<string, DemoClassStyle>;
  readonly labelBackgroundAlpha: number;
  readonly labelCornerRadius: number;
  readonly labelFontSize: number;
  readonly labelIncludeConfidence: boolean;
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
  boxesEnabled: true,
  boxCornerRadius: 1,
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
  keypointEdgeWidth: 1.5,
  keypointRadius: 3.5,
  keypointsEnabled: true,
  labelBackgroundAlpha: 1,
  labelCornerRadius: 4,
  labelFontSize: 12,
  labelIncludeConfidence: false,
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
    focusStyle: settings.focusEnabled ? createDemoFocusStyle(settings) : null,
    interactionStyle: createDemoInteractionStyle(settings),
    keypointStyle,
    labelStyle,
    maskStyle,
    polygonStyle,
    polylineStyle,
    renderers: [
      ...(boxStyle ? [annotationRenderers.box({ style: boxStyle })] : []),
      ...(maskStyle ? [annotationRenderers.mask({ style: maskStyle })] : []),
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
    shouldRender: (detection) => passesDetectionFilters(detection, settings),
  });
}

function createDemoBoxStyle(settings: DemoPresentationSettings): BoxStyle {
  return {
    resolve(detection: Detection): BoxDrawInstruction | undefined {
      if (!detection.rect || !passesDetectionFilters(detection, settings)) {
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
    shouldRender: (detection) => passesDetectionFilters(detection, settings),
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
    shouldRender: (detection) => passesDetectionFilters(detection, settings),
  });
}

function createDemoInteractionBoxStyle(
  settings: DemoPresentationSettings,
  state: DetectionInteractionState,
): BoxStyle {
  return {
    resolve(detection: Detection): BoxDrawInstruction | undefined {
      if (!detection.rect || !passesDetectionFilters(detection, settings)) {
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
