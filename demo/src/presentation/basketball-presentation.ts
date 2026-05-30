import {
  BoxShape,
  type BoxDrawInstruction,
  type BoxStyle,
  type Detection,
  type LabelDrawInstruction,
  type LabelStyle,
  type MaskDrawInstruction,
  type MaskStyle,
  type MediaRendererPresentation,
} from "supervision-js";

export interface BasketballClassStyle {
  readonly fill: number;
  readonly labelBackground: number;
  readonly labelText: number;
  readonly stroke: number;
}

export interface BasketballPresentationSettings {
  readonly boxesEnabled: boolean;
  readonly labelsEnabled: boolean;
  readonly masksEnabled: boolean;
  readonly boxShape: BoxShape;
  readonly boxStrokeWidth: number;
  readonly boxFillAlpha: number;
  readonly classStyles: Record<string, BasketballClassStyle>;
  readonly labelBackgroundAlpha: number;
  readonly labelFontSize: number;
  readonly maskAlpha: number;
  readonly maskStrokeAlpha: number;
  readonly maskStrokeWidth: number;
  readonly confidenceThreshold: number;
}

export const defaultBasketballClassNames = [
  "basketball",
  "white team player",
  "yellow team player",
];

const defaultBasketballClassStyles: Record<string, BasketballClassStyle> = {
  basketball: {
    fill: 0xff7a1a,
    labelBackground: 0x7c2d12,
    labelText: 0xfff7ed,
    stroke: 0xffa23a,
  },
  "white team player": {
    fill: 0xf8fafc,
    labelBackground: 0x334155,
    labelText: 0xffffff,
    stroke: 0xffffff,
  },
  "yellow team player": {
    fill: 0xfacc15,
    labelBackground: 0x713f12,
    labelText: 0xfffbeb,
    stroke: 0xfde047,
  },
};

const fallbackStyle: BasketballClassStyle = {
  fill: 0x38bdf8,
  labelBackground: 0x164e63,
  labelText: 0xecfeff,
  stroke: 0x7dd3fc,
};

export const defaultBasketballPresentationSettings: BasketballPresentationSettings =
  {
    boxesEnabled: true,
    boxFillAlpha: 0.1,
    boxShape: BoxShape.RoundedRect,
    boxStrokeWidth: 4,
    classStyles: defaultBasketballClassStyles,
    confidenceThreshold: 0.5,
    labelBackgroundAlpha: 0.78,
    labelFontSize: 14,
    labelsEnabled: true,
    maskAlpha: 0.3,
    maskStrokeAlpha: 1,
    maskStrokeWidth: 1,
    masksEnabled: true,
  };

export function createBasketballSamplePresentation(
  settings: BasketballPresentationSettings,
): MediaRendererPresentation {
  return {
    boxStyle: settings.boxesEnabled ? createBasketballBoxStyle(settings) : null,
    labelStyle: settings.labelsEnabled
      ? createBasketballLabelStyle(settings)
      : null,
    maskStyle: settings.masksEnabled
      ? createBasketballMaskStyle(settings)
      : null,
  };
}

function createBasketballBoxStyle(
  settings: BasketballPresentationSettings,
): BoxStyle {
  return {
    resolve(detection: Detection): BoxDrawInstruction | undefined {
      if (!detection.rect || !passesConfidenceThreshold(detection, settings)) {
        return undefined;
      }

      const style = resolveClassStyle(detection, settings);

      return {
        cornerRadius:
          settings.boxShape === BoxShape.RoundedRect
            ? detection.className === "basketball"
              ? 12
              : 8
            : undefined,
        fill: {
          alpha: settings.boxFillAlpha,
          color: style.fill,
        },
        rect: detection.rect,
        shape: settings.boxShape,
        stroke: {
          alpha: 0.95,
          color: style.stroke,
          width: settings.boxStrokeWidth,
        },
      };
    },
  };
}

function createBasketballMaskStyle(
  settings: BasketballPresentationSettings,
): MaskStyle {
  return {
    artifactKey: [
      "basketball-mask",
      settings.confidenceThreshold,
      settings.maskAlpha,
      settings.maskStrokeAlpha,
      settings.maskStrokeWidth,
      serializeMaskClassStyles(settings.classStyles),
    ].join(":"),
    opacity: 1,

    resolve(detection: Detection): MaskDrawInstruction | undefined {
      if (!detection.mask || !passesConfidenceThreshold(detection, settings)) {
        return undefined;
      }

      const style = resolveClassStyle(detection, settings);

      return {
        alpha: settings.maskAlpha,
        color: style.fill,
        mask: detection.mask,
        stroke:
          settings.maskStrokeWidth > 0 && settings.maskStrokeAlpha > 0
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

function createBasketballLabelStyle(
  settings: BasketballPresentationSettings,
): LabelStyle {
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
          cornerRadius: 5,
          paddingX: 7,
          paddingY: 4,
        },
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

function passesConfidenceThreshold(
  detection: Detection,
  settings: BasketballPresentationSettings,
) {
  return (detection.confidence ?? 1) >= settings.confidenceThreshold;
}

export function resolveBasketballClassStyle(
  settings: BasketballPresentationSettings,
  className: string,
) {
  return settings.classStyles[className] ?? fallbackStyle;
}

function resolveClassStyle(
  detection: Detection,
  settings: BasketballPresentationSettings,
) {
  return detection.className
    ? resolveBasketballClassStyle(settings, detection.className)
    : fallbackStyle;
}

function serializeMaskClassStyles(
  styles: Record<string, BasketballClassStyle>,
) {
  return Object.entries(styles)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([className, style]) => `${className}:${style.fill}:${style.stroke}`)
    .join("|");
}
