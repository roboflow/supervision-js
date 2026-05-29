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

export interface RenderPreparationWorkerFactory {
  createWorker(): Worker;
}

export interface RenderPreparationDiagnostics {
  readonly executionMode: RenderPreparationExecutionMode;
  readonly message: string | null;
  readonly pendingMaskFrameCount: number;
  readonly preparedMaskFrameCount: number;
  readonly workerStatus: RenderPreparationWorkerStatus;
}

export interface RenderPreparationOptions {
  readonly mode?: RenderPreparationMode;
  readonly onDiagnostics?: (diagnostics: RenderPreparationDiagnostics) => void;
  readonly workerFactory?: RenderPreparationWorkerFactory;
}
