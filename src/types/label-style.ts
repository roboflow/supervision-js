import type { Detection, DetectionFrame, Rect } from "#types/detections";

export interface LabelStyleContext {
  readonly mediaTime: number;
  readonly frame: DetectionFrame;
  readonly detectionIndex: number;
}

export interface LabelTextStyle {
  readonly color: number;
  readonly alpha?: number;
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly fontWeight?: string | number;
}

export interface LabelBackgroundStyle {
  readonly color: number;
  readonly alpha: number;
  readonly cornerRadius?: number;
  readonly paddingX?: number;
  readonly paddingY?: number;
}

export interface LabelDrawInstruction {
  readonly rect: Rect;
  readonly text: string;
  readonly textStyle?: LabelTextStyle;
  readonly background?: LabelBackgroundStyle;
  readonly offsetX?: number;
  readonly offsetY?: number;
}

export interface LabelStyle {
  resolve(
    detection: Detection,
    context: LabelStyleContext,
  ): LabelDrawInstruction | undefined;
}
