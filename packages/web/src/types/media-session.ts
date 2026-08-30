import type {
  ColdDetectionFrameStore,
  ColdDetectionFrameStoreWriteSummary,
  DetectionBufferOptions,
  DetectionFrameLiveOptions,
  DetectionFrameRetentionOptions,
  DetectionFrameSelectionOptions,
  DetectionPlaybackGateOptions,
  DetectionFrameSource,
  MediaSessionLifecycleState,
  MediaSessionMode,
  MediaSessionStateListener as CoreMediaSessionStateListener,
  MediaSessionStateUnsubscribe,
  WritableDetectionFrameSource,
} from "supervision-js-core";
import type { DetectionFrame } from "supervision-js-core";
import type { MediaInteractionOptions } from "supervision-js-core";
import type {
  MediaNormalizationInputMetadata,
  MediaNormalizationProgress,
  MediaNormalizationOptions,
  NormalizedMedia,
  ProgressiveNormalizedMedia,
} from "#types/media-normalization";
import type {
  DetectionTimelineOrigin,
  MediaFrameCapture,
  MediaFrameCaptureOptions,
  MediaFrameDiagnostics,
  MediaRenderer,
  MediaRendererFit,
  MediaRendererPresentation,
  MediaRendererQuality,
  MediaRendererOptions,
  MediaRendererSource,
  MediaRendererState,
  MediaSourceState,
} from "#types/media-renderer";
import type { RenderPreparationDiagnostics } from "#types/render-preparation";

export {
  MediaSessionActivityKind,
  MediaSessionActivityStatus,
  MediaSessionMode,
  MediaSessionStatus,
} from "supervision-js-core";
export type {
  MediaSessionActivity,
  MediaSessionStateUnsubscribe,
} from "supervision-js-core";

/**
 * Media input accepted by `createMediaSession`.
 *
 * Use a `Blob` for uploaded files, a URL string for already hosted media, or a
 * custom renderer source when integrating a lower-level media adapter.
 */
export type MediaSessionMedia =
  string | URL | Request | Blob | MediaRendererSource;

export interface MediaSessionNormalizationOptions extends MediaNormalizationOptions {
  /**
   * When true, media normalization may expose progressive output before the
   * entire input has finished normalizing. Defaults to false, which opens the
   * session only once the complete normalized blob exists.
   */
  readonly stream?: boolean;
}

/**
 * Options for session-owned streaming detection ingestion.
 */
export interface MediaSessionAppendableDetectionOptions {
  /**
   * Optional cold store. If omitted, the session creates an in-memory store.
   * `MemoryOnly` retention always uses an in-memory store.
   */
  readonly store?: ColdDetectionFrameStore;
  readonly datasetId: string;
  readonly chunkDurationSeconds?: number;
  readonly clearOnCreate?: boolean;
  readonly retention?: DetectionFrameRetentionOptions;
  /**
   * Latest-frame/hold-until-next semantics used by
   * `appendLiveDetectionFrame`.
   */
  readonly live?: DetectionFrameLiveOptions;
}

/**
 * @deprecated Use `MediaSessionAppendableDetectionOptions`.
 */
export type MediaSessionWritableDetectionOptions =
  MediaSessionAppendableDetectionOptions;

export type MediaSessionDetectionSyncOptions = DetectionFrameSelectionOptions;

export type MediaSessionDetectionSourcePresentation = Pick<
  MediaRendererPresentation,
  | "boxStyle"
  | "keypointStyle"
  | "labelStyle"
  | "maskStyle"
  | "polygonStyle"
  | "polylineStyle"
>;

export interface MediaSessionDetectionSourceOptions {
  /**
   * Renderer-neutral source identity copied into composed detections.
   */
  readonly id: string;
  /**
   * Static detection frames known at session creation time.
   */
  readonly frames?: readonly DetectionFrame[];
  /**
   * Caller-owned source for loading detection frames by media-time range.
   */
  readonly source?: DetectionFrameSource;
  /**
   * Session-owned writable source for streaming detections into cold storage.
   */
  readonly appendable?: MediaSessionAppendableDetectionOptions;
  /**
   * Lower order sources are composed first. Later detections render on top.
   */
  readonly order?: number;
  /**
   * Optional geometry presentation overrides for this source.
   *
   * `undefined` falls back to the global presentation. `null` disables that
   * layer for this source.
   */
  readonly presentation?: MediaSessionDetectionSourcePresentation;
  /**
   * Detection-frame selection options for this source.
   */
  readonly sync?: MediaSessionDetectionSyncOptions;
  /**
   * When false, `waitForRange` on `MediaSession.detectionSource` resolves
   * without waiting for this source. Defaults to true.
   */
  readonly requiredForCoverage?: boolean;
}

