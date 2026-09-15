import type { Detection, Rect } from "#types/detections";
import type { FillStyle, StrokeStyle } from "#types/paint-style";
import type {
  AnnotationStyleContext,
  DetectionStylePredicate,
  DetectionStyleValue,
} from "#types/style";

export enum PercentageBarPlacement {
  Top = "top",
  Bottom = "bottom",
  InsideTop = "insideTop",
  InsideBottom = "insideBottom",
}

export type PercentageBarStyleContext = AnnotationStyleContext;

/**
 * Renderer-neutral percentage bar draw instruction.
 */
export interface PercentageBarDrawInstruction {
  readonly backgroundRect: Rect;
  readonly valueRect: Rect;
  readonly background?: FillStyle;
  readonly fill?: FillStyle;
  readonly border?: StrokeStyle;
  /** Normalized value in [0, 1]. */
  readonly value: number;
}

export interface BasePercentageBarStyleOptions {
  /**
   * Numeric value resolver in [0, 1]. Defaults to `detection.confidence ?? 0`.
   */
  readonly value?: DetectionStyleValue<number, PercentageBarStyleContext>;
  /**
   * Bar height in media pixels. Defaults to 8.
   */
  readonly height?: DetectionStyleValue<number, PercentageBarStyleContext>;
  /**
   * Explicit bar width in media pixels. Defaults to the detection rectangle width.
   */
  readonly width?: DetectionStyleValue<
    number | undefined,
    PercentageBarStyleContext
  >;
  /**
   * Placement relative to the detection bounding box. Defaults to `top`.
   */
  readonly placement?: DetectionStyleValue<
    PercentageBarPlacement,
    PercentageBarStyleContext
  >;
  /**
   * Bar offset in media pixels.
   */
  readonly offset?: DetectionStyleValue<
    { readonly x?: number; readonly y?: number } | null | undefined,
    PercentageBarStyleContext
  >;
  /**
   * Compatibility shorthand for `offset: { y }`.
   */
  readonly offsetY?: number;
  /**
   * Background container fill. Pass `null` to disable the background.
   */
  readonly background?: DetectionStyleValue<
    Partial<FillStyle> | null,
    PercentageBarStyleContext
  >;
  /**
   * Progress fill style. Pass a resolver for per-class or dynamic colors.
   */
  readonly fill?: DetectionStyleValue<
    Partial<FillStyle> | null,
    PercentageBarStyleContext
  >;
  /**
   * Outer border stroke. Pass `null` or omit to disable.
   */
  readonly border?: DetectionStyleValue<
    Partial<StrokeStyle> | null,
    PercentageBarStyleContext
  >;
  /**
   * Return false to skip rendering a detection in this percentage bar style.
   */
  readonly shouldRender?: DetectionStylePredicate<PercentageBarStyleContext>;
}

/**
 * Percentage bar presentation contract.
 *
 * Converts a detection into renderer-neutral progress bar geometry and styles.
 */
export interface PercentageBarStyle {
  resolve(
    detection: Detection,
    context: PercentageBarStyleContext,
  ): PercentageBarDrawInstruction | undefined;
}
