import type {
  DetectionCoordinateSpace,
  DetectionFrame,
} from "#types/detections";

export enum DetectionBufferStatus {
  Idle = "idle",
  Loading = "loading",
  Ready = "ready",
  Error = "error",
  Destroyed = "destroyed",
}

/**
 * How the renderer selects the active detection frame for a media timestamp.
 */
export enum DetectionFrameSelectionMode {
  /**
   * Select the frame whose `[mediaTime, endTime)` interval contains the media
   * time. This is the default for interval annotations and timestamped sources.
   *
   * Frame times must come from the media itself. Times reconstructed from a
   * nominal frame rate drift against a clip whose real rate differs, and once
   * that drift passes the half-millisecond selection tolerance a playhead
   * landing on a frame boundary selects the previous frame's detections.
   * {@link DetectionFrameSelectionMode.NearestFrameIndex} compares indices and
   * carries none of this.
   */
  Interval = "interval",

  /**
   * Select from a known inference frame grid using `frameIndex`, `frameRate`,
   * and optional `frameIndexOriginTime`. This is useful when inference was run
   * on normalized frames and playback should snap detections to that grid.
   */
  NearestFrameIndex = "nearestFrameIndex",
}

export interface DetectionFrameSelectionOptions {
  /**
   * Selection strategy for matching media playback time to detection frames.
   */
  readonly selectionMode?: DetectionFrameSelectionMode;
  /**
   * Inference frame rate used by `NearestFrameIndex`.
   */
  readonly frameRate?: number;
  /**
   * Media timestamp for inference frame index 0. Defaults to the first indexed
   * frame's time minus `frameIndex / frameRate`.
   */
  readonly frameIndexOriginTime?: number;
}

export interface DetectionFrameSourceVersionRange {
  /**
   * Inclusive media-time start in seconds.
   */
  readonly startTime: number;
  /**
   * Exclusive media-time end in seconds.
   */
  readonly endTime: number;
}

/**
 * Incremental source changes since a previously observed source version.
 *
 * `requiresReload` is true when the source can no longer describe every
 * intervening change (for example after replacement, clearing, or journal
 * compaction). Buffered timelines then reload their complete hot window.
 */
export interface DetectionFrameSourceChanges {
  readonly version: number;
  readonly ranges: readonly DetectionFrameSourceVersionRange[];
  readonly requiresReload: boolean;
}

export interface DetectionBufferOptions extends DetectionFrameSelectionOptions {
  /**
   * Seconds of detections to keep loaded ahead of playback.
   */
  readonly bufferAheadSeconds?: number;
  /**
   * Seconds of detections to keep loaded behind playback.
   */
  readonly bufferBehindSeconds?: number;
  /**
   * Minimum media-time movement before the hot detection window is rebuilt.
   *
   * This governs refreshes of ground the window already covers. A media time
   * the window does not cover loads immediately whatever this says, so raising
   * it costs coverage nothing and only reduces repeated work.
   *
   * A session defaults it to 2.5 seconds for a file, whose detections do not
   * change while it plays, and to 0.25 seconds for a stream, where the source
   * gains data under the window. A renderer created directly leaves it unset,
   * which refreshes whenever the playhead moves.
   */
  readonly refreshIntervalSeconds?: number;
  /**
   * Hold playback until detections cover the frame about to be presented.
   *
   * Off by default: the picture moves first, and a frame the buffered window
   * does not cover presents without annotations until a later load reaches it.
   * Enabled, a gated `prepare` awaits the source's `waitForRange` for the
   * requested lookahead before it loads, so playback stalls rather than
   * showing an unannotated frame.
   *
   * The stall lives in the renderer's own sample pump, so a media source the
   * renderer pulls decoded samples from is held frame by frame, for as long as
   * playback runs. A source that presents its own frames owns the playhead and
   * the renderer follows it; the browser package's video-engine source,
   * `openVideoEngineMediaSource`, is that kind of source, and it is the one
   * most hosts render video through. There the gate holds the start of playback
   * and nothing after it: coverage is awaited before the producer is asked to
   * run, and a producer already running paces itself.
   */
  readonly playbackGate?: DetectionPlaybackGateOptions;
}

