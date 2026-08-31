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
 * Why an enabled render-preparation gate is holding playback.
 *
 * The two holds are different events for a viewer. One says the picture is
 * incomplete; the other says the picture is finished and the gate is banking a
 * lead in front of it. A host shown only that playback stopped cannot tell them
 * apart, and describing the second as missing media is wrong on any source.
 */
export enum RenderPreparationGateHoldReason {
  /** The frame about to be presented has no artifact yet. */
  ActiveFrameUnprepared = "activeFrameUnprepared",
  /** That frame is ready, and the prepared lead in front of it is short. */
  LeadBelowRequirement = "leadBelowRequirement",
}

/**
 * The hold an enabled gate is applying, absent when it is not holding.
 */
export interface RenderPreparationGateHoldDiagnostics {
  readonly reason: RenderPreparationGateHoldReason;
  /**
   * Prepared lead the wait has to reach before it ends, after the target
   * window's own span has capped it. Against `preparedAheadSeconds` it gives a
   * host the progress of the wait.
   */
  readonly requiredAheadSeconds: number;
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
 * A source the renderer pulls samples from is held between the sample it
 * decoded and the draw. A source that presents its own frames owns the
 * playhead, so it is held by stopping the producer and starting it again,
 * before playback begins and at any frame after it whose artifacts are
 * missing. The renderer reports `Buffering` for as long as either wait lasts.
 *
 * `maxWaitSeconds` bounds the wait that stops a running producer, so
 * preparation that has stopped producing costs one wait and the frames after
 * it are drawn without their artifacts.
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
   * How long an enabled gate stops a producer already running for artifacts
   * that are not prepared, before it gives up and lets the frames through
   * without them. `Infinity` holds indefinitely. It does not bound the wait
   * before playback begins, nor the per-sample wait of a renderer that pulls
   * its own samples: both of those hold until preparation answers.
   *
   * Preparation falls behind for as long as the machine is losing, and that
   * looks no different to the gate from a cook still on its way. A gate that
   * gave up holds off until preparation finishes another frame, so a machine
   * that is merely slow keeps stopping the picture and catching up, and one
   * that has stopped producing costs one wait rather than one a frame.
   */
  readonly maxWaitSeconds?: number;
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
  readonly gateHold?: RenderPreparationGateHoldDiagnostics | null;
  readonly inFlightCount?: number;
  readonly kind: RenderPreparationArtifactKind;
  readonly maxInFlightCount?: number;
  readonly maxPendingCount?: number;
  readonly maxPreparedCount?: number;
  readonly pendingCount: number;
  /**
   * Frames in the unbroken run of prepared frames starting at the active
   * detection frame.
   *
   * This is a count of frames, not of media time. Above 1x the preparer strides,
   * so N frames here do not cover N frame durations of playback, and the two
   * numbers diverge by design. Deriving one from the other is wrong in both
   * directions.
   */
  readonly preparedAheadFrameCount?: number;
  /**
   * Media-time reach of that same unbroken run, in seconds, measured forward
   * from the active detection frame and wrapping at the media end on a looping
   * clip.
   *
   * The run stops at the first frame that is not prepared, so this is how long
   * playback can continue before annotations stop, not the furthest frame
   * prepared anywhere. It is also what a detection gate compares against its
   * required lead, so it stays a single comparable scalar.
   */
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
   * Both kinds of source are held at every frame: one between its decoded
   * sample and the draw, the other by stopping the producer that owns the
   * playhead and starting it again. `maxWaitSeconds` is what makes stopping a
   * running producer safe, and `playbackGateReach` on the renderer's state
   * reports the furthest any of its gates reaches.
   *
   * A renderer created directly leaves this off. `createMediaSession()` turns it
   * on, so a session opens with its annotations rather than opening bare; pass
   * `playbackGate: false` to the session to opt out. See
   * {@link RenderPreparationPlaybackGateOptions}.
   */
  readonly playbackGate?: RenderPreparationPlaybackGateOptions;
  readonly workerFactory?: RenderPreparationWorkerFactory;
}
