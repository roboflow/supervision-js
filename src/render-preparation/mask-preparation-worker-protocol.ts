import type { DetectionMask } from "#types/detections";
import type { MaskStrokeStyle } from "#types/mask-style";
import type { PreparedMaskFrameKind } from "./mask-frame-artifact";

export enum MaskPreparationWorkerMessageType {
  Complete = "complete",
  Empty = "empty",
  Error = "error",
  Prepare = "prepare",
}

export interface SerializableMaskInstruction {
  readonly alpha: number;
  readonly color: number;
  readonly mask: DetectionMask;
  readonly stroke?: MaskStrokeStyle;
}

export interface MaskFramePreparationJob {
  readonly instructions: readonly SerializableMaskInstruction[];
  readonly key: string;
}

export interface MaskPreparationWorkerPrepareMessage {
  readonly job: MaskFramePreparationJob;
  readonly requestId: number;
  readonly type: MaskPreparationWorkerMessageType.Prepare;
}

export interface MaskPreparationWorkerCompleteMessage {
  readonly artifactKind?: PreparedMaskFrameKind;
  readonly fillPalette?: Float32Array<ArrayBuffer>;
  readonly hasStroke?: boolean;
  readonly imageBitmap?: ImageBitmap;
  readonly imageData?: ImageData;
  readonly key: string;
  readonly png?: Uint8Array<ArrayBuffer>;
  readonly requestId: number;
  readonly strokePalette?: Float32Array<ArrayBuffer>;
  readonly type: MaskPreparationWorkerMessageType.Complete;
}

export interface MaskPreparationWorkerEmptyMessage {
  readonly key: string;
  readonly requestId: number;
  readonly type: MaskPreparationWorkerMessageType.Empty;
}

export interface MaskPreparationWorkerErrorMessage {
  readonly error: string;
  readonly key: string;
  readonly requestId: number;
  readonly type: MaskPreparationWorkerMessageType.Error;
}

export type MaskPreparationWorkerRequest = MaskPreparationWorkerPrepareMessage;

export type MaskPreparationWorkerResponse =
  | MaskPreparationWorkerCompleteMessage
  | MaskPreparationWorkerEmptyMessage
  | MaskPreparationWorkerErrorMessage;
