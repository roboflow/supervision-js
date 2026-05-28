import type { Detection, DetectionFrame, Rect } from "#types/detections";

export enum BoxShape {
  Rect = "rect",
  RoundedRect = "roundedRect",
}

export interface BoxStrokeStyle {
  readonly color: number;
  readonly alpha: number;
  readonly width: number;
}

export interface BoxFillStyle {
  readonly color: number;
  readonly alpha: number;
}

export interface BoxStyleContext {
  readonly mediaTime: number;
  readonly frame: DetectionFrame;
  readonly detectionIndex: number;
}

export interface BoxDrawInstruction {
  readonly rect: Rect;
  readonly shape: BoxShape;
  readonly stroke?: BoxStrokeStyle;
  readonly fill?: BoxFillStyle;
  readonly cornerRadius?: number;
}

export interface BoxStyle {
  resolve(
    detection: Detection,
    context: BoxStyleContext,
  ): BoxDrawInstruction | undefined;
}
