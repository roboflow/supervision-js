import type { BoxFillStyle, BoxStrokeStyle } from "#types/box-style";
import type { Detection, Point } from "#types/detections";
import type { AnnotationStyleContext } from "#types/style";

export type PolygonStyleContext = AnnotationStyleContext;

export interface PolygonDrawInstruction {
  readonly points: readonly Point[];
  readonly fill?: BoxFillStyle;
  readonly stroke?: BoxStrokeStyle;
}

export interface PolygonStyle {
  resolve(
    detection: Detection,
    context: PolygonStyleContext,
  ): PolygonDrawInstruction | undefined;
}
