import { ShapeInstructionKind } from "supervision-js-core";
import type {
  EllipseDrawInstruction,
  EllipseShapeInstruction,
  EllipseStyle,
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
      const ellipse = ellipseStyle.resolve(detection, context);

      return ellipse ? [lowerEllipseInstruction(ellipse)] : undefined;
    },
  };
}

function lowerEllipseInstruction(
  instruction: EllipseDrawInstruction,
): EllipseShapeInstruction {
  return { ...instruction, kind: ShapeInstructionKind.Ellipse };
}
