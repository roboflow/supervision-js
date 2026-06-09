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

export interface DemoClassStyle {
  readonly fill: number;
  readonly labelBackground: number;
  readonly labelText: number;
  readonly stroke: number;
}

export interface DemoPresentationSettings {
  readonly boxesEnabled: boolean;
  readonly labelsEnabled: boolean;
  readonly masksEnabled: boolean;
  readonly boxCornerRadius: number;
  readonly boxStrokeWidth: number;
  readonly boxFillAlpha: number;
  readonly classStyles: Record<string, DemoClassStyle>;
  readonly labelBackgroundAlpha: number;
  readonly labelFontSize: number;
  readonly maskAlpha: number;
  readonly maskStrokeAlpha: number;
  readonly maskStrokeWidth: number;
  readonly confidenceThreshold: number;
}

export const defaultDemoClassNames = ["person", "horse", "cow"];

const defaultDemoClassStyles: Record<string, DemoClassStyle> = {
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
  cow: {
    fill: 0xa78bfa,
    labelBackground: 0x4c1d95,
    labelText: 0xf5f3ff,
    stroke: 0xc4b5fd,
  },
  horse: {
    fill: 0x38bdf8,
    labelBackground: 0x164e63,
    labelText: 0xecfeff,
    stroke: 0x7dd3fc,
  },
  person: {
    fill: 0x22c55e,
    labelBackground: 0x14532d,
    labelText: 0xf0fdf4,
    stroke: 0x86efac,
  },
};

const fallbackStyle: DemoClassStyle = {
  fill: 0x38bdf8,
  labelBackground: 0x164e63,
  labelText: 0xecfeff,
  stroke: 0x7dd3fc,
};

export const defaultDemoPresentationSettings: DemoPresentationSettings = {
  boxesEnabled: true,
  boxCornerRadius: 8,
  boxFillAlpha: 0.1,
  boxStrokeWidth: 4,
  classStyles: defaultDemoClassStyles,
  confidenceThreshold: 0.5,
  labelBackgroundAlpha: 0.78,
  labelFontSize: 14,
  labelsEnabled: true,
  maskAlpha: 0.7,
  maskStrokeAlpha: 1,
  maskStrokeWidth: 5,
  masksEnabled: true,
};

export function createDemoPresentation(
  settings: DemoPresentationSettings,
): MediaRendererPresentation {
  return {
    boxStyle: settings.boxesEnabled ? createDemoBoxStyle(settings) : null,
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
          alpha: 0.95,
          color: style.stroke,
          width: settings.boxStrokeWidth,
        },
      };
    },
  };
}

function resolveBoxShape(cornerRadius: number): BoxShape {
  return cornerRadius > 0 ? BoxShape.RoundedRect : BoxShape.Rect;
}

function createDemoMaskStyle(settings: DemoPresentationSettings): MaskStyle {
  return {
    artifactKey: [
      "demo-mask",
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
  settings: DemoPresentationSettings,
) {
  return (detection.confidence ?? 1) >= settings.confidenceThreshold;
}

export function resolveDemoClassStyle(
  settings: DemoPresentationSettings,
  className: string,
) {
  return settings.classStyles[className] ?? fallbackStyle;
}

function resolveClassStyle(
  detection: Detection,
  settings: DemoPresentationSettings,
) {
  return detection.className
    ? resolveDemoClassStyle(settings, detection.className)
    : fallbackStyle;
}

function serializeMaskClassStyles(styles: Record<string, DemoClassStyle>) {
  return Object.entries(styles)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([className, style]) => `${className}:${style.fill}:${style.stroke}`)
    .join("|");
}
