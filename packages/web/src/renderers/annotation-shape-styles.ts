import { ShapeInstructionKind } from "supervision-js-core";
import type {
  BoxCornerStyle,
  EllipseDrawInstruction,
  EllipseShapeInstruction,
  EllipseStyle,
  MarkerStyle,
  PercentageBarDrawInstruction,
  PercentageBarStyle,
  Point,
  Rect,
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
  readonly percentageBarStyle?: PercentageBarStyle | null;
}): ShapeStyle | null {
  const boxCornerStyle = styles.boxCornerStyle ?? null;
  const ellipseStyle = styles.ellipseStyle ?? null;
  const markerStyle = styles.markerStyle ?? null;
  const percentageBarStyle = styles.percentageBarStyle ?? null;

  if (!boxCornerStyle && !ellipseStyle && !markerStyle && !percentageBarStyle) {
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
      const percentageBar = percentageBarStyle?.resolve(detection, context);

      if (percentageBar) {
        lowerPercentageBarInstructions(percentageBar, instructions);
      }

      return instructions.length > 0 ? instructions : undefined;
    },
  };
}

function lowerPercentageBarInstructions(
  bar: PercentageBarDrawInstruction,
  target: ShapeDrawInstruction[],
) {
  if (bar.background || bar.border) {
    target.push({
      closed: true,
      kind: ShapeInstructionKind.Path,
      segments: [rectToPolygonPoints(bar.backgroundRect)],
      ...(bar.background ? { fill: bar.background } : {}),
      ...(bar.border ? { stroke: bar.border } : {}),
    });
  }

  if (bar.fill && bar.valueRect.width > 0) {
    target.push({
      closed: true,
      kind: ShapeInstructionKind.Path,
      segments: [rectToPolygonPoints(bar.valueRect)],
      fill: bar.fill,
    });
  }
}

function rectToPolygonPoints(rect: Rect): Point[] {
  const halfWidth = rect.width / 2;
  const halfHeight = rect.height / 2;

  return [
    { x: rect.x - halfWidth, y: rect.y - halfHeight },
    { x: rect.x + halfWidth, y: rect.y - halfHeight },
    { x: rect.x + halfWidth, y: rect.y + halfHeight },
    { x: rect.x - halfWidth, y: rect.y + halfHeight },
  ];
}

function lowerEllipseInstruction(
  instruction: EllipseDrawInstruction,
): EllipseShapeInstruction {
  return { ...instruction, kind: ShapeInstructionKind.Ellipse };
}
