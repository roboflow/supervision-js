import type { CreateScrubCursorOptions } from "./create-scrub-cursor";
import type { FrameCacheStats } from "./frame-cache";
import type { FrameId, FrameTimeline } from "./frame-timeline";
import type { GopStats } from "./keyframe-index";
import type { Rotation } from "./rotation";
import type { DecodePath, Sec } from "./types";

/**
 * How good a painted frame is. "exact" is a full decode-resolution frame;
 * "preview" is the coarse downscaled stand-in the cache serves at once while a
 * crisp one decodes. The two look materially different on screen, so anything
 * reporting what was painted has to say which it was.
 */
export type FrameQuality = "exact" | "preview";

export enum ScrubCursorState {
  Idle = "idle",
  Seeking = "seeking",
  Closed = "closed",
}

/** Fields every paint-ready frame carries, independent of how its pixels reach
 *  the renderer. */
export interface ScrubFrameBase {
  readonly timestampS: Sec;
  readonly width: number;
  readonly height: number;
  readonly isKeyFrame: boolean;
  readonly quality: FrameQuality;
}

/**
 * The structural slice of mediabunny's VideoSample the runtime touches: enough
 * to draw it into a 2D canvas, hand its pixels to WebGPU without an intermediate
 * transfer copy where the selected path supports that, and release it. Kept as
 * a slice rather than the concrete class so the runtime never
 * imports mediabunny and stays fake-injectable under test.
 *
 * close() is the caller's obligation and is made idempotent at the cursor
 * boundary, so a sample drawn into the cache, painted, and then closed on
 * teardown is closed at most once for real.
 */
export interface VideoSampleLike {
  /**
   * A fresh VideoFrame per call; the caller closes the returned frame.
   *
   * The frame carries the stored pixels and NOT the track's rotation, on this
   * and on mediabunny's own implementation, which drops it deliberately. So
   * whoever takes one owes it the turn named by `rotation` below.
   */
  toVideoFrame(): VideoFrame;
  /** The sample owns storage independent of a decoder output pool, so a host
   * transfer may rewrap it without copying its pixels again. */
  readonly independentPixels?: true;
  /** The turn the pixels still need, already applied by draw() and dropped by
   *  toVideoFrame(). */
  readonly rotation: Rotation;
  draw(
    context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    dx: number,
    dy: number,
    dWidth?: number,
    dHeight?: number,
  ): void;
  close(): void;
  readonly timestamp: number;
  readonly duration: number;
}

/**
 * A paint-ready frame yielded by the cursor, tagged by how its pixels reach the
 * renderer.
 *
 * A canvas frame carries a canvas and no close obligation: it is a cache blit
 * or a CanvasSink decode. WebGPU uploads it with copyExternalImageToTexture,
 * which accepts neither an SVG image nor a video element. A sample frame carries
 * a live VideoSample that an eligible VideoSampleSink route can import directly
 * into WebGPU. A DecodeSession route may first materialize independently owned
 * pixels. Whoever stashes the sample owns its close, so only fresh decodes on
 * the sample source produce one.
 */
export interface CanvasScrubFrame extends ScrubFrameBase {
  readonly kind: "canvas";
  readonly source: OffscreenCanvas | HTMLCanvasElement;
}

export interface SampleScrubFrame extends ScrubFrameBase {
  readonly kind: "sample";
  readonly sample: VideoSampleLike;
}

export type ScrubFrame = CanvasScrubFrame | SampleScrubFrame;

/**
 * The turn a frame's raw pixels still need. A canvas frame has none left: a
 * CanvasSink decode arrives upright, and a cache blit was drawn through a
 * sample's own draw, which applies it. Only a live sample still owes one.
 */
export function frameRotation(frame: ScrubFrame): Rotation {
  return frame.kind === "sample" ? frame.sample.rotation : 0;
}

/**
 * Wraps a raw sample so its close() runs at most once, then no-ops. The
 * lifetime is hard to keep linear: a sample is drawn into the cache, stashed for
 * paint, then closed after paint, and may be closed again on teardown if a
 * gesture left it unpainted. An idempotent close lets every path call it
 * defensively without double-free.
 */
