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

export interface RenderPreparationWorkerFactory {
  createWorker(): Worker;
}

export interface RenderPreparationArtifactDiagnostics {
  readonly kind: RenderPreparationArtifactKind;
  readonly pendingCount: number;
  readonly preparedCount: number;
}

export interface RenderPreparationDiagnostics {
  readonly artifacts: readonly RenderPreparationArtifactDiagnostics[];
  readonly executionMode: RenderPreparationExecutionMode;
  readonly message: string | null;
  readonly workerStatus: RenderPreparationWorkerStatus;
}

export interface RenderPreparationOptions {
  readonly mode?: RenderPreparationMode;
  readonly onDiagnostics?: (diagnostics: RenderPreparationDiagnostics) => void;
  readonly workerFactory?: RenderPreparationWorkerFactory;
}
