import type {
  DetectionFrame,
  DetectionPostProcessor,
  WritableDetectionFrameSource,
} from "supervision-js-core";

export enum DetectionPostProcessingMode {
  Auto = "auto",
  Worker = "worker",
  MainThread = "mainThread",
}

export interface DetectionPostProcessingWorkerFactory {
  createWorker(): Worker;
}

export interface DetectionPostProcessingDiagnostics {
  readonly activeTrackCount: number;
  readonly confirmedTrackCount: number;
  readonly errorMessage: string | null;
  readonly executionMode: "worker" | "mainThread" | null;
  readonly lastFrameDurationMs: number | null;
  readonly nextFrameIndex: number;
  readonly pendingFrameCount: number;
  readonly processedFrameCount: number;
  readonly trackedDetectionCount: number;
}

export interface DetectionPostProcessingAppendResult {
  readonly acceptedFrameCount: number;
  readonly processedFrameCount: number;
  readonly processedFrames: readonly DetectionFrame[];
}

export interface DetectionPostProcessingPipelineOptions {
  /** Serializable built-in processors, applied in declaration order. */
  readonly processors: readonly DetectionPostProcessor[];
  /**
   * Update derived detection fields in place. Defaults to `true`.
   * Set to `false` for immutable inputs or an untouched raw view.
   */
  readonly mutateInput?: boolean;
  /** First causal frame index expected from the inference stream. */
  readonly startFrameIndex?: number;
  /** Hard bound on out-of-order frames retained while a gap is open. */
  readonly maxPendingFrames?: number;
  readonly mode?: DetectionPostProcessingMode;
  readonly workerFactory?: DetectionPostProcessingWorkerFactory;
  /** Optional cold output source. Processed frames are appended one at a time. */
  readonly output?: WritableDetectionFrameSource;
  readonly onDiagnostics?: (
    diagnostics: DetectionPostProcessingDiagnostics,
  ) => void;
  readonly onFrame?: (frame: DetectionFrame) => void;
}

export interface DetectionPostProcessingPipeline {
  appendFrames(
    frames: readonly DetectionFrame[],
  ): Promise<DetectionPostProcessingAppendResult>;
  getDiagnostics(): DetectionPostProcessingDiagnostics;
  reset(options?: { readonly startFrameIndex?: number }): Promise<void>;
  destroy(): void;
}

export interface TrackingExecutionResult {
  readonly activeTrackCount: number;
  readonly assignments: readonly {
    readonly detectionIndex: number;
    readonly trackerId: number;
  }[];
  readonly confirmedTrackCount: number;
  readonly durationMs: number;
}