export function idempotentSample(sample: VideoSampleLike): VideoSampleLike {
  let closed = false;
  return {
    toVideoFrame: () => sample.toVideoFrame(),
    independentPixels: sample.independentPixels,
    rotation: sample.rotation,
    draw: (ctx, dx, dy, dWidth, dHeight) =>
      sample.draw(ctx, dx, dy, dWidth, dHeight),
    close: () => {
      if (closed) return;
      closed = true;
      sample.close();
    },
    get timestamp() {
      return sample.timestamp;
    },
    get duration() {
      return sample.duration;
    },
  };
}

export type ScrubFrameListener = (frame: ScrubFrame) => void;

/** A frame considered for the screen, and what is already on it. */
export interface ScreenCandidate {
  readonly timestampMs: number;
  readonly quality: FrameQuality;
}

/**
 * Whether a frame earns the screen over what is already showing, judged from
 * where the user is pointing rather than from what happens to be up. Closer
 * wins; equally close wins only by being sharper, since repainting the same
 * ground with the same or worse pixels is a visible change for no information.
 *
 * Both painters share this. They used to disagree: one applied it to coarse
 * frames only and the other to everything, so which rule you got depended on
 * which path served the frame.
 */
export function earnsScreen(
  candidate: ScreenCandidate,
  showing: ScreenCandidate | null,
  targetMs: number,
): boolean {
  if (!showing) return true;
  const candidateGap = Math.abs(candidate.timestampMs - targetMs);
  const showingGap = Math.abs(showing.timestampMs - targetMs);
  if (candidateGap !== showingGap) return candidateGap < showingGap;
  return candidate.quality === "exact" && showing.quality === "preview";
}

/** Rolling scrub-decode latency, in milliseconds, since the cursor opened.
 *  p50Ms/p95Ms are percentiles over a bounded recent-sample ring, so a single
 *  slow region shows up in p95 without dragging the all-time avg. targetVsLandedMs
 *  is how far the last exact seek landed from where it aimed (long-GOP forces a
 *  distant anchor); timeToCrispMs is the gap between a preview paint and the crisp
 *  decode that replaced it on the same seek. */
export interface ScrubLatencyStats {
  readonly samples: number;
  readonly lastMs: number;
  readonly avgMs: number;
  readonly maxMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly targetVsLandedMs: number;
  readonly timeToCrispMs: number;
}

/** Decodes the scheduler has run, split by why. foreground is a gesture-driven
 *  seek/step/play pull; the prefetch counts are background sweep fills per tier;
 *  keyframeAnchored is a key-only seek landing on its anchor. Counters only, never
 *  reset, so ratios over a session describe where decode bandwidth went. */
export interface DecodeCounters {
  readonly foreground: number;
  readonly prefetchExact: number;
  readonly prefetchPreview: number;
  readonly keyframeAnchored: number;
  /** Frames the decode machinery has produced since open, all paths, walk
   *  pre-roll included where the path can see it. The pipeline ledger's
   *  decoded column. */
  readonly framesOut: number;
  /** Forward-playback pulls in flight (0 or 1); a free read of the drain latch. */
  readonly nextPending: number;
}

/** Seeks the scheduler has serviced. exact is a full-resolution scrub; key is a
 *  key-only navigation seek; coalesceDepth counts how often a pending target was
 *  overwritten before it drained (the decoder falling behind a fast drag). */
export interface SeekCounters {
  readonly exact: number;
  readonly key: number;
  readonly coalesceDepth: number;
}

/** Background prefetch sweep liveness: whether a sweep is decoding right now and
 *  the generation token (bumped by every foreground gesture, so a jumping value
 *  is a churning sweep that never warms the cache). */
export interface PrefetchState {
  readonly inFlight: boolean;
  readonly generation: number;
}

/**
 * Observability snapshot a caching cursor can report: how often the cache
 * answered a scrub, and how long the misses took to decode. Cache hit-rate and
 * decode latency together describe perceived scrub responsiveness.
 */
/**
 * Why the playhead is moving. A hand on a timeline keeps feeding positions, so
 * the runtime reads their direction and speed to decide what to prepare next.
 * A jump produces one position and no motion to read, so prediction from the
 * positions around it would be prediction from a gesture nobody is making.
 */
