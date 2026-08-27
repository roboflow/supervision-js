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
   * The box the host paints prepared masks into, in CSS pixels, with the pixel
   * ratio it paints them at. A mask frame's id raster is then capped to the
   * size that box can show; absent, it is cooked at the detections' own
   * resolution.
   */
  readonly display?: {
    readonly boxHeight: number;
    readonly boxWidth: number;
    readonly devicePixelRatio: number;
    readonly maxDevicePixelRatio?: number;
  };
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
 * Prepared-artifact playback gate, off unless `enabled` says otherwise.
 *
 * Off, preparation runs behind the picture and a frame the prepared window
 * does not cover reaches no annotation layer instead of holding playback back.
 * On, playback waits until the prepared window leads the playhead, so masks and
 * polygons arrive with their frame rather than after it.
 *
 * The renderer can only hold a frame it is about to draw itself, so this gate
 * reaches only a media source it pulls decoded samples from. A source that
 * presents its own frames owns the playhead and paces itself; that is the
 * video-engine source, `openVideoEngineMediaSource` and the
 * `createVideoEngineMediaRendererSource` wrapper around it, which is what most
 * video sessions render through. On a source that presents its own frames the gate
 * holds the start of playback and nothing after it: the wait runs once, before
 * the producer is told to play, and the renderer reports `Buffering` while it
 * does. Once the producer is running, unprepared layers stay absent until
 * preparation catches up.
 */
export interface RenderPreparationPlaybackGateOptions {
  /**
   * Pause playback while required artifacts are unprepared. A session turns
   * this on by default, so a preview opens with its annotations rather than
   * opening bare; `playbackGate: false` on the session turns it off. A renderer
   * created directly leaves it off.
   */
  readonly enabled?: boolean;
  /**
   * Prepared lead that is enough not to start a wait at all. Defaults to
   * `requiredAheadSeconds` and is capped by it: playback stalls only below this
   * lead, and a stall then clears only once the lead reaches
   * `requiredAheadSeconds`. Setting it lower buys hysteresis, so a lead
   * hovering at the requirement does not stutter.
   */
  readonly minimumAheadSeconds?: number;
  /**
   * Prepared lead a wait in progress must reach before an enabled gate lets
   * playback continue. Defaults to none, which asks only that the frame about
   * to be presented is no longer pending.
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
  /**
   * Hold playback until prepared artifacts cover the frame about to be
   * presented.
   *
   * **This option reaches two different distances depending on the source, and
   * the renderer reports which one it got as `playbackGateReach` on its state.**
   * A source the renderer pulls samples from is held at every frame. A source
   * that presents its own frames is held only at the start of playback, because
   * the producer owns the playhead once it is running, and frames after that
   * arrive whether their artifacts are ready or not.
   *
   * A renderer created directly leaves this off. `createMediaSession()` turns it
   * on, so a session opens with its annotations rather than opening bare; pass
   * `playbackGate: false` to the session to opt out. See
   * {@link RenderPreparationPlaybackGateOptions}.
   */
  readonly playbackGate?: RenderPreparationPlaybackGateOptions;
  readonly workerFactory?: RenderPreparationWorkerFactory;
}
