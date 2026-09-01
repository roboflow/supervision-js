import type { DetectionBufferState } from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";
import type { BoxStyle } from "#types/box-style";
import type { BoxCornerStyle } from "#types/box-corner-style";
import type { FocusStyle } from "#types/focus-style";
import type { InteractionStyle } from "#types/interaction-style";
import type { LabelStyle } from "#types/label-style";
import type { MaskHaloStyle } from "#types/mask-halo-style";
import type { MaskStyle } from "#types/mask-style";
import type { MarkerStyle } from "#types/marker-style";
import type { Point } from "#types/detections";
import type { ViewportTransform } from "#types/viewport";
import type { PolygonStyle } from "#types/polygon-style";
import type { PolylineStyle } from "#types/polyline-style";
import type { EllipseStyle } from "#types/ellipse-style";
import type { KeypointStyle } from "#types/keypoint-style";
import type { AnnotationOverlayStyle } from "#types/editing";
import type { AnnotationRenderer } from "#types/annotation-renderer";

export enum MediaRendererFit {
  /**
   * Preserve media aspect ratio and fit the full frame inside the canvas.
   */
  Contain = "contain",
  /**
   * Preserve media aspect ratio and fill the canvas, cropping if necessary.
   */
  Cover = "cover",
}

/**
 * Playback lifecycle state reported by a platform renderer.
 */
export enum MediaRendererPlaybackState {
  Loading = "loading",
  Ready = "ready",
  Playing = "playing",
  Buffering = "buffering",
  Paused = "paused",
  Error = "error",
  Destroyed = "destroyed",
}

/**
 * Stable classification of a media failure.
 *
 * Applications branch on these kinds instead of parsing decoder, demuxer, or
 * container error text, and still own their localized user-facing copy. New
 * kinds may be added over time, so treat unrecognized values like `Unknown`.
 */
export enum MediaErrorKind {
  /** The media could not be opened or read at all. */
  Unreadable = "unreadable",
  /** The container or codec is not supported by this platform. */
  UnsupportedFormat = "unsupportedFormat",
  /** The media opened but carries no usable video track. */
  NoVideoTrack = "noVideoTrack",
  /** Decoding a sample failed after the source opened. */
  Decode = "decode",
  /** The media could not be fetched. */
  Network = "network",
  /** The host environment lacks the APIs this media source requires. */
  EnvironmentUnsupported = "environmentUnsupported",
  /** The failure could not be classified. */
  Unknown = "unknown",
}

/**
 * Lower-level media source readiness.
 */
export enum MediaSourceStatus {
  Loading = "loading",
  Ready = "ready",
  Error = "error",
  Destroyed = "destroyed",
}

/**
 * Optional timing breakdown for one rendered frame.
 */
export interface MediaFrameRenderTimings {
  readonly totalMs: number;
  readonly mediaUploadMs: number;
  readonly maskMs: number;
  readonly boxMs: number;
  readonly focusMs: number;
  readonly interactionMs: number;
  readonly labelMs: number;
  readonly fitMs: number;
}

/**
 * Per-presented-frame diagnostics.
 *
 * Emitted from a renderer's frame loop. Keep handlers lightweight if reading
 * diagnostics at high frequency.
 */
export interface MediaFrameDiagnostics {
  readonly rendererBackend: string | null;
  readonly mediaTime: number;
  /**
   * Zero-based display estimate derived from the opened source's packet rate.
   * Canonical frame identity remains `mediaTime`, especially for VFR media.
   */
  readonly estimatedFrameIndex: number | null;
  /** Duration reported by the decoded sample currently on screen. */
  readonly frameDuration: number;
  /** First playable presentation timestamp of the opened media source. */
  readonly firstTimestamp: number;
  readonly presentedFrames: number;
  readonly currentTime: number;
  readonly duration: number | null;
  readonly mediaWidth: number;
  readonly mediaHeight: number;
  readonly expectedDisplayTime: null;
  readonly activeDetectionFrameTime: number | null;
  readonly activeDetectionFrameIndex: number | null;
  readonly activeDetectionCount: number;
  readonly detectionBuffer: DetectionBufferState;
  readonly renderTimings: MediaFrameRenderTimings | null;
}

export interface MediaRendererDiagnosticsOptions {
  /**
   * Measure per-frame render timings. Useful for profiling, but avoid enabling
   * it permanently in latency-sensitive apps unless needed.
   */
  readonly frameTimings?: boolean;
  /** Receives browser asset failures without failing media playback. */
  readonly onAssetError?: (error: MediaRendererAssetError) => void;
}

