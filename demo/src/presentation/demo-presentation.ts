import {
  BoxStrokeAlignment,
  BoxShape,
  BaseFocusStyle,
  BaseInteractionStyle,
  DEFAULT_DETECTION_CLASS_STYLES,
  DetectionInteractionState,
  type DetectionClassColorStyle,
  FocusTargetMode,
  LabelPlacement,
  MaskRenderMode,
  type BoxDrawInstruction,
  type BoxStyle,
  type Detection,
  type FocusStyle,
  type InteractionStyle,
  type LabelDrawInstruction,
  type LabelStyle,
  type MaskDrawInstruction,
  type MaskStyle,
  type MediaRendererPresentation,
  resolveDetectionClassColorStyle,
} from "supervision-js";

export type DemoClassStyle = DetectionClassColorStyle;

export interface DemoPresentationSettings {
  readonly boxesEnabled: boolean;
  readonly focusEnabled: boolean;
  readonly labelsEnabled: boolean;
  readonly masksEnabled: boolean;
  readonly boxCornerRadius: number;
  readonly boxStrokeWidth: number;
  readonly boxStrokeAlignment: BoxStrokeAlignment;
  readonly boxFillAlpha: number;
  readonly classStyles: Record<string, DemoClassStyle>;
  readonly labelBackgroundAlpha: number;
  readonly labelCornerRadius: number;
  readonly labelFontSize: number;
  readonly labelOffsetX: number;
  readonly labelOffsetY: number;
  readonly labelPaddingX: number;
  readonly labelPaddingY: number;
  readonly labelPlacement: LabelPlacement;
  readonly maskMode: MaskRenderMode;
  readonly maskOpacity: number;
  readonly maskStrokeAlpha: number;
  readonly maskStrokeWidth: number;
  readonly confidenceThreshold: number;
  readonly interactionHoverFillAlpha: number;
  readonly interactionHoverStrokeWidth: number;
  readonly interactionSelectedFillAlpha: number;
  readonly interactionSelectedStrokeWidth: number;
  readonly focusCornerRadius: number;
  readonly focusDimColor: number;
  readonly focusDimAlpha: number;
  readonly focusTargetMode: FocusTargetMode;
}

export const defaultDemoClassNames = ["person", "horse", "cow"];

const defaultDemoClassStyles: Record<string, DemoClassStyle> = {
  basketball: DEFAULT_DETECTION_CLASS_STYLES.basketball,
  cow: DEFAULT_DETECTION_CLASS_STYLES.cow,
  horse: DEFAULT_DETECTION_CLASS_STYLES.horse,
  person: DEFAULT_DETECTION_CLASS_STYLES.person,
  "white team player": DEFAULT_DETECTION_CLASS_STYLES["white team player"],
  "yellow team player": DEFAULT_DETECTION_CLASS_STYLES["yellow team player"],
};

export const defaultDemoPresentationSettings: DemoPresentationSettings = {
  boxesEnabled: false,
  boxCornerRadius: 8,
  boxFillAlpha: 0.1,
  boxStrokeAlignment: BoxStrokeAlignment.Center,
  boxStrokeWidth: 4,
  classStyles: defaultDemoClassStyles,
  confidenceThreshold: 0.5,
  focusCornerRadius: 10,
  focusDimAlpha: 0.45,
  focusDimColor: 0x020617,
  focusEnabled: true,
  focusTargetMode: FocusTargetMode.HoveredAndSelected,
  interactionHoverFillAlpha: 0.12,
  interactionHoverStrokeWidth: 5,
  interactionSelectedFillAlpha: 0.22,
  interactionSelectedStrokeWidth: 7,
  labelBackgroundAlpha: 0.78,
  labelCornerRadius: 5,
  labelFontSize: 14,
  labelOffsetX: 0,
  labelOffsetY: 0,
  labelPaddingX: 7,
  labelPaddingY: 4,
  labelPlacement: LabelPlacement.Top,
  labelsEnabled: true,
  maskMode: MaskRenderMode.FillAndStroke,
  maskOpacity: 0.7,
  maskStrokeAlpha: 1,
  maskStrokeWidth: 5,
  masksEnabled: true,
};

export function createDemoPresentation(
  settings: DemoPresentationSettings,
): MediaRendererPresentation {
  return {
    boxStyle: settings.boxesEnabled ? createDemoBoxStyle(settings) : null,
    focusStyle: settings.focusEnabled ? createDemoFocusStyle(settings) : null,
    interactionStyle: createDemoInteractionStyle(settings),
    labelStyle: settings.labelsEnabled ? createDemoLabelStyle(settings) : null,
    maskStyle: settings.masksEnabled ? createDemoMaskStyle(settings) : null,
  };
}

