import type { FrameId, FrameLanding } from "./frame-timeline";
import type { FrameQuality, SeekIntent } from "./scrub-cursor";
import type { DecodeResolutionStrategy } from "./decode-resolution";
import type { DiagnosticsSnapshot, EngineDiagnostics } from "./diagnostics";
import type { EngineTrace } from "./trace-recorder";
import { asPaintSeq, VideoEngineError } from "./types";
import type {
  EngineReadySnapshot,
  PlaybackStatus,
  PresentationMode,
  VideoEngineErrorCode,
  VideoSource,
} from "./types";
import type { MirrorStore } from "./mirror-store";

/**
 * Wire contract between the main-thread VideoEngine facade and the dedicated
 * worker that hosts the decode + render loop. Three planes cross the boundary:
 *
 *   - Control plane: EngineCommand, main -> worker. Fire-and-forget commands
 *     carry no requestId; awaitable ones carry a requestId the worker echoes
 *     back in its response so the facade can settle the matching promise.
 *   - State plane: the broadcast EngineEvent variants (playhead/frame/status/
 *     duration/seeking), worker -> main, fed into the mirror store by
 *     applyMirrorEvent so useSyncExternalStore reads stay synchronous.
 *   - Pixel plane: shaped by the load's presentation mode. Under "canvas" it is
 *     not modeled here: the OffscreenCanvas rides the bindCanvas command's
 *     transfer list once and pixels never cross again. Under "frames" the engine
 *     paints nothing and every frame that earns the screen crosses as a
 *     PresentedFrameEvent, its VideoFrame on that message's transfer list.
 *
 * Everything here is structured-clone safe (no class instances besides the
 * transferable OffscreenCanvas and VideoFrame, no closures), which is what lets
 * the decode strategy and source descriptors travel as plain data.
 */

export type RequestId = number;

/** A VideoEngineError flattened to its clone-safe fields. cause is dropped at
 *  the boundary; consumers branch on code, not on the original cause chain. */
export interface SerializedEngineError {
  readonly code: VideoEngineErrorCode;
  readonly message: string;
}

export function serializeEngineError(
  error: VideoEngineError,
): SerializedEngineError {
  return { code: error.code, message: error.message };
}

export function deserializeEngineError(
  error: SerializedEngineError | null,
): VideoEngineError | null {
  return error ? new VideoEngineError(error.code, error.message) : null;
}

/** Canvas-box measurement taken on the main thread (layout lives there) and
 *  shipped to the worker so a viewport decode strategy can size the sink. */
export interface SerializedViewport {
  readonly displayWidth: number | null;
  readonly devicePixelRatio: number;
}

/**
 * The serializable subset of VideoEngineOptions the worker needs to build the
 * engine. Omits `clock` (a class instance the worker constructs itself) and
 * `source` (carried separately on the load command).
 */
export interface SourceResidencyConfig {
  /** Ceiling on held source bytes. */
  readonly budgetBytes: number;
  /** Pull the parts of the file nobody has read yet, while the link is idle. */
  readonly prefetch?: boolean;
}

export interface EngineLoadConfig {
  readonly source: VideoSource;
  /** Defaults to "canvas". "frames" leaves the engine canvas-less and routes
   *  every presented frame out on the pixel plane instead. */
  readonly presentation?: PresentationMode;
  readonly cacheStrategy?: "tiered" | "none";
  readonly previewCapacity?: number;
  readonly previewWidth?: number;
  readonly cacheSkipNearMs?: number;
  readonly decodeStrategy?: DecodeResolutionStrategy;
  /** Pin the 2D renderer; unset prefers WebGPU with a 2D fallback. */
  readonly prefer2d?: boolean;
  readonly sourceResidency?: SourceResidencyConfig;
}

// ---------------------------------------------------------------------------
// Control plane: main -> worker
// ---------------------------------------------------------------------------

/** Hands the transferred display canvas and its measured box to the worker.
 *  The canvas rides this message's transfer list exactly once. */
