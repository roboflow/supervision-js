import type { Detection } from "#types/detections";
import type {
  LabelBackgroundStyle,
  LabelDrawInstruction,
  LabelStyle,
  LabelTextStyle,
} from "#types/label-style";

export interface BaseLabelStyleOptions {
  readonly background?: Partial<LabelBackgroundStyle>;
  readonly includeConfidence?: boolean;
  readonly offsetY?: number;
  readonly text?: (detection: Detection) => string | undefined;
  readonly textStyle?: Partial<LabelTextStyle>;
}

export class BaseLabelStyle implements LabelStyle {
  private readonly background: LabelBackgroundStyle;
  private readonly includeConfidence: boolean;
  private readonly offsetY: number;
  private readonly resolveText:
    | ((detection: Detection) => string | undefined)
    | undefined;
  private readonly textStyle: LabelTextStyle;

  constructor(options: BaseLabelStyleOptions = {}) {
    this.background = {
      alpha: options.background?.alpha ?? 0.72,
      color: options.background?.color ?? 0x111827,
      cornerRadius: options.background?.cornerRadius ?? 4,
      paddingX: options.background?.paddingX ?? 6,
      paddingY: options.background?.paddingY ?? 3,
    };
    this.includeConfidence = options.includeConfidence ?? false;
    this.offsetY = options.offsetY ?? 0;
    this.resolveText = options.text;
    this.textStyle = {
      alpha: options.textStyle?.alpha ?? 1,
      color: options.textStyle?.color ?? 0xffffff,
      fontFamily: options.textStyle?.fontFamily ?? "Inter, sans-serif",
      fontSize: options.textStyle?.fontSize ?? 13,
      fontWeight: options.textStyle?.fontWeight ?? "600",
    };
  }

  resolve(detection: Detection): LabelDrawInstruction | undefined {
    if (!detection.rect) {
      return undefined;
    }

    const text =
      this.resolveText?.(detection) ??
      formatDetectionLabel(detection, this.includeConfidence);

    if (!text) {
      return undefined;
    }

    return {
      background: this.background,
      offsetY: this.offsetY,
      rect: detection.rect,
      text,
      textStyle: this.textStyle,
    };
  }
}

function formatDetectionLabel(
  detection: Detection,
  includeConfidence: boolean,
) {
  const label =
    detection.className ??
    (typeof detection.metadata?.label === "string"
      ? detection.metadata.label
      : undefined);

  if (!label) {
    return undefined;
  }

  if (!includeConfidence || detection.confidence === undefined) {
    return label;
  }

  return `${label} ${Math.round(detection.confidence * 100)}%`;
}
