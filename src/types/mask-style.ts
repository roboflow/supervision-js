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

export interface MaskDrawInstruction {
  readonly mask: DetectionMask;
  readonly color: number;
  readonly alpha: number;
}

export interface MaskStyle {
  resolve(
    detection: Detection,
    context: MaskStyleContext,
  ): MaskDrawInstruction | undefined;
}