export interface BindCanvasCommand {
  readonly type: "bindCanvas";
  readonly canvas: OffscreenCanvas;
  readonly viewport: SerializedViewport;
}

export type FireAndForgetCommand =
  | BindCanvasCommand
  | { readonly type: "unbindCanvas" }
  | {
      readonly type: "scrub";
      readonly frameIndex: number;
      readonly intent?: SeekIntent;
    }
  | { readonly type: "pause" }
  | { readonly type: "togglePlayback" }
  | { readonly type: "beginInteractiveSeek" }
  // Fire-and-forget because the facade has already validated the rate against
  // the same range the core does, so the only reply worth waiting for is the
  // one the mirror carries anyway.
  | { readonly type: "setPlaybackRate"; readonly rate: number }
  // Diagnostics control plane. Starting the broadcast spins up the worker's
  // self.setInterval and flips the per-rAF counter gate; the rest are inert
  // until armed/started, so the engine pays nothing when no instrument listens.
  | { readonly type: "diagnosticsStart"; readonly hz: number }
  | { readonly type: "diagnosticsStop" }
  | { readonly type: "traceArm"; readonly windowMs: number }
  | { readonly type: "traceDisarm" };

export type AwaitableCommand =
  | {
      readonly type: "load";
      readonly requestId: RequestId;
      readonly config: EngineLoadConfig;
    }
  | { readonly type: "play"; readonly requestId: RequestId }
  | {
      readonly type: "commit";
      readonly requestId: RequestId;
      readonly frameIndex: number;
    }
  | {
      readonly type: "seekToKey";
      readonly requestId: RequestId;
      readonly timeMs: number;
    }
  | {
      readonly type: "step";
      readonly requestId: RequestId;
      readonly direction: 1 | -1;
    }
  | { readonly type: "endInteractiveSeek"; readonly requestId: RequestId }
  | { readonly type: "getStats"; readonly requestId: RequestId }
  | { readonly type: "traceExport"; readonly requestId: RequestId }
  | { readonly type: "dispose"; readonly requestId: RequestId };

export type EngineCommand = FireAndForgetCommand | AwaitableCommand;

// ---------------------------------------------------------------------------
// State plane + responses: worker -> main
// ---------------------------------------------------------------------------

/**
 * Where the transport has settled. Written by a paint here in the worker, or on
 * the main thread by a gesture the facade snapped through the frame timeline.
 * Never by a clock read and never by a raw request, so every value is a frame of
 * the source. Emitted from here only while playing: paused positions belong to
 * the main thread, so a late paint never yanks a settled playhead back.
 */
export interface PlayheadEvent {
  readonly type: "playhead";
  readonly frameId: FrameId;
  readonly mediaTimeS: number;
}

/**
 * Broadcast state. One variant per mirror-store channel; applyMirrorEvent maps
 * each to the matching writer.
 */
export type MirrorEvent =
  | PlayheadEvent
  | {
      readonly type: "frame";
      readonly paintSeq: number;
      /** Which frame of the source was painted, and whether it was a full
       *  decode or the coarse stand-in. Always present: without them a
       *  consumer knows a paint happened but not what or where, which is no
       *  use for judging whether the picture matches the playhead.
       *  applyMirrorEvent ignores them. */
      readonly frameId: FrameId;
      readonly mediaTimeS: number;
      readonly quality: FrameQuality;
      /** Live catch-up depth, folded on only while diagnostics are enabled
       *  and playing, so the realtime needle reaches main at native cadence
       *  with no extra message. */
      readonly catchUpMs?: number;
    }
  | {
      readonly type: "status";
      readonly status: PlaybackStatus;
      readonly error: SerializedEngineError | null;
    }
  | { readonly type: "duration"; readonly durationMs: number }
  | { readonly type: "seeking"; readonly seeking: boolean }
  | { readonly type: "rate"; readonly rate: number };

/**
 * Correlated responses to awaitable commands. `ready` answers load with the
 * resolved metadata;  `ack` answers everything else and carries the
 * frame a seek or a step settled on, which only the worker knows; `error`
 * rejects the matching promise.
 */
