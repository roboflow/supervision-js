export enum RenderPreparationMode {
  Auto = "auto",
  MainThread = "mainThread",
  Worker = "worker",
}

export enum RenderPreparationExecutionMode {
  MainThread = "mainThread",
  Worker = "worker",
}

export enum RenderPreparationWorkerStatus {
  Disabled = "disabled",
  Ready = "ready",
  Unavailable = "unavailable",
  Error = "error",
}

export enum RenderPreparationArtifactKind {
  MaskFrame = "maskFrame",
}

export enum RenderPreparationArtifactFrameStatus {
  Disabled = "disabled",
  Empty = "empty",
  Pending = "pending",
  Prepared = "prepared",
}

export interface RenderPreparationWorkerFactory {
  createWorker(): Worker;
}

export interface RenderPreparationMaskFrameOptions {
  readonly maxCacheFrameCount?: number;
  readonly maxPendingFrameCount?: number;
  readonly prefetchFrameCount?: number;
  readonly scheduleBatchSize?: number;
  readonly scanIntervalSeconds?: number;
}

export interface RenderPreparationActiveFrameDiagnostics {
  readonly key: string;
  readonly mediaTime: number;
  readonly status: RenderPreparationArtifactFrameStatus;
}

export interface RenderPreparationArtifactDiagnostics {
  readonly activeFrame?: RenderPreparationActiveFrameDiagnostics | null;
  readonly kind: RenderPreparationArtifactKind;
  readonly maxPendingCount?: number;
  readonly maxPreparedCount?: number;
  readonly pendingCount: number;
  readonly preparedAheadFrameCount?: number;
  readonly preparedAheadSeconds?: number;
  readonly prefetchCount?: number;
  readonly preparedCount: number;
  readonly scheduleBatchSize?: number;
}

export interface RenderPreparationDiagnostics {
  readonly artifacts: readonly RenderPreparationArtifactDiagnostics[];
  readonly executionMode: RenderPreparationExecutionMode;
  readonly message: string | null;
  readonly workerStatus: RenderPreparationWorkerStatus;
}

export interface RenderPreparationOptions {
  readonly maskFrame?: RenderPreparationMaskFrameOptions;
  readonly mode?: RenderPreparationMode;
  readonly onDiagnostics?: (diagnostics: RenderPreparationDiagnostics) => void;
  readonly workerFactory?: RenderPreparationWorkerFactory;
}