export interface DetectionTimelineContext {
  readonly duration: number | null;
  readonly loop: boolean;
}

/**
 * Detection-coverage playback gate, off unless `enabled` says otherwise.
 *
 * Off, annotations catch up to the picture and never hold it: a frame the
 * buffered window does not cover presents without annotations. On, playback
 * waits for the requested coverage before the next frame is presented, and the
 * renderer reports buffering for as long as that wait lasts.
 *
 * That wait is something the renderer does between pulling one decoded sample
 * and drawing it, so it reaches only a media source the renderer pulls samples
 * from. A source that presents its own frames runs the playhead itself, which
 * covers the browser package's video-engine source, `openVideoEngineMediaSource`.
 * There the gate holds the start of playback and nothing after it: the wait runs
 * once, before the producer is told to play, and the renderer reports
 * `Buffering` for its duration. Once the producer is running, a frame the
 * coverage does not reach presents without annotations rather than waiting.
 */
export interface DetectionPlaybackGateOptions {
  /**
   * Pause playback while the requested detection window is unavailable. A
   * session with appendable detections turns this on by default, since a source
   * still being written is the case worth waiting for; `playbackGate: false` on
   * the session turns it off.
   */
  readonly enabled?: boolean;
  /**
   * Detection lead required ahead of the playback time before an enabled gate
   * lets playback continue. Defaults to none, and a gate asked for no lead
   * waits for nothing, so an enabled gate needs one to do anything.
   */
  readonly requiredAheadSeconds?: number;
}

export enum DetectionFrameRetentionMode {
  /**
   * Keep writable detections only in an in-memory store. Useful for ephemeral
   * live streams where old predictions should disappear when evicted.
   */
  MemoryOnly = "memoryOnly",

  /**
   * Persist every written detection frame. Useful for finite media where seek
   * and replay should not require recomputing detections.
   */
  PersistAll = "persistAll",

  /**
   * Persist only the most recent retention window. Useful for long-running
   * streams where replay is bounded to a recent time horizon.
   */
  PersistWindow = "persistWindow",
}

export interface DetectionFrameRetentionOptions {
  readonly mode?: DetectionFrameRetentionMode;
  /**
   * Retention horizon in seconds for `MemoryOnly` and `PersistWindow`.
   */
  readonly windowSeconds?: number;
}

/**
 * Per-call preparation context.
 *
 * Only a gated prepare reads `duration` and `firstTimestamp`, which bound the
 * coverage it asks for at the end of media. Everything else the timeline needs
 * about duration and looping arrives through
 * {@link BufferedDetectionTimeline.setTimelineContext}.
 */
export interface DetectionBufferPrepareOptions {
  readonly duration?: number | null;
  readonly firstTimestamp?: number;
  /**
   * Wait for the coverage {@link DetectionPlaybackGateOptions} asks for before
   * loading the hot window.
   *
   * Defaults to false, and does nothing unless the timeline was built with an
   * enabled gate. Both have to say yes, so a caller that prepares detections
   * for its own reasons never blocks on coverage.
   */
  readonly gatePlayback?: boolean;
}

/**
 * Current hot detection-buffer state.
 *
 * Window ends are media times, so a current time sits inside them or outside
 * them. On a looping timeline a window that reaches past the last frame keeps
 * counting: its start stays within the media, and its end runs past the
 * duration by however far it wraps into the replay.
 */
export interface DetectionBufferState {
  readonly status: DetectionBufferStatus;
  readonly requestedStartTime: number | null;
  readonly requestedEndTime: number | null;
  readonly bufferStartTime: number | null;
  readonly bufferEndTime: number | null;
  readonly frameCount: number;
  readonly detectionCount: number;
  readonly errorMessage: string | null;
}

/**
 * Optional context a renderer passes when it loads detection frames.
 */
export interface DetectionFrameLoadOptions {
  /**
   * Coordinate space the loaded frames will be presented in.
   *
   * Sources that flatten several child frames into one, such as a composite
   * source, need this to project each child while its `coordinateSpace` is
   * still attached to its own detections. Sources that return their frames
   * unchanged can ignore it: the renderer projects whatever it receives.
   */
  readonly coordinateSpace?: DetectionCoordinateSpace;
}