export type ResponseEvent =
  | {
      readonly type: "ready";
      readonly requestId: RequestId;
      readonly metadata: EngineReadySnapshot;
    }
  | {
      readonly type: "ack";
      readonly requestId: RequestId;
      readonly landing?: FrameLanding;
    }
  | {
      readonly type: "stats";
      readonly requestId: RequestId;
      readonly stats: EngineDiagnostics | null;
    }
  | {
      readonly type: "traceExport";
      readonly requestId: RequestId;
      readonly trace: EngineTrace | null;
    }
  | {
      readonly type: "error";
      readonly requestId: RequestId;
      readonly error: SerializedEngineError;
    };

/**
 * The diagnostics broadcast. A third EngineEvent arm, deliberately NOT a
 * MirrorEvent and NOT a ResponseEvent: it carries the heavy snapshot at
 * BROADCAST_HZ to a dedicated store, so it never enters the mirror reducer and
 * never wakes a playback subscriber.
 */
export interface DiagnosticsEvent {
  readonly type: "diag";
  readonly snapshot: DiagnosticsSnapshot;
}

/**
 * One frame handed out for a host compositor to draw, in "frames" presentation
 * mode. The receiver owns the VideoFrame and must close() it: a frame left open
 * pins a decoder buffer and stalls the decoder.
 *
 * Identity rides in the same message as the pixels and is reachable nowhere
 * else, so what a consumer holds and what it believes it holds cannot drift.
 */
export interface PresentedFrame {
  readonly paintSeq: number;
  /** Which frame of the source these pixels are. */
  readonly frameId: FrameId;
  /** `frameId.ticks / tickRate`, the one seconds value anyone publishes. */
  readonly mediaTimeS: number;
  /** The same position on the whole-millisecond plane, for a host that still
   *  speaks it. Derived, never an input to anything. */
  readonly mediaTimeMs: number;
  readonly quality: FrameQuality;
  /** Dimensions are the frame's own (codedWidth/codedHeight), so they are not
   *  restated alongside it. */
  readonly frame: VideoFrame;
}

/**
 * The pixel plane, worker -> main. A fourth EngineEvent arm, neither a
 * MirrorEvent nor a ResponseEvent: it is the only channel a presented frame has,
 * and the VideoFrame rides this message's transfer list, so the worker's
 * reference is detached the moment it is posted.
 */
export interface PresentedFrameEvent extends PresentedFrame {
  readonly type: "presentedFrame";
}

export type EngineEvent =
  MirrorEvent | ResponseEvent | DiagnosticsEvent | PresentedFrameEvent;

const MIRROR_EVENT_TYPES: ReadonlySet<string> = new Set([
  "playhead",
  "frame",
  "status",
  "duration",
  "seeking",
  "rate",
]);

/** True for broadcast state events only. 'diag' and 'presentedFrame' are
 *  excluded on purpose so both planes are routed before the mirror reducer ever
 *  sees them. */
export function isMirrorEvent(event: EngineEvent): event is MirrorEvent {
  return MIRROR_EVENT_TYPES.has(event.type);
}

/**
 * Pure reducer: applies one broadcast state event to the mirror store. The
 * store's own change-detection (write-on-change) decides whether subscribers
 * wake, so replaying an idempotent event is a no-op.
 */
export function applyMirrorEvent(store: MirrorStore, event: MirrorEvent): void {
  switch (event.type) {
    case "playhead":
      store.writePlayhead(event.frameId, event.mediaTimeS);
      return;
    case "frame":
      store.writePaintSeq(asPaintSeq(event.paintSeq));
      return;
    case "status":
      store.writeStatus(event.status, deserializeEngineError(event.error));
      return;
    case "duration":
      store.writeDurationMs(event.durationMs);
      return;
    case "seeking":
      store.writeSeeking(event.seeking);
      return;
    case "rate":
      store.writeRate(event.rate);
      return;
  }
}
