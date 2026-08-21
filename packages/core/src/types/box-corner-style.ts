import type { Detection, Point } from "#types/detections";
import type { OpenStrokeStyle } from "#types/paint-style";
import type {
  AnnotationStyleContext,
  DetectionStylePredicate,
  DetectionStyleValue,
} from "#types/style";

export type BoxCornerStyleContext = AnnotationStyleContext;

/** Four open corner segments derived from one detection rectangle. */
export interface BoxCornerDrawInstruction {
  readonly segments: readonly (readonly Point[])[];
  readonly stroke: OpenStrokeStyle;
}

/**
 * Style contract of the `box-corners` annotation renderer.
 *
 * The renderer is presentation-only: it never changes semantic detection
 * geometry, picking, or editing. Segment coordinates are in media space while
 * the stroke keeps the usual screen-space width semantics.
 */
export interface BoxCornerStyle {
  resolve(
    detection: Detection,
    context: BoxCornerStyleContext,
  ): BoxCornerDrawInstruction | undefined;
}

export interface BaseBoxCornerStyleOptions {
  /**
   * Visible length of each corner segment in screen pixels. The renderer
   * converts it to media space so the decoration stays legible while zooming.
   */
  readonly length?: DetectionStyleValue<number, BoxCornerStyleContext>;
  /** Open-path stroke used by each of the four corners. */
  readonly stroke?: DetectionStyleValue<
    Partial<OpenStrokeStyle> | null,
    BoxCornerStyleContext
  >;
  /** Return false to skip a detection. */
  readonly shouldRender?: DetectionStylePredicate<BoxCornerStyleContext>;
}
