import type { Detection } from "#types/detections";
import type { AnnotationStyleContext } from "#types/style";

export type MaskHaloStyleContext = AnnotationStyleContext;

/**
 * Renderer-neutral mask halo drawing instruction.
 *
 * The backend blurs the prepared mask coverage on the GPU, so the glow
 * follows the exact mask silhouette. Each detection's spread is honored:
 * detections requesting different spreads render in separate blur passes.
 */
export interface MaskHaloDrawInstruction {
  /** Peak glow alpha at the silhouette. */
  readonly alpha: number;
  readonly color: number;
  /** Blur radius in screen pixels. */
  readonly spread: number;
}

/**
 * Mask halo presentation contract.
 *
 * The halo renderer consumes semantic detections with masks and returns a
 * glow instruction per detection, or `undefined` to skip one. Halos are
 * presentation only: never pickable or editable, and they reuse the prepared
 * mask artifact without invalidating it.
 */
export interface MaskHaloStyle {
  resolve(
    detection: Detection,
    context: MaskHaloStyleContext,
  ): MaskHaloDrawInstruction | undefined;
}
