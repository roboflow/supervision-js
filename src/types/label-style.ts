import type { Detection, DetectionFrame, Rect } from "#types/detections";

export interface LabelStyleContext {
  readonly mediaTime: number;
  readonly frame: DetectionFrame;
  readonly detectionIndex: number;
}

/**
 * Text styling for a rendered detection label.
 */
export interface LabelTextStyle {
  readonly color: number;
  readonly alpha?: number;
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly fontWeight?: string | number;
}

/**
 * Background styling for a rendered detection label.
 */
export interface LabelBackgroundStyle {
  readonly color: number;
  readonly alpha: number;
  readonly cornerRadius?: number;
  readonly paddingX?: number;
  readonly paddingY?: number;
}

/**
 * Label offset in media pixels.
 */
export interface LabelOffsetStyle {
  readonly x?: number;
  readonly y?: number;
}

/**
 * Renderer-neutral label drawing instruction.
 */
export interface LabelDrawInstruction {
  readonly rect: Rect;
  readonly text: string;
  readonly textStyle?: LabelTextStyle;
  readonly background?: LabelBackgroundStyle;
  readonly offsetX?: number;
  readonly offsetY?: number;
}

/**
 * Label presentation contract.
 *
 * This is the `supervision-js` equivalent of a label annotator: it converts one
 * semantic detection into optional label text and renderer-neutral style data.
 */
export interface LabelStyle {
  resolve(
    detection: Detection,
    context: LabelStyleContext,
  ): LabelDrawInstruction | undefined;
}
