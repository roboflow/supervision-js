import type { BoxFillStyle, BoxStrokeStyle } from "#types/box-style";
import type { Detection, Point } from "#types/detections";
import type { AnnotationStyleContext } from "#types/style";

export type OrientedBoxStyleContext = AnnotationStyleContext;

/**
 * Renderer-neutral instruction for one oriented quadrilateral.
 *
 * `points` are the same four media-pixel vertices carried by
 * `Detection.orientedBox`. This is drawn through the same closed-path
 * fill/stroke primitives as a polygon; it is not a `Rect` and never implies
 * that a rectangle is silently rotatable.
 */
export interface OrientedBoxDrawInstruction {
  readonly points: readonly [Point, Point, Point, Point];
  readonly fill?: BoxFillStyle;
  readonly stroke?: BoxStrokeStyle;
}

/**
 * Style contract of the `orientedBox` annotation renderer.
 *
 * The renderer is presentation-only, like `box-corners` and `ellipse`: it
 * never changes semantic detection geometry, picking, or editing.
 */
export interface OrientedBoxStyle {
  resolve(
    detection: Detection,
    context: OrientedBoxStyleContext,
  ): OrientedBoxDrawInstruction | undefined;
}
