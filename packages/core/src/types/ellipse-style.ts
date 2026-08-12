import type { BoxFillStyle, BoxStrokeStyle } from "#types/box-style";
import type { Detection, Point } from "#types/detections";
import type { AnnotationStyleContext } from "#types/style";

export type EllipseStyleContext = AnnotationStyleContext;

/**
 * One ellipse or elliptical arc drawn for a detection, in media coordinates.
 *
 * Omitting both angles draws a closed ellipse. Angles are radians measured
 * from the positive x axis before `rotation` is applied.
 */
export interface EllipseDrawInstruction {
  readonly center: Point;
  readonly radiusX: number;
  readonly radiusY: number;
  /** Rotation in radians around the center. */
  readonly rotation?: number;
  readonly startAngle?: number;
  readonly endAngle?: number;
  readonly fill?: BoxFillStyle;
  readonly stroke?: BoxStrokeStyle;
}

/**
 * Style contract of the `ellipse` annotation renderer.
 *
 * Resolves per detection to the ellipse drawn for it, or `undefined` to skip
 * the detection. Ellipses are presentation only: they are never pickable and
 * never become editable annotations.
 */
export interface EllipseStyle {
  resolve(
    detection: Detection,
    context: EllipseStyleContext,
  ): EllipseDrawInstruction | undefined;
}