export interface DetectionFrameSource {
  /**
   * Load semantic detection frames for the requested media-time range.
   *
   * Sources should return detection data, not renderer artifacts. Implementers
   * should prefer sorted frames and avoid mutating returned frames after handing
   * them to the renderer. `options` is additive context; ignoring it stays
   * correct for any source that does not compose other sources.
   */
  loadFrames(
    startTime: number,
    endTime: number,
    options?: DetectionFrameLoadOptions,
  ): Promise<readonly DetectionFrame[]>;
  /**
   * Optional coverage hook. Resolve when the source has enough data to answer
   * `loadFrames` for the requested range.
   *
   * Playback awaits it under an enabled detection playback gate, which a
   * session with appendable detections gets by default; otherwise a caller that
   * wants to wait awaits it itself. A
   * composed source fans it out to the entries it composes.
   */
  waitForRange?(range: DetectionFrameSourceVersionRange): Promise<void>;
  /**
   * Optional source coverage report for timeline UI and buffering decisions.
   */
  getAvailableRanges?(): readonly DetectionFrameSourceVersionRange[];
  /**
   * Optional monotonically increasing source version. Buffered timelines use
   * this to refresh only when the current range changed. Sources that can
   * revise an existing frame must implement this hook; without it, overlapping
   * frame identities are treated as immutable across rolling window loads.
   */
  getVersion?(range?: DetectionFrameSourceVersionRange): number;
  /**
   * Optionally describe changes after `version` that overlap `ranges`.
   *
   * This allows a hot timeline to patch a small progressive-inference append
   * without reloading and copying its complete buffered window.
   */
  getChangesSince?(
    version: number,
    ranges: readonly DetectionFrameSourceVersionRange[],
  ): DetectionFrameSourceChanges;
  destroy?(): void;
}

export interface CompositeDetectionFrameSourceEntry {
  /**
   * Renderer-neutral source identity copied into composed detections.
   */
  readonly id: string;
  /**
   * Static detection frames for this source.
   */
  readonly frames?: readonly DetectionFrame[];
  /**
   * Caller-owned frame source for this source.
   */
  readonly source?: DetectionFrameSource;
  /**
   * Lower order sources are composed first. Later detections render on top.
   */
  readonly order?: number;
  /**
   * Detection-frame selection options for this source.
   */
  readonly sync?: DetectionFrameSelectionOptions;
  /**
   * When false, the composed source's `waitForRange` resolves without waiting
   * for this entry. Defaults to true.
   */
  readonly requiredForCoverage?: boolean;
}

export interface CompositeDetectionFrameSourceOptions extends DetectionFrameSelectionOptions {
  readonly sources: readonly CompositeDetectionFrameSourceEntry[];
}

export interface DetectionFrameChunkDescriptor {
  /**
   * Zero-based chunk index.
   */
  readonly chunkIndex: number;
  /**
   * Inclusive chunk start time in seconds.
   */
  readonly startTime: number;
  /**
   * Exclusive chunk end time in seconds.
   */
  readonly endTime: number;
  readonly frameCount: number;
  readonly src: string;
}

export interface DetectionFrameChunk {
  readonly frames: readonly DetectionFrame[];
}

export interface DetectionFrameChunkManifest {
  readonly schema: "supervision-js.detection-frame-chunk-manifest";
  readonly version: 1;
  /**
   * Stable identifier for the detection dataset.
   */
  readonly datasetId: string;
  readonly duration: number;
  readonly frameRate: number;
  readonly chunkDurationSeconds: number;
  readonly frameCount?: number;
  readonly detectionCount?: number;
  readonly chunks: readonly DetectionFrameChunkDescriptor[];
}

export type DetectionFrameChunkFetch = (
  chunk: DetectionFrameChunkDescriptor,
) => Promise<DetectionFrameChunk>;

