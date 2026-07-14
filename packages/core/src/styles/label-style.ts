import { resolveStyleValue } from "#styles/style-value";
import type { Detection } from "#types/detections";
import type {
  LabelBackgroundStyle,
  LabelDrawInstruction,
  LabelOffsetStyle,
  LabelStyle,
  LabelStyleContext,
  LabelTextStyle,
} from "#types/label-style";
import { LabelPlacement } from "#types/label-style";
import { LabelVisibilityMode } from "#types/label-style";
import { getDetectionRect } from "#utils/geometry";
import { lightenColor, resolveContrastTextColor } from "#utils/color";
import type {
  DetectionStylePredicate,
  DetectionStyleValue,
} from "#types/style";

export interface BaseLabelStyleOptions {
  /**
   * Label background style. Pass a resolver for per-class label backgrounds.
   */
  readonly background?: DetectionStyleValue<
    Partial<LabelBackgroundStyle> | undefined,
    LabelStyleContext
  >;
  /**
   * Include confidence percentage in the default label text.
   */
  readonly includeConfidence?: boolean;
  /**
   * Label offset in media pixels. Pass a resolver for per-detection label
   * placement.
   */
  readonly offset?: DetectionStyleValue<
    LabelOffsetStyle | null | undefined,
    LabelStyleContext
  >;
  /**
   * Compatibility shorthand for `offset: { y }`.
   *
   * Prefer `offset` for new code.
   */
  readonly offsetY?: number;
  /**
   * Label placement relative to the detection rectangle.
   */
  readonly placement?: DetectionStyleValue<LabelPlacement, LabelStyleContext>;
  /**
   * Custom label text. Return undefined to fall back to the default class label.
   */
  readonly text?: DetectionStyleValue<string | undefined, LabelStyleContext>;
  /**
   * Label text style. Pass a resolver for per-class text colors or sizes.
   */
  readonly textStyle?: DetectionStyleValue<
    Partial<LabelTextStyle> | undefined,
    LabelStyleContext
  >;
  /**
   * Return false to skip rendering a detection in this label style.
   */
  readonly shouldRender?: DetectionStylePredicate<LabelStyleContext>;
  readonly visibilityMode?: LabelVisibilityMode;
}

/**
 * Default label style.
 *
 * Resolves labels from `className`, `metadata.label`, or a custom text
 * resolver, optionally including confidence.
 */
export class BaseLabelStyle implements LabelStyle {
  private readonly includeConfidence: boolean;
  private readonly offsetY: number;
  private readonly options: BaseLabelStyleOptions;

  constructor(options: BaseLabelStyleOptions = {}) {
    this.options = options;
    this.includeConfidence = options.includeConfidence ?? false;
    this.offsetY = options.offsetY ?? 0;
  }

  resolve(
    detection: Detection,
    context: LabelStyleContext,
  ): LabelDrawInstruction | undefined {
    if (
      !getDetectionRect(detection) ||
      context.hidden ||
      (this.options.visibilityMode === LabelVisibilityMode.HoveredOnly &&
        !context.hovered) ||
      this.options.shouldRender?.(detection, context) === false
    ) {
      return undefined;
    }

    const text =
      resolveStyleValue(this.options.text, detection, context) ??
      formatDetectionLabel(detection, this.includeConfidence);

    if (!text) {
      return undefined;
    }

    const background = this.resolveBackground(detection, context);

    return {
      background,
      ...this.resolveOffset(detection, context),
      placement: this.resolvePlacement(detection, context),
      rect: getDetectionRect(detection)!,
      text,
      textStyle: this.resolveTextStyle(detection, context, background),
    };
  }

  private resolveBackground(
    detection: Detection,
    context: LabelStyleContext,
  ): LabelBackgroundStyle {
    const background = resolveStyleValue(
      this.options.background,
      detection,
      context,
    );

    return {
      alpha: background?.alpha ?? 0.72,
      color: context.hovered
        ? lightenColor(background?.color ?? 0x111827)
        : (background?.color ?? 0x111827),
      cornerRadius: background?.cornerRadius ?? 4,
      paddingX: background?.paddingX ?? 6,
      paddingY: background?.paddingY ?? 3,
    };
  }

  private resolveTextStyle(
    detection: Detection,
    context: LabelStyleContext,
    background: LabelBackgroundStyle,
  ): LabelTextStyle {
    const textStyle = resolveStyleValue(
      this.options.textStyle,
      detection,
      context,
    );

    return {
      alpha: textStyle?.alpha ?? 1,
      color: textStyle?.color ?? resolveContrastTextColor(background.color),
      fontFamily: textStyle?.fontFamily ?? "Inter, sans-serif",
      fontSize: textStyle?.fontSize ?? 13,
      fontWeight: textStyle?.fontWeight ?? "600",
    };
  }

  private resolveOffset(
    detection: Detection,
    context: LabelStyleContext,
  ): Pick<LabelDrawInstruction, "offsetX" | "offsetY"> {
    const offset = resolveStyleValue(this.options.offset, detection, context);

    if (offset === null) {
      return {};
    }

    return {
      ...(offset?.x === undefined ? {} : { offsetX: offset.x }),
      offsetY: offset?.y ?? this.offsetY,
    };
  }

  private resolvePlacement(
    detection: Detection,
    context: LabelStyleContext,
  ): LabelPlacement {
    return (
      resolveStyleValue(this.options.placement, detection, context) ??
      LabelPlacement.Top
    );
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
