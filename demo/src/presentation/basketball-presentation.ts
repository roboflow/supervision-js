import {
  BoxShape,
  type BoxDrawInstruction,
  type BoxStyle,
  type Detection,
  type MaskDrawInstruction,
  type MaskStyle,
  type MediaRendererPresentation,
} from "supervision-js";

export interface BasketballPresentationSettings {
  readonly boxesEnabled: boolean;
  readonly masksEnabled: boolean;
  readonly boxShape: BoxShape;
  readonly boxStrokeWidth: number;
  readonly boxFillAlpha: number;
  readonly maskAlpha: number;
  readonly confidenceThreshold: number;
}

interface BasketballClassStyle {
  readonly fill: number;
  readonly stroke: number;
}

const basketballClassStyles: Record<string, BasketballClassStyle> = {
  basketball: {
    fill: 0xff7a1a,
    stroke: 0xffa23a,
  },
  "white team player": {
    fill: 0xf8fafc,
    stroke: 0xffffff,
  },
  "yellow team player": {
    fill: 0xfacc15,
    stroke: 0xfde047,
  },
};

const fallbackStyle: BasketballClassStyle = {
  fill: 0x38bdf8,
  stroke: 0x7dd3fc,
};

export const defaultBasketballPresentationSettings: BasketballPresentationSettings =
  {
    boxesEnabled: true,
    boxFillAlpha: 0.1,
    boxShape: BoxShape.RoundedRect,
    boxStrokeWidth: 4,
    confidenceThreshold: 0.5,
    maskAlpha: 0.3,
    masksEnabled: true,
  };

export function createBasketballSamplePresentation(
  settings: BasketballPresentationSettings,
): MediaRendererPresentation {
  return {
    boxStyle: settings.boxesEnabled ? createBasketballBoxStyle(settings) : null,
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

      const style = resolveClassStyle(detection);

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
    resolve(detection: Detection): MaskDrawInstruction | undefined {
      if (!detection.mask || !passesConfidenceThreshold(detection, settings)) {
        return undefined;
      }

      return {
        alpha: Math.min(
          detection.className === "basketball"
            ? settings.maskAlpha * 1.2
            : settings.maskAlpha,
          1,
        ),
        color: resolveClassStyle(detection).fill,
        mask: detection.mask,
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

function resolveClassStyle(detection: Detection) {
  return detection.className
    ? (basketballClassStyles[detection.className] ?? fallbackStyle)
    : fallbackStyle;
}
