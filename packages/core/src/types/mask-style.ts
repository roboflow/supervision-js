import type { Detection, DetectionMask } from "#types/detections";
import type { AnnotationStyleContext } from "#types/style";

export type MaskStyleContext = AnnotationStyleContext;

export enum MaskRenderMode {
  FillAndStroke = "fillAndStroke",
  FillOnly = "fillOnly",
  StrokeOnly = "strokeOnly",
}

/**
 * Optional outline applied around prepared mask pixels.
 */
export interface MaskStrokeStyle {
  readonly color: number;
  readonly alpha: number;
  readonly width: number;
}

/**
 * Mask outline options accepted by built-in mask styles.
 *
 * Missing values are resolved from the mask color and renderer-friendly
 * defaults before draw instructions reach a renderer backend.
 */
export interface MaskStrokeStyleOptions {
  readonly color?: number;
  readonly alpha?: number;
  readonly width?: number;
}

/**
 * Renderer-neutral mask drawing instruction.
 *
 * The `mask` remains semantic detection data. Renderer backends may prepare it
 * into ID-mask artifacts, textures, or other backend-specific resources.
 */
export interface MaskDrawInstruction {
  readonly mask: DetectionMask;
  readonly color: number;
  readonly alpha: number;
  readonly stroke?: MaskStrokeStyle;
}

/**
 * Mask presentation contract.
 *
 * Styles decide which detections are rendered as masks and how they should look.
 * Expensive mask preparation is owned by the renderer, not by style objects.
 */
export interface MaskStyle {
  /**
   * Stable identity for the prepared mask pixels. Exclude presentation-only
   * controls such as global opacity so cached mask artifacts can be reused.
   */
  readonly artifactKey?: string;
  /**
   * Presentation opacity applied by the renderer after the mask artifact is
   * prepared. Use this for cheap live opacity updates.
   */
  readonly opacity?: number;
  resolve(
    detection: Detection,
    context: MaskStyleContext,
  ): MaskDrawInstruction | undefined;
}