export interface ChunkedDetectionFrameSourceOptions {
  readonly manifest: DetectionFrameChunkManifest;
  /**
   * Base href used by platform adapters to resolve relative chunk `src` values.
   */
  readonly baseUrl?: string;
  /**
   * Custom chunk loader supplied by a platform adapter or host application.
   */
  readonly fetchChunk?: DetectionFrameChunkFetch;
  /**
   * Maximum number of decoded chunks cached in memory.
   *
   * Left unset, the cache grows to twice the widest buffer window it has been
   * asked to serve, so the ground a backwards scrub lands on is still resident.
   * A fixed value caps the cache at that size even when the window is wider,
   * which costs a refetch on every load that spans more chunks than the cap.
   */
  readonly maxCachedChunks?: number;
}

/**
 * Hot detection timeline controller.
 */
export interface BufferedDetectionTimeline {
  prepare(
    mediaTime: number,
    options?: DetectionBufferPrepareOptions,
  ): Promise<void>;
  prefetch(mediaTime: number): void;
  setTimelineContext?(context: DetectionTimelineContext): void;
  selectFrame(mediaTime: number): DetectionFrame | undefined;
  getBufferedFrames(): readonly DetectionFrame[];
  getState(): DetectionBufferState;
  /**
   * Observe the buffered window changing.
   *
   * A load landing is the only way a media time that answered nothing starts
   * answering a frame, and a resting playhead draws nothing that would ask
   * again. Without this a consumer keeps the answer from before the load.
   */
  subscribe?(listener: () => void): () => void;
  destroy(): void;
}

/**
 * Write options for semantic detection frames.
 */
export interface ColdDetectionFrameStoreWriteOptions {
  readonly datasetId: string;
  /**
   * Frames to validate, sort, and write.
   */
  readonly frames: readonly DetectionFrame[];
  /**
   * Chunk duration used for summaries and chunked persistence.
   */
  readonly chunkDurationSeconds?: number;
}

/**
 * Summary returned after detection-frame writes.
 */
export interface ColdDetectionFrameStoreWriteSummary {
  readonly datasetId: string;
  readonly chunkDurationSeconds: number;
  readonly chunkCount: number;
  readonly frameCount: number;
  readonly detectionCount: number;
  readonly startTime: number | null;
  readonly endTime: number | null;
}

/**
 * Load options for semantic detection frames.
 */
export interface ColdDetectionFrameStoreLoadOptions {
  readonly datasetId: string;
  readonly startTime: number;
  readonly endTime: number;
}

/**
 * Prune options for bounded retention.
 *
 * Stores that implement `pruneFrames` drop everything ending before
 * `startTime` in place, so a retention window costs work proportional to the
 * evicted range instead of the complete history.
 */
export interface ColdDetectionFrameStorePruneOptions {
  readonly datasetId: string;
  /**
   * Inclusive media-time floor to retain. Frames ending before it are removed.
   */
  readonly startTime: number;
}

/**
 * Cold semantic detection storage.
 *
 * Stores validated detection frames outside the active render path. Browser
 * implementations may use IndexedDB; memory implementations are useful for
 * tests, demos, and ephemeral streams.
 */
export interface ColdDetectionFrameStore {
  putFrames(
    options: ColdDetectionFrameStoreWriteOptions,
  ): Promise<ColdDetectionFrameStoreWriteSummary>;
  appendFrames(
    options: ColdDetectionFrameStoreWriteOptions,
  ): Promise<ColdDetectionFrameStoreWriteSummary>;
  loadFrames(
    options: ColdDetectionFrameStoreLoadOptions,
  ): Promise<readonly DetectionFrame[]>;
  /**
   * Optionally drop retained frames that end before `startTime`.
   *
   * Implementing this lets writable sources apply a retention window without
   * reloading and rewriting the frames they keep. Stores that omit it fall
   * back to a reload-and-replace rewrite.
   */
  pruneFrames?(
    options: ColdDetectionFrameStorePruneOptions,
  ): Promise<ColdDetectionFrameStoreWriteSummary>;
  clearDataset(datasetId: string): Promise<void>;
  destroy?(): void;
}