function createDemoBoxStyle(settings: DemoPresentationSettings): BoxStyle {
  return {
    resolve(detection: Detection): BoxDrawInstruction | undefined {
      if (!detection.rect || !passesConfidenceThreshold(detection, settings)) {
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
          alignment: settings.boxStrokeAlignment,
          alpha: 0.95,
          color: style.stroke,
          width: settings.boxStrokeWidth,
        },
      };
    },
  };
}

function createDemoFocusStyle(settings: DemoPresentationSettings): FocusStyle {
  return new BaseFocusStyle({
    cornerRadius: settings.focusCornerRadius,
    fill: {
      alpha: settings.focusDimAlpha,
      color: settings.focusDimColor,
    },
    shape: resolveBoxShape(settings.focusCornerRadius),
    shouldRender: (context) => hasRenderableFocusTarget(context, settings),
    targetMode: settings.focusTargetMode,
  });
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
        alpha: settings.maskMode === MaskRenderMode.StrokeOnly ? 0 : 1,
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
  return {
    resolve(detection: Detection): LabelDrawInstruction | undefined {
      if (!detection.rect || !passesConfidenceThreshold(detection, settings)) {
        return undefined;
      }

      const className = detection.className ?? "detection";
      const style = resolveClassStyle(detection, settings);
      const confidence =
        detection.confidence === undefined
          ? ""
          : ` ${Math.round(detection.confidence * 100)}%`;

      return {
        background: {
          alpha: settings.labelBackgroundAlpha,
          color: style.labelBackground,
          cornerRadius: settings.labelCornerRadius,
          paddingX: settings.labelPaddingX,
          paddingY: settings.labelPaddingY,
        },
        offsetX: settings.labelOffsetX,
        offsetY: settings.labelOffsetY,
        placement: settings.labelPlacement,
        rect: detection.rect,
        text: `${className}${confidence}`,
        textStyle: {
          alpha: 1,
          color: style.labelText,
          fontFamily: "Inter, sans-serif",
          fontSize: settings.labelFontSize,
          fontWeight: "750",
        },
      };
    },
  };
}

function createDemoInteractionStyle(
  settings: DemoPresentationSettings,
): InteractionStyle {
  return new BaseInteractionStyle({
    hovered: {
      boxStyle: settings.boxesEnabled
        ? createDemoInteractionBoxStyle(
            settings,
            DetectionInteractionState.Hovered,
          )
        : null,
      maskStyle: settings.masksEnabled
        ? createDemoInteractionMaskStyle(
            settings,
            DetectionInteractionState.Hovered,
          )
        : null,
    },
    selected: {
      boxStyle: settings.boxesEnabled
        ? createDemoInteractionBoxStyle(
            settings,
            DetectionInteractionState.Selected,
          )
        : null,
      maskStyle: settings.masksEnabled
        ? createDemoInteractionMaskStyle(
            settings,
            DetectionInteractionState.Selected,
          )
        : null,
    },
    shouldRender: (detection) =>
      passesConfidenceThreshold(detection, settings) &&
      (settings.boxesEnabled || settings.masksEnabled),
  });
}

function createDemoInteractionBoxStyle(
  settings: DemoPresentationSettings,
  state: DetectionInteractionState,
): BoxStyle {
  return {
    resolve(detection: Detection): BoxDrawInstruction | undefined {
      if (!detection.rect || !passesConfidenceThreshold(detection, settings)) {
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
          alignment: BoxStrokeAlignment.Outside,
          alpha: isSelected ? 1 : 0.88,
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
          alpha: isSelected ? 1 : 0.9,
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

export function resolveDemoClassStyle(
  settings: DemoPresentationSettings,
  className: string,
) {
  return (
    settings.classStyles[className] ??
    resolveDetectionClassColorStyle(className)
  );
}

function resolveClassStyle(
  detection: Detection,
  settings: DemoPresentationSettings,
) {
  return detection.className
    ? resolveDemoClassStyle(settings, detection.className)
    : resolveDetectionClassColorStyle(undefined);
}

function serializeMaskClassStyles(styles: Record<string, DemoClassStyle>) {
  return Object.entries(styles)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([className, style]) => `${className}:${style.fill}:${style.stroke}`)
    .join("|");
}