export type SeekIntent = "gesture" | "jump";

/** The decode window the scheduler is filling around the playhead, in ms. */
/** The decode targets the next background sweep would aim at, given what the
 *  runtime currently knows. A bounds pair cannot represent a hole, and holes
 *  are what a coverage instrument exists to show. */
export interface PrefetchPlan {
  readonly targetsMs: number[];
}

export interface SchedulerStats {
  /** The runtime's live read of how the consumer is moving (idle/scrubbing/
   *  stepping/playing). The single highest-signal field for a human watching
   *  the engine interpret their gesture. */
  readonly mode: string;
  /** Which decode machinery this source was opened through. Resolved once at
   *  open from the track and the realm; a hang-recovery rebuild re-resolves
   *  it, so a path change here means the source was re-opened. */
  readonly decodePath: DecodePath;
  readonly cache: FrameCacheStats;
  readonly scrub: ScrubLatencyStats;
  readonly decode: DecodeCounters;
  readonly seek: SeekCounters;
  /** GOP-gap distribution over the keyframes discovered so far. A long maxGopS
   *  is the badly-encoded-source tell every off-anchor scrub pays for. */
  readonly gop: GopStats;
  /** Container round-trips the keyframe index has made resolving anchors; the
   *  rest resolve from memory. */
  readonly probeRoundTrips: number;
  /** Discovered keyframe timestamps (ms), ascending. Lazy: grows as the source
   *  is scrubbed/swept, so it shows what the runtime actually knows. */
  readonly keyframesMs: number[];
  /** The targets the scheduler would prefetch around the playhead, or null
   *  while playing (the forward stream iterator covers ahead). */
  readonly prefetch: PrefetchPlan | null;
  /** Background sweep liveness (in-flight + generation token). */
  readonly prefetchState: PrefetchState;
  /** Cache lookup tolerances, so a timeline can draw the "served" bands. */
  readonly exactToleranceMs: number;
  readonly previewToleranceMs: number;
  /** True after a decode hung on a non-re-openable source: the decoder could
   *  not be rebuilt, so the runtime is degraded (decodes no-op) but not frozen.
   *  Lets a consumer surface the state rather than show a silent freeze. */
  readonly decoderDead: boolean;
  /** True once the decoder is judged unable to decode this source at all: it
   *  refused to configure, it errored, or it acknowledged decode requests and
   *  produced nothing. Distinct from decoderDead, which is a rebuild the
   *  source made impossible; this one survives every rebuild, so the runtime
   *  stops rebuilding. The transport reads Errored at the same moment. */
  readonly decoderStalled: boolean;
  /** State of the seek drain. Every play pull is refused while a seek drains,
   *  so a drain that never finishes shows on screen as playback dying with no
   *  other symptom: without this the panel can say the pump is dead but not
   *  that a seek is the reason. */
  readonly drain: DrainState;
}

export interface DrainState {
  /** A seek is being serviced right now, which refuses every play pull. */
  readonly draining: boolean;
  /** Target waiting behind the one being serviced, in ms, or null. */
  readonly pendingTargetMs: number | null;
  /** A hung-decode rebuild is in progress. */
  readonly recovering: boolean;
}

/**
 * Resolved track facts the engine reads after open(). width/height are the
 * source's native resolution (used for aspect, metadata, cache sizing).
 * decodeWidth/decodeHeight are the resolution frames are actually decoded to
 * after the decode-resolution strategy runs, and size the visible canvas
 * backing store. They equal native unless a downscaling strategy is in play.
 */
export interface ScrubTrackInfo {
  readonly width: number;
  readonly height: number;
  readonly decodeWidth: number;
  readonly decodeHeight: number;
  /**
   * The track's quarter turn. Every dimension above is the display size, so all
   * four already account for it. This exists for the pixels, which do not.
   */
  readonly rotation: Rotation;
  readonly nativeFps: number | null;
  readonly durationS: Sec;
  /**
   * Timestamp of the track's first sample, in seconds. Usually near zero but
   * may be positive (a trimmed clip) or negative (offset timing). The seed
   * seek and seek clamping use it as the origin so a non-zero start does not
   * mis-seek to t=0.
   */
  readonly firstTimestampS: Sec;
  /** Every real frame of this track, by its container tick timestamp. The one
   *  place a frame's identity is defined; everything else snaps into it. */
  readonly timeline: FrameTimeline;
}