export interface MediaRendererAssetError {
  readonly rendererId: string;
  readonly src: string;
  readonly error: unknown;
}

/**
 * Snapshot of the opened media source.
 */
export interface MediaSourceState {
  readonly status: MediaSourceStatus;
  /**
   * True while the renderer is waiting on a read it cannot draw without.
   * Prefetch that runs behind a moving picture is not a wait and leaves this
   * false, so this is set only where the picture has stopped for the source.
   */
  readonly awaitingRead?: boolean;
  readonly canRead: boolean | null;
  readonly formatName: string | null;
  readonly formatMimeType: string | null;
  readonly mimeType: string | null;
  readonly duration: number | null;
  /** First playable presentation timestamp, when the source is ready. */
  readonly firstTimestamp: number | null;
  /** Average video packet rate sampled while opening finite media. */
  readonly estimatedFrameRate: number | null;
  /** Display estimate derived from duration and `estimatedFrameRate`. */
  readonly estimatedFrameCount: number | null;
  readonly trackCount: number | null;
  readonly videoTrackCount: number | null;
  readonly audioTrackCount: number | null;
  readonly primaryVideoWidth: number | null;
  readonly primaryVideoHeight: number | null;
  readonly errorMessage: string | null;
  /**
   * Stable failure classification when `status` is `Error`, otherwise `null`.
   *
   * Prefer this over `errorMessage` for control flow. Messages are diagnostic
   * text and may name vendor internals.
   */
  readonly errorKind?: MediaErrorKind | null;
}

/**
 * Current renderer state.
 */
/**
 * What a playback gate holds back.
 *
 * A source the renderer pulls samples from can be held between any two frames,
 * because the renderer decides when each one is drawn. A source that presents
 * its own frames owns the playhead, so holding it means stopping the producer
 * and starting it again, and a gate that stops one has to bound its own wait
 * or a producer nothing answers for never runs again.
 */
export enum PlaybackGateReach {
  /** No gate: the picture moves and unprepared layers are absent from it. */
  Off = "off",
  /**
   * Playback waits to begin, and stops again at any frame whose artifacts are
   * missing, until they arrive or the gate's own wait bound gives up on them.
   */
  EveryFrame = "everyFrame",
  /** Playback waits to begin; frames after that are not held. */
  StartOfPlayback = "startOfPlayback",
}

export interface MediaRendererState {
  readonly rendererBackend: string | null;
  readonly playbackState: MediaRendererPlaybackState;
  readonly fit: MediaRendererFit;
  readonly currentTime: number;
  readonly playbackRate: number;
  readonly duration: number | null;
  readonly mediaWidth: number;
  readonly mediaHeight: number;
  readonly presentedFrames: number;
  readonly activeDetectionFrameTime: number | null;
  readonly activeDetectionFrameIndex: number | null;
  readonly activeDetectionCount: number;
  /**
   * Detection frame the mask raster on screen belongs to, null when no mask is
   * up. It names `activeDetectionFrameTime`, or the frame beside it while that
   * frame's own raster is still being prepared, and never anything further off
   * than that.
   */
  readonly drawnMaskFrameTime?: number | null;
  /**
   * How far the active playback gates reach on the source this renderer opened.
   */
  readonly playbackGateReach?: PlaybackGateReach;
  /**
   * The render-preparation gate stopped playback for artifacts that never
   * arrived and gave up on them, so the picture is moving without them. False
   * again once preparation covers the playhead.
   */
  readonly renderPreparationGateAbandoned?: boolean;
  /**
   * Whether the raster on screen belongs to a frame other than the one the rest
   * of the annotations were drawn from, which is the neighbouring frame and no
   * further. It goes true where drawing nothing would have blinked the mask off
   * for a frame instead.
   */
  readonly maskHeldStale?: boolean;
  /**
   * Whether the playhead has been moved to a frame that is not on screen yet.
   * `playbackState` cannot answer this: it keeps reporting what the transport
   * settled on before the seek, so a seek of any length reads as paused or
   * playing.
   *
   * A scrub sets this on every tick, so a host that draws it owes the viewer a
   * delay before it appears, and owes them `scrubbing` too: a viewer dragging
   * the playhead is not waiting for the picture, they are leading it.
   *
   * It answers for the transport, which settles one message before the frame it
   * landed on reaches this thread. In that window the picture on screen is the
   * cached stand-in the seek painted on its way out, which can be a quarter of a
   * second from the frame requested, while this already reads false. A host that
   * needs "is the right picture up" should compare the presented frame's own
   * media time; reading a position the instant a seek resolves can return a
   * frame that was never asked for.
   */
  readonly seeking?: boolean;
  /**
   * Whether a drag is open on the playhead. True from the first scrub of a
   * gesture until the seek that lands it, which is what separates a viewer
   * leading the picture from one waiting on it.
   */
  readonly scrubbing?: boolean;
  readonly detectionBuffer: DetectionBufferState;
  readonly lastFrameRenderTimings: MediaFrameRenderTimings | null;
  readonly source: MediaSourceState;
}

