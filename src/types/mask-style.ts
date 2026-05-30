import type {
  Detection,
  DetectionFrame,
  DetectionMask,
} from "#types/detections";

export interface MaskStyleContext {
  readonly mediaTime: number;
  readonly frame: DetectionFrame;
  readonly detectionIndex: number;
}

export interface MaskStrokeStyle {
  readonly color: number;
  readonly alpha: number;
  readonly width: number;
}

export interface MaskDrawInstruction {
  readonly mask: DetectionMask;
  readonly color: number;
  readonly alpha: number;
  readonly stroke?: MaskStrokeStyle;
}

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