/**
 * Live ingestion policy for `appendLiveFrame`.
 *
 * A live producer only knows that its newest result is current; it learns when
 * that result stopped being current only when the next one arrives. The source
 * therefore holds the newest frame open for `holdSeconds` and closes it at the
 * next frame's `mediaTime` when that frame lands.
 */
export interface DetectionFrameLiveOptions {
  /**
   * How long the newest live frame stays active while no successor exists.
   *
   * Keep it long enough to cover a stalled producer and short enough that a
   * stale overlay eventually disappears. Defaults to 60 seconds.
   */
  readonly holdSeconds?: number;
}

export interface WritableDetectionFrameSourceOptions {
  readonly store: ColdDetectionFrameStore;
  readonly datasetId: string;
  readonly chunkDurationSeconds?: number;
  readonly retention?: DetectionFrameRetentionOptions;
  /**
   * Live latest-frame semantics used by `appendLiveFrame`.
   */
  readonly live?: DetectionFrameLiveOptions;
}

/**
 * Detection source that accepts new frames over time.
 *
 * This is the ingestion shape used for streaming inference and long-running
 * media sessions. It remains semantic: render artifacts are prepared later by
 * the renderer.
 */
export interface WritableDetectionFrameSource extends DetectionFrameSource {
  readonly datasetId: string;
  appendFrames(
    frames: readonly DetectionFrame[],
  ): Promise<ColdDetectionFrameStoreWriteSummary>;
  /**
   * Optionally append the newest live frame with latest-frame semantics.
   *
   * Optional so existing implementations of this interface keep type-checking.
   * `createWritableDetectionFrameSource` always provides it; see
   * {@link LiveWritableDetectionFrameSource}.
   */
  appendLiveFrame?(
    frame: DetectionFrame,
  ): Promise<ColdDetectionFrameStoreWriteSummary>;
  /**
   * Optionally close the final frame's coverage at a known end of media.
   *
   * Optional for the same backward-compatibility reason as
   * {@link WritableDetectionFrameSource.appendLiveFrame}.
   */
  finalizeCoverage?(
    endTime: number,
  ): Promise<ColdDetectionFrameStoreWriteSummary | null>;
  replaceFrames(
    frames: readonly DetectionFrame[],
  ): Promise<ColdDetectionFrameStoreWriteSummary>;
  clear(): Promise<void>;
  waitForRange(range: DetectionFrameSourceVersionRange): Promise<void>;
  getAvailableRanges(): readonly DetectionFrameSourceVersionRange[];
  getSummary(): ColdDetectionFrameStoreWriteSummary | null;
  getVersion(range?: DetectionFrameSourceVersionRange): number;
}

/**
 * Writable detection source that also supports live ingestion.
 *
 * `createWritableDetectionFrameSource` returns this shape. Consumers that only
 * implement the historical {@link WritableDetectionFrameSource} contract stay
 * assignable to it, so live ingestion is an added capability rather than a
 * required one.
 */
export interface LiveWritableDetectionFrameSource extends WritableDetectionFrameSource {
  /**
   * Append the newest live frame with latest-frame/hold-until-next semantics.
   *
   * The frame is written with an open-ended hold, and the previously held live
   * frame is closed at this frame's `mediaTime`. At most two frames are
   * written, so append cost does not grow with retained history. Writes are
   * serialized internally and a frame older than the newest accepted live
   * frame is dropped, so the newest causal result always wins.
   */
  appendLiveFrame(
    frame: DetectionFrame,
  ): Promise<ColdDetectionFrameStoreWriteSummary>;
  /**
   * Close the final frame's coverage at a known end of media.
   *
   * A container can declare a duration beyond the last decoded sample, and a
   * live frame is deliberately held open past the data it describes. Finalizing
   * sets the latest frame's exclusive end to `endTime`, extending or shortening
   * it as needed, so the source stops answering for time past the end of media.
   * The readers this serves are `waitForRange` and the buffered window's own
   * coverage arithmetic. It is idempotent and returns the current summary when
   * there is nothing to change.
   */
  finalizeCoverage(
    endTime: number,
  ): Promise<ColdDetectionFrameStoreWriteSummary | null>;
}