/**
 * Current annotation renderer, interaction, visibility, and scene presentation.
 */
export interface MediaRendererPresentation {
  /**
   * Renderer canvas color shown around media that is letterboxed or not yet
   * presented. Hosts can update this with their color theme without recreating
   * the media session.
   */
  readonly backgroundColor?: number;
  readonly annotationOverlayStyle?: AnnotationOverlayStyle | null;
  /**
   * Built-in renderers that contribute semantic annotations to the
   * renderer-owned scene. When present, this list selects the enabled
   * built-in layers. Style-backed descriptors resolve into their established
   * presentation fields, while direct descriptors such as `region` retain
   * their semantic configuration for the backend. Existing style fields remain
   * supported for compatibility and source-specific presentation overrides.
   */
  readonly renderers?: readonly AnnotationRenderer[];
  readonly boxStyle?: BoxStyle | null;
  readonly boxCornerStyle?: BoxCornerStyle | null;
  readonly focusStyle?: FocusStyle | null;
  readonly interactionStyle?: InteractionStyle | null;
  readonly labelStyle?: LabelStyle | null;
  readonly maskHaloStyle?: MaskHaloStyle | null;
  readonly maskStyle?: MaskStyle | null;
  readonly markerStyle?: MarkerStyle | null;
  readonly polygonStyle?: PolygonStyle | null;
  readonly polylineStyle?: PolylineStyle | null;
  readonly ellipseStyle?: EllipseStyle | null;
  readonly keypointStyle?: KeypointStyle | null;
  readonly visibility?: AnnotationVisibility;
}

export interface AnnotationVisibility {
  readonly annotationsHidden?: boolean;
  readonly labelsHidden?: boolean;
  readonly hiddenClasses?: ReadonlySet<string> | readonly string[];
  readonly hiddenDetectionIds?:
    ReadonlySet<string | number> | readonly (string | number)[];
  readonly loadingDetectionIds?:
    ReadonlySet<string | number> | readonly (string | number)[];
  readonly ephemeralDetectionIds?:
    ReadonlySet<string | number> | readonly (string | number)[];
  readonly creatingDetectionId?: string | number | null;
}

export interface MediaDisplayAdjustments {
  /** Normalized contrast where 1 is unchanged. */
  readonly contrast?: number;
  /** Normalized brightness where 1 is unchanged. */
  readonly brightness?: number;
}

/**
 * Runtime renderer quality controls.
 */
export interface MediaRendererQuality {
  /**
   * Caps render resolution relative to device pixels.
   *
   * Unset, non-finite, or non-positive takes the library's own ceiling of 2,
   * which is what keeps the presentation surface, the mask rasters drawn onto
   * it, and the decode under both on one pixel grid. Pass
   * `window.devicePixelRatio` to rasterize at the display's full ratio.
   */
  readonly maxDevicePixelRatio?: number;
}

/**
 * Minimal state-bearing renderer controller contract.
 */
export interface MediaRendererStateController {
  setPresentation(presentation: MediaRendererPresentation): void;
  setRenderQuality(quality: MediaRendererQuality): void;
  setDisplayAdjustments?(adjustments: MediaDisplayAdjustments): void;
  getViewportTransform?(): ViewportTransform;
  setViewportTransform?(
    transform: Partial<Omit<ViewportTransform, "locked">>,
  ): void;
  setViewportLocked?(locked: boolean): void;
  screenToMedia?(point: Point): Point;
  mediaToScreen?(point: Point): Point;
  panViewportBy?(dx: number, dy: number): void;
  zoomViewportAt?(point: Point, factor: number): void;
  zoomViewportFromWheel?(point: Point, deltaY: number): void;
  getActiveDetectionFrame(): DetectionFrame | null;
  getState(): MediaRendererState;
}