export interface MediaSessionDetectionOptions {
  /**
   * Multiple detection sources composed into one active semantic frame.
   */
  readonly sources?: readonly MediaSessionDetectionSourceOptions[];

  /**
   * Static detection frames known at session creation time.
   */
  readonly frames?: readonly DetectionFrame[];

  /**
   * Caller-owned source for loading detection frames by media-time range.
   */
  readonly source?: DetectionFrameSource;

  /**
   * Session-owned writable source for streaming detections into cold storage.
   * Prefer this name for new code.
   */
  readonly appendable?: MediaSessionAppendableDetectionOptions;

  /**
   * Backward-compatible alias for `appendable`.
   *
   * @deprecated Use `appendable`.
   */
  readonly writable?: MediaSessionWritableDetectionOptions;

  /**
   * Detection-frame selection options shared by the hot buffer and renderer.
   */
  readonly sync?: MediaSessionDetectionSyncOptions;

  /**
   * Hot detection-window loading options.
   */
  readonly buffer?: DetectionBufferOptions;

  /**
   * Hold playback until detections cover the frame about to be presented.
   *
   * Off by default: the session presents a frame the detection window does not
   * cover without annotations and draws them once coverage lands. Enabled, the
   * session treats detection coverage as part of media readiness and reports
   * buffering while it waits. Merges over `buffer.playbackGate`.
   *
   * The sustained wait is the renderer holding a decoded sample back, so it
   * lasts the length of playback only when the renderer pulls samples: a URL, a
   * `Blob`, or any `media` source without a presented-frame channel. A source
   * that presents its own frames drives the playhead itself, which is what
   * `createWebVideoEngineMediaRendererSource` returns and therefore what most
   * video sessions actually run on. There the gate holds the start of playback
   * and nothing after it, so a preview opens covered and a producer already
   * running keeps its own pace.
   */
  readonly playbackGate?: DetectionPlaybackGateOptions;

  /**
   * Clock used by supplied detection frames. Use `MediaStart` when inference
   * timestamps begin at zero independently of the file's encoded PTS.
   */
  readonly timelineOrigin?: DetectionTimelineOrigin;

  /**
   * Redraw automatically when appended detections cover the displayed time.
   *
   * At most one refresh is in flight at a time, and appends that land outside
   * the currently displayed interval never force a render. Set it to `false`
   * to drive every redraw with an explicit `session.refresh()`. Defaults to
   * `true`.
   */
  readonly autoRefresh?: boolean;
}

export interface MediaSessionRendererOptions {
  readonly autoPlay?: boolean;
  readonly loop?: boolean;
  readonly playbackRate?: number;
  /**
   * @deprecated Nothing reads this. The renderer is video-only and audio
   * playback is deferred, so setting it changes nothing either way.
   */
  readonly muted?: boolean;
  readonly fit?: MediaRendererFit;
  readonly maxDevicePixelRatio?: MediaRendererOptions["maxDevicePixelRatio"];
  readonly interaction?: MediaInteractionOptions;
  readonly renderPreparation?: MediaRendererOptions["renderPreparation"];
  readonly diagnostics?: MediaRendererOptions["diagnostics"];
  /**
   * Caller-owned editing engine. The host persists committed edits and owns
   * undo; the session only routes renderer gestures and previews.
   */
  readonly editingEngine?: MediaRendererOptions["editingEngine"];
  /** Optional browser mask-brush preview rendered with the editing engine. */
  readonly maskBrush?: MediaRendererOptions["maskBrush"];
  readonly createMaskBrush?: MediaRendererOptions["createMaskBrush"];
  /** Optional host-owned external preview rendered above annotations. */
  readonly previewOverlay?: MediaRendererOptions["previewOverlay"];
  readonly onFrame?: (diagnostics: MediaFrameDiagnostics) => void;
  readonly onSource?: (state: MediaSourceState) => void;
  readonly onState?: (state: MediaRendererState) => void;
}

/**
 * Options for creating one renderer-owned media session.
 */
