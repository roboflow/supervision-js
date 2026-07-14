import type { BoxStrokeStyle } from "#types/box-style";
import type { Detection, Point } from "#types/detections";
import type { AnnotationStyleContext } from "#types/style";

export type PolylineStyleContext = AnnotationStyleContext;

export interface PolylineDrawInstruction {
  readonly points: readonly Point[];
  readonly stroke: BoxStrokeStyle;
}

export interface PolylineStyle {
  resolve(
    detection: Detection,
    context: PolylineStyleContext,
  ): PolylineDrawInstruction | undefined;
}
