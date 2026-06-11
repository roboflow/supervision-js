import type { Detection, DetectionFrame, Rect } from "#types/detections";

export enum BoxShape {
  Rect = "rect",
  RoundedRect = "roundedRect",
}

export enum BoxStrokeAlignment {
  Inside = "inside",
  Center = "center",
  Outside = "outside",
}

/**
 * Stroke applied to a rendered detection rectangle.
 *
 * This belongs to presentation styling, not to the underlying detection data.
 */
export interface BoxStrokeStyle {
  readonly color: number;
  readonly alpha: number;
  readonly width: number;
  readonly alignment?: BoxStrokeAlignment;
}

/**
 * Fill applied behind or inside a rendered detection rectangle.
 */
export interface BoxFillStyle {
  readonly color: number;
  readonly alpha: number;
}

/**
 * Per-frame context passed to a box style while resolving draw instructions.
 */
export interface BoxStyleContext {
  readonly mediaTime: number;
  readonly frame: DetectionFrame;
  readonly detectionIndex: number;
}

/**
 * Renderer-neutral box drawing instruction.
 *
 * Style implementations return this shape. Renderer backends translate it into
 * their own drawing commands.
 */
export interface BoxDrawInstruction {
  readonly rect: Rect;
  readonly shape: BoxShape;
  readonly stroke?: BoxStrokeStyle;
  readonly fill?: BoxFillStyle;
  readonly cornerRadius?: number;
}

/**
 * Box presentation contract.
 *
 * A style receives semantic detections and returns renderer-neutral draw
 * instructions. Return `undefined` to skip a detection for this layer.
 */
export interface BoxStyle {
  resolve(
    detection: Detection,
    context: BoxStyleContext,
  ): BoxDrawInstruction | undefined;
}
