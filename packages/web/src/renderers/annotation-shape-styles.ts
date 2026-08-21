import { ShapeInstructionKind } from "supervision-js-core";
import type {
  BoxCornerStyle,
  EllipseDrawInstruction,
  EllipseShapeInstruction,
  EllipseStyle,
  MarkerStyle,
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
  readonly boxCornerStyle?: BoxCornerStyle | null;
  readonly ellipseStyle?: EllipseStyle | null;
  readonly markerStyle?: MarkerStyle | null;
}): ShapeStyle | null {
  const boxCornerStyle = styles.boxCornerStyle ?? null;
  const ellipseStyle = styles.ellipseStyle ?? null;
  const markerStyle = styles.markerStyle ?? null;

  if (!boxCornerStyle && !ellipseStyle && !markerStyle) {
    return null;
  }

  return {
    resolve(detection, context) {
      const instructions: ShapeDrawInstruction[] = [];
      const boxCorners = boxCornerStyle?.resolve(detection, context);

      if (boxCorners) {
        instructions.push({
          closed: false,
          kind: ShapeInstructionKind.Path,
          segments: boxCorners.segments,
          stroke: boxCorners.stroke,
        });
      }
      const marker = markerStyle?.resolve(detection, context);

      if (marker) {
        instructions.push({ kind: ShapeInstructionKind.Marker, ...marker });
      }
      const ellipse = ellipseStyle?.resolve(detection, context);

      if (ellipse) {
        instructions.push(lowerEllipseInstruction(ellipse));
      }

      return instructions.length > 0 ? instructions : undefined;
    },
  };
}

function lowerEllipseInstruction(
  instruction: EllipseDrawInstruction,
): EllipseShapeInstruction {
  return { ...instruction, kind: ShapeInstructionKind.Ellipse };
}
