import type { Detection, Rect } from "#types/detections";
import type { AnnotationStyleContext } from "#types/style";

export enum LabelPlacement {
  Top = "top",
  Bottom = "bottom",
  InsideTop = "insideTop",
  InsideBottom = "insideBottom",
  Center = "center",
}

export enum LabelVisibilityMode {
  Always = "always",
  HoveredOnly = "hoveredOnly",
}

export type LabelStyleContext = AnnotationStyleContext;

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
  /** Round only the two top corners, matching editor label pills. */
  readonly topCornersOnly?: boolean;
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
  readonly placement?: LabelPlacement;
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
