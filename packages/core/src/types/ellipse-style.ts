import type { FillStyle, OpenStrokeStyle, StrokeStyle } from "#types/paint-style";
import type { Detection, Point } from "#types/detections";
import type { AnnotationStyleContext } from "#types/style";

export type EllipseStyleContext = AnnotationStyleContext;

/**
 * One ellipse or elliptical arc drawn for a detection, in media coordinates.
 *
 * Omitting both angles draws a closed ellipse. Angles are radians measured
 * from the positive x axis before `rotation` is applied.
 */
interface EllipseDrawInstructionBase {
  readonly center: Point;
  readonly radiusX: number;
  readonly radiusY: number;
  /** Rotation in radians around the center. */
  readonly rotation?: number;
}

export interface ClosedEllipseDrawInstruction
  extends EllipseDrawInstructionBase {
  readonly startAngle?: never;
  readonly endAngle?: never;
  readonly fill?: FillStyle;
  readonly stroke?: StrokeStyle;
}

export interface EllipseArcDrawInstruction extends EllipseDrawInstructionBase {
  readonly startAngle?: number;
  readonly endAngle?: number;
  readonly fill?: never;
  readonly stroke?: OpenStrokeStyle;
}

export type EllipseDrawInstruction =
  | ClosedEllipseDrawInstruction
  | EllipseArcDrawInstruction;

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
