import { PLAYBACK_RATE } from "./constants";
import type { FrameTimelineData } from "./frame-timeline";

/**
 * Seconds, as a branded float. Promoted out of `number` so a duration
 * cannot accidentally be passed where a frame index is expected.
 */
export type Sec = number & { readonly __sec: unique symbol };

/** Frames per second. Branded for the same reason as Sec. */
export type Fps = number & { readonly __fps: unique symbol };

/**
 * Paints since the source loaded, monotonic within it and reset on source swap.
 * It counts paints, not frames of the source: two paints of the same media
 * position (a coarse stand-in then the crisp decode) take two numbers, and
 * nothing here identifies which frame of the source is on screen. That identity
 * travels only as the media timestamp on the paint event.
 */
export type PaintSeq = number & { readonly __paintSeq: unique symbol };

export const asSec = (n: number): Sec => n as Sec;
export const asFps = (n: number): Fps => n as Fps;
export const asPaintSeq = (n: number): PaintSeq => n as PaintSeq;

export enum SourceKind {
  Url = "url",
  Blob = "blob",
  Stream = "stream",
}

export interface UrlVideoSource {
  kind: SourceKind.Url;
  url: string;
  id?: string;
  crossOrigin?: "anonymous" | "use-credentials";
}

export interface BlobVideoSource {
  kind: SourceKind.Blob;
  blob: Blob;
  id?: string;
}

export interface StreamVideoSource {
  kind: SourceKind.Stream;
  stream: ReadableStream<Uint8Array>;
  mimeType: string;
  id?: string;
}

/**
 * Source descriptor. Discriminated so each backend can route without runtime
 * sniffing and so the future mediabunny v2 StreamSource slots in as a new
 * variant rather than a refactor.
 *
 * Pass a stable `id` when the same underlying media is consumed by multiple
 * players so adapters can share metadata probes.
 */
export type VideoSource = UrlVideoSource | BlobVideoSource | StreamVideoSource;

/**
 * Which decode machinery a source was opened through: mediabunny's CanvasSink,
 * mediabunny's VideoSampleSink, or the runtime's own long-lived DecodeSession.
 * Resolved per source at open time from what the track and the realm support.
 */
export type DecodePath = "canvas" | "sample" | "session";

/**
 * Who owns the pixels. "canvas" is the engine: it holds a display canvas and
 * paints every frame that earns the screen. "frames" is the host: the engine
 * holds no canvas, paints nothing, and hands each of those frames out as a
 * VideoFrame instead, so an external compositor can own the only canvas.
 */
export type PresentationMode = "canvas" | "frames";

/**
 * Coarse-grained engine status. Updates rarely (load, play, pause, end,
 * error). Sits on its own emit channel so subscribers do not wake up on
 * 60Hz time ticks.
 */
export enum PlaybackStatus {
  Idle = "IDLE",
  Loading = "LOADING",
  Ready = "READY",
  Playing = "PLAYING",
  Paused = "PAUSED",
  Seeking = "SEEKING",
  Ended = "ENDED",
  Errored = "ERRORED",
}

export enum VideoEngineErrorCode {
  DecodeUnsupported = "DECODE_UNSUPPORTED",
  SourceUnreadable = "SOURCE_UNREADABLE",
  BackendCrashed = "BACKEND_CRASHED",
  Aborted = "ABORTED",
  /** A canvas was offered to an engine loaded in "frames" presentation mode,
   *  where the host owns the only canvas. */
  PresentationMismatch = "PRESENTATION_MISMATCH",
  /**
   * The decoder cannot decode this source at all: it refused to configure, it
   * errored, or it acknowledged decode requests and never produced a frame.
   * Distinct from BackendCrashed, which a rebuild can recover; this one
   * survives every rebuild, so the runtime stops rebuilding and says so. The
   * usual cause is outside the page: another tab holding every hardware
   * decoder session the machine has.
   */
  DecoderStalled = "DECODER_STALLED",
  /** A playback rate outside the forward range the engine supports. */
  RateUnsupported = "RATE_UNSUPPORTED",
}

/**
 * Thrown by createScrubCursor / VideoEngine.load when decode is unsupported
 * or the source is unreadable. Branch on `error.code` (VideoEngineErrorCode)
 * to differentiate decode failures from network failures.
 */
export class VideoEngineError extends Error {
  readonly code: VideoEngineErrorCode;
  readonly cause?: unknown;
  constructor(code: VideoEngineErrorCode, message: string, cause?: unknown) {
    super(message);
    this.code = code;
    this.cause = cause;
  }
}

/** Shared by the facade and the core so a host gets the same refusal wherever
 *  its canvas is caught. */
export function canvasBindingRefused(): VideoEngineError {
  return new VideoEngineError(
    VideoEngineErrorCode.PresentationMismatch,
    'presentation "frames" leaves the canvas to the host: this engine paints nothing and hands out VideoFrames instead',
  );
}

/**
 * Validates a requested playback rate and returns it. The facade and the core
 * both call it, so a rate is refused at whichever boundary it arrives at and
 * with the same message: the facade posts fire-and-forget, so a refusal raised
 * only in the worker would reach nobody.
 *
 * Reverse is rejected, not clamped: backwards playback is a different decode
 * problem, and a -1 quietly serviced as +0.25 plays the wrong direction while
 * reporting success.
 */
export function resolvePlaybackRate(rate: number): number {
  if (
    !Number.isFinite(rate) ||
    rate < PLAYBACK_RATE.MIN ||
    rate > PLAYBACK_RATE.MAX
  ) {
    throw new VideoEngineError(
      VideoEngineErrorCode.RateUnsupported,
      `playback rate ${rate} is outside the supported forward range ${PLAYBACK_RATE.MIN}-${PLAYBACK_RATE.MAX}; reverse playback is not supported`,
    );
  }
  return rate;
}

export interface PlaybackState {
  status: PlaybackStatus;
  error: VideoEngineError | null;
}

export interface VideoMetadata {
  durationMs: number;
  nativeFps: Fps | null;
  naturalWidth: number;
  naturalHeight: number;
  /** Media time of the first sample, ms. Non-zero on trimmed/offset sources,
   *  where an annotation timeline that assumes 0 drifts by exactly this. */
  firstTimestampMs: number;
  codec: string | null;
  canDecode: boolean;
}

/**
 * Snapshot delivered through the `onReady` lifecycle callback exactly once
 * per loaded source after metadata resolves.
 */
export interface EngineReadySnapshot extends VideoMetadata {
  /**
   * Every real frame of the source, by its container tick timestamp. A host
   * holding this can name any position the engine publishes, and can resolve
   * one of its own pointer positions to a frame without asking.
   */
  readonly timeline: FrameTimelineData;
}

/**
 * Channels the engine store emits on. Pick the channel matching the slice
 * cadence so consumers do not wake up on unrelated mutations.
 *
 *   - time:     emits per paint (raw ms; bucketing lives in hook selectors).
 *   - frame:    emits per settled cursor frame (frame-index changes).
 *   - state:    coarse status transitions (load, play, pause, end, error).
 *   - duration: once per loaded source.
 *   - seeking:  cursor scrub-in-flight transitions (opt-in indicator).
 *   - rate:     playback-rate changes. Rare, and on its own channel so a rate
 *               readout does not wake on status and vice versa.
 */
export type EngineChannel =
  "time" | "frame" | "state" | "duration" | "seeking" | "rate";