/**
 * Random-access cursor over a video source: the seam between the engine and
 * the mediabunny primitives it wraps.
 *
 * The implementation (CanvasSinkScrubCursor) rides CanvasSink.getCanvas(t)
 * for random-access seeks, which does the keyframe walk and GOP decode
 * internally, and a sink.canvases(start) iterator for forward playback that
 * lives only between attachPlay and detachPlay. The interface is kept as a
 * seam so a future mediabunny SampleCursor backend can replace the
 * implementation without touching consumers.
 *
 * Contract notes consumers rely on:
 *   - seekTo coalesces concurrent seeks latest-wins, so rapid pointermove
 *     scrubs collapse to the most recent target.
 *   - seekToKey lands on the sample at or before t and marks the emitted
 *     frame as a keyframe result.
 *   - next is VFR-correct and a no-op while paused (no iterator attached),
 *     so it never advances media time across a paused canvas. The 1/fps step
 *     approximation lives in WebVideoEngine.step, not here.
 *   - isIdle is true only when no seek is draining and no pull is in flight.
 *   - subscribe replays the most recent frame to a new listener so the seed
 *     frame from open() is never dropped.
 *   - close is final; reusing a closed cursor is a programming error.
 */
export interface ScrubCursor {
  readonly state: ScrubCursorState;
  readonly track: ScrubTrackInfo;
  readonly isIdle: boolean;

  open(): Promise<void>;
  seekTo(timestamp: Sec, intent?: SeekIntent): void;
  seekToKey(timestamp: Sec): void;
  next(): void;
  /**
   * Attach a forward-playback iterator anchored at startS. Required for
   * next() to advance; paused mode keeps no iterator.
   */
  attachPlay(startS: number): void;
  /** Detach the forward-playback iterator. */
  detachPlay(): void;
  /**
   * Decode the named frame of the source and emit it through the listener
   * chain. Returns the emitted ScrubFrame, or null at a boundary or once
   * closed. Steps are index arithmetic on the frame table, so a caller names
   * the frame it wants and not a time near it.
   */
  seekToFrame(frame: FrameId): Promise<ScrubFrame | null>;
  idle(): Promise<void>;
  /**
   * Resolves at the seek drain's next settle: whichever target it is servicing
   * has landed. The wait spans one decode. idle() spans the whole gesture,
   * since a drag re-arms the drain on every pointer move, so a caller that has
   * to answer while the hand is still down asks this one.
   */
  seekSettled(): Promise<void>;
  /**
   * Registers a frame listener. The cache replays the most recently emitted
   * frame synchronously on subscribe so the seed frame from open() is
   * delivered to controllers that wire up afterwards.
   */
  subscribe(listener: ScrubFrameListener): () => void;
  /**
   * Synchronous best-effort cache lookup the render loop calls on scrub to
   * paint a frame this same tick, before the full-res decode resolves. The
   * uncached implementation returns null; the caching scheduler returns the
   * closest cached frame within tolerance, or null on a miss.
   */
  peekCached(timeMs: number): ScrubFrame | null;
  /**
   * Observability snapshot (cache hit-rate, scrub-decode latency). Present
   * only on the caching backend; the uncached cursor omits it.
   */
  /** Decoded frames the consumer may hold ahead of the playhead; see
   *  FrameProvider.playReadAhead. Absent on cursors with no decode path of
   *  their own, where the caller falls back to the canvas depth. */
  readonly playReadAhead?: number;
  getStats?(): SchedulerStats;
  /**
   * Eagerly walks the whole track's keyframes into the index, metadata only,
   * so the diagnostics keyframe lane reflects the entire file rather than just
   * the swept regions. Idempotent and off the hot seek path. Present only on
   * the caching backend (the uncached cursor keeps no index); callers invoke
   * it from the diagnostics layer, never during a gesture.
   */
  ensureKeyframeIndex?(): Promise<void>;
  close(): Promise<void>;
}

export type ScrubCursorFactory = (
  options: CreateScrubCursorOptions,
) => Promise<ScrubCursor>;
