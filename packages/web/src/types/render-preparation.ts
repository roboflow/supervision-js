/**
 * Where renderer-owned artifact preparation should run.
 */
export enum RenderPreparationMode {
  /**
   * Prefer workers when available, with a main-thread fallback.
   */
  Auto = "auto",
  /**
   * Prepare artifacts on the main thread.
   */
  MainThread = "mainThread",
  /**
   * Require preparation through the configured/default worker factory.
   * Worker creation and runtime failures reject instead of falling back.
   */
  Worker = "worker",
}

/**
 * Actual execution mode selected after worker availability is resolved.
 */
export enum RenderPreparationExecutionMode {
  MainThread = "mainThread",
  Worker = "worker",
}

/**
 * Worker lifecycle state for render-preparation diagnostics.
 */
export enum RenderPreparationWorkerStatus {
  Disabled = "disabled",
  Ready = "ready",
  Unavailable = "unavailable",
  Error = "error",
}

/**
 * Prepared artifact family.
 */
export enum RenderPreparationArtifactKind {
  /** Frame-level ID-mask artifact prepared from semantic masks. */
  MaskFrame = "maskFrame",
  /** Frame-level ID-mask artifact rasterized from semantic polygons. */
  PolygonFrame = "polygonFrame",
}

/**
 * Preparation status for the active artifact frame.
 */
export enum RenderPreparationArtifactFrameStatus {
  Disabled = "disabled",
  Empty = "empty",
  Pending = "pending",
  Prepared = "prepared",
}

/**
 * Worker creation hook for hosts that need custom CSP or deployment handling.
 */
export interface RenderPreparationWorkerFactory {
  createWorker(): Worker;
}

/**
 * Options for preparing frame-level raster artifacts. Polygon frames reuse
 * this bounded worker/cache policy so both dense geometry paths stay ahead of
 * playback without duplicating scheduling controls.
 */
export interface RenderPreparationMaskFrameOptions {
  /**
   * Maximum number of prepared mask frames retained in memory.
   */
  readonly maxCacheFrameCount?: number;
  /**
   * Maximum number of mask frames queued for preparation.
   */
  readonly maxPendingFrameCount?: number;
  /**
   * Target number of frames to prepare ahead of playback.
   */
  readonly prefetchFrameCount?: number;
  /**
   * Number of frames scheduled per preparation scan.
   */
  readonly scheduleBatchSize?: number;
  /**
   * How often the prepared window scans for refill work.
   */
  readonly scanIntervalSeconds?: number;
  /**
   * Worker count for mask artifact preparation.
   */
  readonly workerCount?: number;
}

/**
 * Playback gate for prepared render artifacts.
 */
export interface RenderPreparationPlaybackGateOptions {
  /**
   * Pause playback while required artifacts are not prepared.
   */
  readonly enabled?: boolean;
  /**
   * Soft target ahead of the active frame.
   */
  readonly minimumAheadSeconds?: number;
  /**
   * Required ahead time before playback can continue.
   */
  readonly requiredAheadSeconds?: number;
}

/**
 * Diagnostics for the currently selected artifact frame.
 */
export interface RenderPreparationActiveFrameDiagnostics {
  readonly key: string;
  readonly mediaTime: number;
  readonly status: RenderPreparationArtifactFrameStatus;
}

/**
 * Diagnostics for one prepared artifact window.
 */
export interface RenderPreparationArtifactWindowDiagnostics {
  readonly availableFrameCount: number;
  readonly refillThresholdFrameCount: number;
  readonly targetFrameCount: number;
}

/**
 * Diagnostics for one prepared artifact family.
 */
export interface RenderPreparationArtifactDiagnostics {
  readonly activeFrame?: RenderPreparationActiveFrameDiagnostics | null;
  readonly inFlightCount?: number;
  readonly kind: RenderPreparationArtifactKind;
  readonly maxInFlightCount?: number;
  readonly maxPendingCount?: number;
  readonly maxPreparedCount?: number;
  readonly pendingCount: number;
  readonly preparedAheadFrameCount?: number;
  readonly preparedAheadSeconds?: number;
  readonly prefetchCount?: number;
  readonly preparedCount: number;
  readonly refillThresholdCount?: number;
  readonly scheduleBatchSize?: number;
  readonly window?: RenderPreparationArtifactWindowDiagnostics;
}

/**
 * Renderer-owned render-preparation diagnostics.
 */
export interface RenderPreparationDiagnostics {
  readonly artifacts: readonly RenderPreparationArtifactDiagnostics[];
  readonly executionMode: RenderPreparationExecutionMode;
  readonly message: string | null;
  readonly workerStatus: RenderPreparationWorkerStatus;
}

/**
 * Render-preparation configuration.
 *
 * Most applications can use the session defaults. Tune this when dense masks,
 * long videos, worker policy, or playback gating need explicit behavior.
 */
export interface RenderPreparationOptions {
  readonly maskFrame?: RenderPreparationMaskFrameOptions;
  readonly mode?: RenderPreparationMode;
  readonly onDiagnostics?: (diagnostics: RenderPreparationDiagnostics) => void;
  readonly playbackGate?: RenderPreparationPlaybackGateOptions;
  readonly workerFactory?: RenderPreparationWorkerFactory;
}
