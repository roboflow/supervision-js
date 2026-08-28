import type { DetectionMask, Point } from "supervision-js-core";
import type { MaskStrokeStyle } from "supervision-js-core";
import type {
  PreparedIdMaskPlane,
  PreparedMaskFrameKind,
  PreparedRegionMaskCoverageFrame,
} from "./mask-frame-artifact";

export enum MaskPreparationWorkerMessageType {
  Complete = "complete",
  Empty = "empty",
  Error = "error",
  Prepare = "prepare",
}

interface SerializableRasterInstructionBase {
  readonly alpha: number;
  readonly color: number;
  readonly detectionIndex: number;
  /** Semantic mask used only by exact Region renderer coverage. */
  readonly regionCoverageMask?: DetectionMask;
  readonly stroke?: MaskStrokeStyle;
  /** False when this instruction only carries Region coverage. */
  readonly visible?: boolean;
}

export type SerializableMaskInstruction =
  | (SerializableRasterInstructionBase & {
      readonly mask: DetectionMask;
      readonly polygon?: never;
    })
  | (SerializableRasterInstructionBase & {
      readonly mask?: never;
      readonly polygon: {
        readonly height: number;
        readonly points: readonly Point[];
        readonly width: number;
      };
    });

export interface MaskFramePreparationJob {
  readonly instructions: readonly SerializableMaskInstruction[];
  readonly key: string;
  /** Widest id raster to cook; absent, the instructions' own resolution. */
  readonly maxRasterWidth?: number;
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
  readonly height?: number;
  readonly idMaskPlane?: PreparedIdMaskPlane;
  readonly imageBitmap?: ImageBitmap;
  readonly imageData?: ImageData;
  readonly key: string;
  readonly maxStrokeWidth?: number;
  readonly raster?: Uint8Array<ArrayBuffer>;
  readonly regionMaskCoverage?: PreparedRegionMaskCoverageFrame;
  readonly requestId: number;
  readonly strokePalette?: Float32Array<ArrayBuffer>;
  readonly strokeWidths?: Float32Array<ArrayBuffer>;
  readonly type: MaskPreparationWorkerMessageType.Complete;
  readonly width?: number;
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
