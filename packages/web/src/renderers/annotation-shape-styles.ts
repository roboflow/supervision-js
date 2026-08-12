import { ShapeInstructionKind } from "supervision-js-core";
import type {
  EllipseStyle,
  ShapeDrawInstruction,
  ShapeStyle,
} from "supervision-js-core";

/**
 * Bridges public annotation renderer kinds onto the internal vector-layer
 * shape pipeline.
 *
 * Each shape-backed renderer kind resolves its own public instruction per
 * detection; this adapter lowers those instructions into the internal
 * renderer-neutral shape vocabulary and concatenates them into the single
 * shape style the vector layer consumes. Kinds stay independent: a kind that
 * resolves nothing for a detection simply contributes no instructions.
 */
export function resolveAnnotationShapeStyle(styles: {
  readonly ellipseStyle?: EllipseStyle | null;
}): ShapeStyle | null {
  const ellipseStyle = styles.ellipseStyle ?? null;

  if (!ellipseStyle) {
    return null;
  }

  return {
    resolve(detection, context) {
      const instructions: ShapeDrawInstruction[] = [];
      const ellipse = ellipseStyle.resolve(detection, context);

      if (ellipse) {
        const base = {
          center: ellipse.center,
          kind: ShapeInstructionKind.Ellipse,
          radiusX: ellipse.radiusX,
          radiusY: ellipse.radiusY,
          ...(ellipse.rotation === undefined
            ? {}
            : { rotation: ellipse.rotation }),
        } as const;

        if (
          ellipse.startAngle !== undefined &&
          ellipse.endAngle !== undefined
        ) {
          instructions.push({
            ...base,
            endAngle: ellipse.endAngle,
            startAngle: ellipse.startAngle,
            ...(ellipse.stroke === undefined ? {} : { stroke: ellipse.stroke }),
          });
        } else {
          instructions.push({
            ...base,
            ...(ellipse.fill === undefined ? {} : { fill: ellipse.fill }),
            ...(ellipse.stroke === undefined ? {} : { stroke: ellipse.stroke }),
          });
        }
      }

      return instructions.length > 0 ? instructions : undefined;
    },
  };
}
