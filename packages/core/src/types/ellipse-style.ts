import type { Detection } from "#types/detections";
import type {
  ClosedEllipseShapeInstruction,
  EllipseArcShapeInstruction,
} from "#types/shape-style";
import type { AnnotationStyleContext } from "#types/style";

export type EllipseStyleContext = AnnotationStyleContext;

/**
 * One closed ellipse drawn for a detection, in media coordinates.
 *
 * The annotation renderer omits only the internal shape discriminator; all
 * geometry and paint constraints come from the shared ellipse primitive.
 */
export type ClosedEllipseDrawInstruction = Omit<
  ClosedEllipseShapeInstruction,
  "kind"
>;

/**
 * One elliptical arc drawn for a detection, in media coordinates.
 *
 * Angles are radians measured from the positive x axis before `rotation` is
 * applied.
 */
export type EllipseArcDrawInstruction = Omit<
  EllipseArcShapeInstruction,
  "kind"
>;

export type EllipseDrawInstruction =
  ClosedEllipseDrawInstruction | EllipseArcDrawInstruction;

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
