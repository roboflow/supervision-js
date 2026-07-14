import type { BoxFillStyle, BoxStrokeStyle } from "#types/box-style";
import type { Detection, Point } from "#types/detections";
import type { AnnotationStyleContext } from "#types/style";

export type KeypointStyleContext = AnnotationStyleContext;

export enum KeypointMarkerShape {
  Circle = "circle",
  Cross = "cross",
}

export interface KeypointMarkerDrawInstruction {
  readonly index: number;
  readonly point: Point;
  readonly radius: number;
  readonly shape: KeypointMarkerShape;
  readonly fill?: BoxFillStyle;
  readonly stroke?: BoxStrokeStyle;
}

export interface KeypointEdgeDrawInstruction {
  readonly from: Point;
  readonly to: Point;
  readonly stroke: BoxStrokeStyle;
  readonly shadowStroke?: BoxStrokeStyle;
}

export interface KeypointDrawInstruction {
  readonly markers: readonly KeypointMarkerDrawInstruction[];
  readonly edges: readonly KeypointEdgeDrawInstruction[];
}

export interface KeypointStyle {
  resolve(
    detection: Detection,
    context: KeypointStyleContext,
  ): KeypointDrawInstruction | undefined;
}
