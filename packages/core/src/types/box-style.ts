import type { Detection, Rect } from "#types/detections";
import type { FillStyle, StrokeStyle } from "#types/paint-style";
import type { AnnotationStyleContext } from "#types/style";

export { StrokeAlignment as BoxStrokeAlignment } from "#types/paint-style";

export enum BoxShape {
  Rect = "rect",
  RoundedRect = "roundedRect",
}

/**
 * Stroke applied to a rendered detection rectangle.
 *
 * This belongs to presentation styling, not to the underlying detection data.
 */
export type BoxStrokeStyle = StrokeStyle;

/**
 * Fill applied behind or inside a rendered detection rectangle.
 */
export type BoxFillStyle = FillStyle;

/**
 * Per-frame context passed to a box style while resolving draw instructions.
 */
export type BoxStyleContext = AnnotationStyleContext;

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