export interface MediaSessionOptions {
  /**
   * DOM element where the renderer should mount its canvas.
   */
  readonly container: HTMLElement;
  /**
   * Media to prepare and render. This can be a URL, an uploaded file/blob, or a
   * lower-level renderer source.
   */
  readonly media: MediaSessionMedia;
  /**
   * File mode is bounded media. Stream mode tunes defaults for live or
   * append-only detection sources.
   */
  readonly mode?: MediaSessionMode;
  /**
   * Optional browser media normalization before rendering.
   */
  readonly normalize?: false | MediaSessionNormalizationOptions;
  /**
   * Detection frames or sources to render with the media.
   */
  readonly detections?: MediaSessionDetectionOptions;
  /**
   * Buffered playback: hold the picture until the frame it is about to show has
   * both its detections and its prepared annotation artifacts, so a preview
   * opens annotated rather than opening bare and filling in.
   *
   * On by default. `false` starts playback at once and draws annotations as
   * they land, which suits a host that cares about cadence more than overlays.
   * The switch answers for `detections.playbackGate` and
   * `renderer.renderPreparation.playbackGate` together, each keeping its own
   * lookahead; set either one's `enabled` to answer for that gate alone.
   *
   * The detection gate only applies to a session with appendable detections,
   * since a source that is complete before playback starts has nothing to wait
   * for. `true` turns it on for any session.
   *
   * What it holds depends on who owns the playhead. A source the renderer pulls
   * decoded samples from is held frame by frame, for as long as playback runs.
   * A source that presents its own frames, which is what
   * `createWebVideoEngineMediaRendererSource` returns, is held at the start of
   * playback only: the session reports buffering until the frame it will resume
   * on is covered, and once the producer is running it paces itself.
   */
  readonly playbackGate?: boolean;
  /**
   * Aggregate loading, playback, buffering, processing, and error state.
   */
  readonly onState?: (state: MediaSessionState) => void;
  /**
   * Box, mask, label, interaction, and focus presentation styles.
   */
  readonly presentation?: MediaRendererPresentation;
  /**
   * Renderer playback, interaction, diagnostics, and render-preparation options.
   */
  readonly renderer?: MediaSessionRendererOptions;
}

/**
 * Which of the session's media branches ran.
 *
 * The five differ in whether the clip is converted first and in who ends up
 * reading it, and from outside they were indistinguishable: two of them leave
 * every other field on {@link MediaSessionMediaState} null.
 */
export enum MediaSessionMediaBranch {
  /** A URL, `URL` or `Request` went to the renderer untouched. */
  Url = "url",
  /** A source the caller had already built went to the renderer untouched. */
  RendererSource = "rendererSource",
  /** A file the session was not asked to convert, played from an object URL. */
  BlobObjectUrl = "blobObjectUrl",
  /** A file converted in full first, played from the conversion's object URL. */
  NormalizedObjectUrl = "normalizedObjectUrl",
  /** A file converted while it plays, read through the conversion's source. */
  ProgressiveSource = "progressiveSource",
}

/**
 * What the session did with the media it was handed, recorded as it did it.
 *
 * The renderer opens a `src` and a `source` through different readers, so which
 * of the two a branch set decides which one opens the clip. Nothing else
 * reports it.
 */
export interface MediaSessionMediaPreparation {
  readonly branch: MediaSessionMediaBranch;
  /** Which of the renderer's two media options this branch filled in. */
  readonly opened: "src" | "source";
}

/**
 * Prepared media state visible to host applications.
 */
export interface MediaSessionMediaState {
  readonly inputMetadata: MediaNormalizationInputMetadata | null;
  readonly normalizedMedia: NormalizedMedia | ProgressiveNormalizedMedia | null;
  readonly objectUrl: string | null;
  /** Null until the session has prepared its media. */
  readonly preparation?: MediaSessionMediaPreparation | null;
}

export interface MediaSessionNormalizationState {
  readonly active: boolean;
  readonly progress: MediaNormalizationProgress | null;
}

/**
 * Current aggregate browser-session state for media, renderer, detections,
 * render preparation, loading activities, and errors.
 */
export type MediaSessionState = MediaSessionLifecycleState<
  MediaSessionMediaState,
  MediaRendererState,
  MediaSessionNormalizationState,
  RenderPreparationDiagnostics
>;

export type MediaSessionStateListener =
  CoreMediaSessionStateListener<MediaSessionState>;

export interface MediaSessionDetectionWriteOptions {
  readonly sourceId?: string;
}

/**
 * Public controller for one renderer-owned media item.
 */
export interface MediaSession {
  /**
   * Detection source used by the renderer. Present when the session was created
   * with static frames, a source, or an appendable source.
   */
  readonly detectionSource?:
    DetectionFrameSource | WritableDetectionFrameSource;
  readonly media: MediaSessionMediaState;
  readonly renderer: MediaRenderer;
  /**
   * Append semantic detection frames to a session-owned appendable source.
   */
  appendDetectionFrames(
    frames: readonly DetectionFrame[],
    options?: MediaSessionDetectionWriteOptions,
  ): Promise<ColdDetectionFrameStoreWriteSummary>;
  /**
   * Optionally append the newest live detection frame.
   *
   * Live ingestion is an added capability, so a controller that does not do it
   * still satisfies this interface. `createMediaSession` always provides it;
   * see {@link LiveMediaSession}.
   */
  appendLiveDetectionFrame?(
    frame: DetectionFrame,
    options?: MediaSessionDetectionWriteOptions,
  ): Promise<ColdDetectionFrameStoreWriteSummary>;
  /**
   * Optionally close the appendable source's final coverage.
   *
   * Optional for the same reason as
   * {@link MediaSession.appendLiveDetectionFrame}.
   */
  finalizeDetectionCoverage?(
    endTime?: number,
    options?: MediaSessionDetectionWriteOptions,
  ): Promise<ColdDetectionFrameStoreWriteSummary | null>;
  replaceDetectionFrames(
    frames: readonly DetectionFrame[],
    options?: MediaSessionDetectionWriteOptions,
  ): Promise<ColdDetectionFrameStoreWriteSummary>;
  clearDetectionFrames(
    options?: MediaSessionDetectionWriteOptions,
  ): Promise<void>;
  /**
   * Summary of frames written through `appendDetectionFrames`, when available.
   */
  getDetectionSummary(
    options?: MediaSessionDetectionWriteOptions,
  ): ColdDetectionFrameStoreWriteSummary | null;
  play(): Promise<void>;
  pause(): void;
  seek(mediaTime: number): Promise<void>;
  stepForward(): Promise<void>;
  stepBackward(): Promise<void>;
  setPlaybackRate(playbackRate: number): void;
  /** Re-read semantic detections and redraw the current presentation. */
  refresh(): Promise<void>;
  /**
   * Encodes the media frame the session is currently presenting.
   *
   * The session keeps decode and render ownership; hosts receive an encoded
   * image of the raw media pixels plus the presentation timestamp of that exact
   * frame. Defaults to JPEG.
   */
  captureFrame(options?: MediaFrameCaptureOptions): Promise<MediaFrameCapture>;
  setPresentation(presentation: MediaRendererPresentation): void;
  setRenderQuality(quality: MediaRendererQuality): void;
  subscribe(listener: MediaSessionStateListener): MediaSessionStateUnsubscribe;
  getState(): MediaSessionState;
  destroy(): void;
}

/**
 * Media session that also exposes live detection ingestion.
 *
 * `createMediaSession` returns this shape. The members it requires are
 * optional on {@link MediaSession}, so live ingestion is an added capability
 * rather than a required one.
 */
export interface LiveMediaSession extends MediaSession {
  /**
   * Append the newest live detection frame to a session-owned appendable
   * source.
   *
   * The frame stays active until the next live frame supersedes it, which is
   * closed at the new frame's `mediaTime`. Use this for streams whose producer
   * only knows that its latest result is current.
   */
  appendLiveDetectionFrame(
    frame: DetectionFrame,
    options?: MediaSessionDetectionWriteOptions,
  ): Promise<ColdDetectionFrameStoreWriteSummary>;
  /**
   * Close the appendable source's final coverage at the end of media.
   *
   * `endTime` defaults to the renderer's reported media duration. Calling it
   * again is a no-op. Use it when a producer has finished, so the source stops
   * answering for the terminal sliver a container can declare beyond the last
   * decoded sample. What the sliver would otherwise strand is a `waitForRange`
   * caller, and an enabled detection playback gate along with it.
   */
  finalizeDetectionCoverage(
    endTime?: number,
    options?: MediaSessionDetectionWriteOptions,
  ): Promise<ColdDetectionFrameStoreWriteSummary | null>;
}
