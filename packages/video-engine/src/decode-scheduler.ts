import { DIAGNOSTICS, PLAYBACK, HANG_RECOVERY } from "./constants";
import {
  type AnySourceHandle,
  type DecodedFrame,
  type FrameProvider,
  openFrameProvider,
} from "./decode-source";
import { type CachedFrame, FrameCache, FrameTier } from "./frame-cache";
import type { FrameId } from "./frame-timeline";
import { KeyframeIndex } from "./keyframe-index";
import {
  earnsScreen,
  type ScrubCursor,
  ScrubCursorState,
  type ScrubFrame,
  type ScrubFrameListener,
  type ScrubTrackInfo,
  type SchedulerStats,
  type SeekIntent,
  type PrefetchPlan,
} from "./scrub-cursor";
import { ScrubTrajectory } from "./scrub-trajectory";
import {
  asSec,
  type Sec,
  WebVideoEngineError,
  WebVideoEngineErrorCode,
} from "./types";

export interface DecodeSchedulerOptions {
  readonly source: AnySourceHandle;
  readonly cache: FrameCache;
  /** A cache hit within this of the target serves a crisp frame; default 50. */
  readonly exactToleranceMs?: number;
  /** A coarse hit within this of the target serves a preview; default 250. */
  readonly previewToleranceMs?: number;
  /** Millisecond time source for latency stats; defaults to performance.now. */
  readonly now?: () => number;
  /**
   * Opens a fresh source handle to replace a wedged decoder, or null when the
   * source cannot be re-opened (a one-shot stream). mediabunny decodes take no
   * AbortSignal, so a hung decode is uncancellable; the watchdog disposes the
   * dead provider and rebuilds from this seam so later decodes work. Omitted in
   * tests that do not exercise recovery, where the scheduler degrades instead.
   */
  readonly reopen?: (() => Promise<AnySourceHandle>) | null;
  /**
   * Hang ceiling for one random-access decode; defaults to the runtime
   * constant. A decode that outruns it is treated as failed and triggers
   * provider recovery. Overridable so a test can drive it with fake timers at a
   * small value.
   */
  readonly decodeHangTimeoutMs?: number;
  /**
   * Hang ceiling for the first-frame seed; defaults to the runtime constant,
   * which is tighter than the one above. Overridable so a test can drive it
   * with fake timers at a small value.
   */
  readonly seedHangTimeoutMs?: number;
  /**
   * Called once, with the failure, when the decoder is judged unable to decode
   * this source at all. Nothing else tells a consumer: a stalled decoder still
   * accepts every command and answers none of them, so without this the
   * transport reads as playing over a canvas that will never change again.
   */
  readonly onDecodeFailure?: (error: WebVideoEngineError) => void;
}

const DEFAULT_EXACT_TOLERANCE_MS = 50;
const DEFAULT_PREVIEW_TOLERANCE_MS = 250;
/** Watchdog-race sentinel; a distinct symbol so it never collides with a frame. */
const HUNG = Symbol("decode-hung");
/** Cancellation-race sentinel, in the same shape as HUNG. */
const ABANDONED = Symbol("prefetch-abandoned");
/**
 * What one watchdogged operation produced. A decode that resolved to no frame
 * and one the watchdog gave up on are the same `null` to a caller that only
 * wants a frame, and opposite answers to one deciding whether the decoder works.
 */
type Watchdogged<T> =
  { readonly answered: true; readonly value: T } | { readonly answered: false };
const UNANSWERED: Watchdogged<never> = { answered: false };
/** Frame interval fallback when the track exposes no measured rate. */
const FALLBACK_FPS = 30;
/** Rebuild attempts before a source is called dead rather than unlucky. */
const MAX_FAILED_REBUILDS = 3;
/**
 * Decode requests the live provider may leave unanswered before its decoder is
 * called stalled rather than unlucky. Counted in requests, and only requests
 * issued against the provider currently live: an idle engine owes nothing and
 * cannot reach the budget however long it sits, and a decode abandoned by a
 * rebuild is not charged to the rebuilt provider. Any answered decode clears it,
 * so a decoder that is working cannot be torn down by it.
 *
 * Where the source can be re-opened at all, a rebuild runs between each of
 * these, so reaching the budget means the source was re-opened that many times
 * and the decoder still answered nothing.
 */
const MAX_UNANSWERED_DECODES = 6;
/** Frames prefetched each side of the playhead while scrubbing. */
const SCRUB_WINDOW_FRAMES = 6;
/** Share of a scrub window spent ahead of a gesture that has a heading. The rest
 *  covers the ground just behind it, which is what a reversal lands on before the
 *  new heading is established. */
const WINDOW_LEAD_FRACTION = 0.75;
/** Frames prefetched each side while stepping; tighter than a scrub. */
const STEP_WINDOW_FRAMES = 2;
/** Seconds each side of the playhead the idle keyframe sweep covers. */
const PREVIEW_SWEEP_SPAN_S = 4;
/** Keyframes one idle sweep decodes; a short-GOP source offers far more inside
 *  the span than a background walk should hold the decoder for. */
const PREVIEW_SWEEP_MAX_FRAMES = 8;

/** Spends the sweep budget nearest the playhead, then returns to ascending
 *  order: the decoder flushes and re-walks the GOP on a backward step, so the
 *  batch it receives has to climb even though the budget was spent outward. */
function selectPreviewTargets(
  keyframesS: readonly number[],
  aroundS: number,
): number[] {
  return [...keyframesS]
    .sort((a, b) => Math.abs(a - aroundS) - Math.abs(b - aroundS))
    .slice(0, PREVIEW_SWEEP_MAX_FRAMES)
    .sort((a, b) => a - b);
}

/** How the consumer is moving, which shapes the prefetch window. */
enum AccessMode {
  Idle = "idle",
  Scrubbing = "scrubbing",
  Seeking = "seeking",
  Stepping = "stepping",
  Playing = "playing",
}

/**
 * Caching scrub cursor. Wraps the same decode primitives as CanvasSinkScrubCursor
 * but routes every random-access seek through a two-tier FrameCache and prefetches
 * a decode window around the playhead so the next move is already in hand.
 *
 * A scrub first reads the cache. An exact hit needs no decode. A preview hit
 * paints a coarse frame at once, then a crisp decode follows. A miss decodes
 * straight away. Once the foreground frame settles, a background sweep fills the
 * cache around the playhead, shaped by how the consumer is moving: neighbor
 * frames while scrubbing or stepping, a coarse keyframe pass while idle.
 *
 * A new gesture signals the sweep to bail and proceeds without waiting for it, so
 * speculative work never sits on the critical path; mediabunny builds a decoder
 * per iterator, so a sweep still unwinding alongside a foreground decode costs
 * memory, not correctness. Every decoded frame is copied into the cache, never
 * held as a raw VideoFrame, so the decoder is never pinned.
 */
export class DecodeScheduler implements ScrubCursor {
  private provider: FrameProvider;
  private readonly cache: FrameCache;
  private keyframeIndex: KeyframeIndex;
  private readonly trackInfo: ScrubTrackInfo;
  private readonly exactTolMs: number;
  private readonly previewTolMs: number;
  private readonly now: () => number;
  /** Re-opens the source after a hung decode, or null when it cannot be re-opened. */
  private readonly reopen: (() => Promise<AnySourceHandle>) | null;
  private readonly decodeHangTimeoutMs: number;
  private readonly seedHangTimeoutMs: number;
  /** Single-flight latch: a watchdog recovery already running. A second hang
   *  during the rebuild awaits the same recovery rather than racing a second
   *  dispose/rebuild of the provider. */
  private recovering: Promise<void> | null = null;
  /** True once a hang hit a non-re-openable source: the provider is dead and
   *  could not be rebuilt, so decodes no-op rather than hang. Surfaced via stats
   *  so a consumer can show a degraded state instead of a silent freeze. */
  private decoderDead = false;
  /** Consecutive failed rebuilds. One is a transient read; a run of them is a
   *  source that cannot be re-opened, which is what decoderDead describes. */
  private failedRebuilds = 0;
  /** True once the decoder is judged unable to decode this source at all. See
   *  SchedulerStats.decoderStalled; latched, and it stops the rebuild loop. */
  private decoderStalled = false;
  /** The failure markStalled latched, so a caller still awaiting a decode is
   *  handed the same one the consumer was told about rather than a parallel
   *  account of it. */
  private stallFailure: WebVideoEngineError | null = null;
  /** Decode requests the live provider has left unanswered in a row; see
   *  MAX_UNANSWERED_DECODES. */
  private unansweredDecodes = 0;
  private readonly onDecodeFailure:
    ((error: WebVideoEngineError) => void) | null;

  private iterator: AsyncGenerator<DecodedFrame, void, unknown> | null = null;
  private nextInFlight: Promise<void> = Promise.resolve();
  private nextPending = 0;

  private currentState = ScrubCursorState.Closed;
  private readonly listeners = new Set<ScrubFrameListener>();
  private idleResolvers: Array<() => void> = [];
  private settleResolvers: Array<() => void> = [];
  private pendingSeekTargetS: number | null = null;
  private pendingSeekKeyOnly = false;
  private seekDraining = false;
  private closed = false;
  private lastEmittedFrame: ScrubFrame | null = null;

  private mode = AccessMode.Idle;
  /** Recent scrub motion. Only its heading is read, which is what decides the
   *  side of the playhead a scrub window spends most of its budget on. */
  private readonly trajectory = new ScrubTrajectory();
  /** Outstanding background prefetch chain, or null once it unwinds. Awaited
   *  only by close(), so teardown cannot outrun a sweep still holding a decoder. */
  private prefetchTask: Promise<void> | null = null;
  /** Bumped when a running prefetch is cancelled; that prefetch bails when it
   *  sees the token move, which is how cancellation propagates. */
  private prefetchGen = 0;
  /** Whether a sweep is still depending on the live token. Cleared both by the
   *  cancellation that supersedes the sweep and by the sweep finishing. */
  private prefetchArmed = false;
  /** Woken when the token moves, so a sweep parked on a decode unwinds at the
   *  gesture rather than at the end of the decode it is parked on. */
  private abandonResolvers: Array<() => void> = [];

  private scrubSamples = 0;
  private scrubSumMs = 0;
  private scrubMaxMs = 0;
  private scrubLastMs = 0;
  /** Ring of recent scrub-decode latencies for p50/p95. Overwrite-oldest so the
   *  percentile tracks the recent region, not an all-time tail. One push/seek. */
  private readonly scrubLatencyRing = new Float64Array(
    DIAGNOSTICS.SCRUB_LATENCY_RING,
  );
  private scrubLatencyCount = 0;
  private scrubLatencyHead = 0;
  private targetVsLandedLastMs = 0;
  private timeToCrispLastMs = 0;

  // Per-decode / per-seek counters. Incremented only at points that already
  // run once per decode or seek, never per-pixel or per-rAF, so they cost
  // nothing the engine wasn't already paying.
  private foregroundDecodes = 0;
  private prefetchExactFrames = 0;
  private prefetchPreviewFrames = 0;
  private keyframeAnchoredEmits = 0;
  private exactSeeks = 0;
  private keySeeks = 0;
  private seekCoalesceOverwrites = 0;

  constructor(options: DecodeSchedulerOptions) {
    this.provider = openFrameProvider(options.source);
    this.cache = options.cache;
    this.keyframeIndex = new KeyframeIndex(this.provider.keyframeProbe);
    this.trackInfo = this.provider.track;
    this.exactTolMs = options.exactToleranceMs ?? DEFAULT_EXACT_TOLERANCE_MS;
    this.previewTolMs =
      options.previewToleranceMs ?? DEFAULT_PREVIEW_TOLERANCE_MS;
    this.now = options.now ?? (() => performance.now());
    this.reopen = options.reopen ?? null;
    this.decodeHangTimeoutMs =
      options.decodeHangTimeoutMs ?? HANG_RECOVERY.DECODE_HANG_TIMEOUT_MS;
    this.seedHangTimeoutMs =
      options.seedHangTimeoutMs ?? HANG_RECOVERY.SEED_HANG_TIMEOUT_MS;
    this.onDecodeFailure = options.onDecodeFailure ?? null;
  }

  get state(): ScrubCursorState {
    return this.currentState;
  }
  get track(): ScrubTrackInfo {
    return this.trackInfo;
  }
  get playReadAhead(): number {
    return this.provider.playReadAhead;
  }

  get isIdle(): boolean {
    return (
      this.currentState === ScrubCursorState.Idle &&
      this.nextPending === 0 &&
      this.pendingSeekTargetS === null &&
      !this.seekDraining
    );
  }

  async open(): Promise<void> {
    // Seed at the track's real first timestamp, not a hardcoded 0: a trimmed
    // or offset clip's first frame is not at the origin, so getFrame(0) would
    // land before the first sample and seed nothing.
    const origin = this.trackInfo.firstTimestampS;
    const seed = await this.seedFirstFrame(origin);
    if (this.closed) {
      if (seed?.kind === "sample") seed.sample.close();
      return;
    }
    if (seed) this.emitDecoded(seed, false);
    this.currentState = ScrubCursorState.Idle;
    // Seed coarse coverage so the first distant scrub lands a preview.
    this.schedulePrefetch(origin);
  }

  /**
   * The first frame, on the seed ceiling and its own attempt budget.
   *
   * A decoder that accepts this decode and never answers it is the one failure
   * the rest of the machinery cannot see: nothing has been asked of it twice
   * yet, so no request budget can run out, and open() is what the load path
   * awaits, so the wait ends only when the caller above gives up on the whole
   * worker. Bounding it here turns that into a decoder failure named at the
   * point it happened.
   *
   * Attempts are spent against rebuilt providers wherever the source can be
   * re-opened, so exhausting them means the source was re-opened that many
   * times and the first frame never arrived.
   */
  private async seedFirstFrame(origin: Sec): Promise<DecodedFrame | null> {
    for (
      let attempt = 0;
      attempt < HANG_RECOVERY.SEED_DECODE_ATTEMPTS;
      attempt++
    ) {
      const seed = await this.raceWatchdog(
        this.provider.getFrame(origin),
        true,
        this.seedHangTimeoutMs,
      );
      // A decoder that answers with no frame has answered: this source
      // carries nothing at its own first timestamp, which is a track worth
      // opening empty rather than a decoder worth condemning.
      if (seed.answered) return seed.value;
      if (this.closed) return null;
      // A decoder the runtime has already condemned answers no differently
      // on a second ask, and the ask lands on a provider about to be
      // disposed. An attempt is worth spending only where a rebuild can
      // change the answer.
      if (this.decoderStalled || this.decoderDead) break;
      await this.recovering;
    }
    const failure =
      this.stallFailure ??
      new WebVideoEngineError(
        WebVideoEngineErrorCode.DecoderStalled,
        `video decode: the first frame went undecoded across ${HANG_RECOVERY.SEED_DECODE_ATTEMPTS} attempts on the ${this.provider.decodePath} path`,
      );
    this.markStalled(failure);
    throw failure;
  }

  /**
   * Synchronous best-effort lookup the render loop calls on scrub to paint a
   * frame this same tick. Pure: it reads the cache and returns a paintable
   * frame without touching decode or cursor state.
   */
  peekCached(timeMs: number): ScrubFrame | null {
    // Non-counting: the authoritative seek for this same gesture also reads
    // the cache, so counting both would double-book every scrub's hit rate.
    const hit = this.cache.peek(timeMs, this.exactTolMs, this.previewTolMs);
    return hit ? this.frameFromCache(hit) : null;
  }

  /**
   * Resolves once foreground work has settled and any background prefetch
   * kicked by that settle has drained. The plain idle() contract excludes
   * prefetch so commits resolve promptly; this awaits full quiescence.
   */
  async whenSettled(): Promise<void> {
    await this.idle();
    await this.prefetchTask?.catch(() => undefined);
  }

  /**
   * Walks the whole track's keyframes into the index, metadata only, so the
   * diagnostics keyframe lane fills out across the entire file. Decoder-less
   * (it rides the EncodedPacketSink probe, never the frame sink), so it does
   * not contend with the foreground decode. Idempotent and best-effort: a
   * failure just leaves the lane as sparse as the lazy probes made it.
   */
  async ensureKeyframeIndex(): Promise<void> {
    if (this.closed) return;
    try {
      await this.keyframeIndex.ensureFullyIndexed(
        this.trackInfo.firstTimestampS,
      );
    } catch {
      // Best-effort: metadata I/O only, so a failure costs nothing but a
      // sparser diagnostics lane.
    }
  }

  getStats(): SchedulerStats {
    return {
      mode: this.mode,
      decodePath: this.provider.decodePath,
      cache: this.cache.stats,
      scrub: {
        samples: this.scrubSamples,
        lastMs: this.scrubLastMs,
        avgMs: this.scrubSamples > 0 ? this.scrubSumMs / this.scrubSamples : 0,
        maxMs: this.scrubMaxMs,
        p50Ms: this.scrubPercentile(0.5),
        p95Ms: this.scrubPercentile(0.95),
        targetVsLandedMs: this.targetVsLandedLastMs,
        timeToCrispMs: this.timeToCrispLastMs,
      },
      decode: {
        foreground: this.foregroundDecodes,
        prefetchExact: this.prefetchExactFrames,
        prefetchPreview: this.prefetchPreviewFrames,
        framesOut: this.provider.framesDecoded(),
        keyframeAnchored: this.keyframeAnchoredEmits,
        nextPending: this.nextPending,
      },
      seek: {
        exact: this.exactSeeks,
        key: this.keySeeks,
        coalesceDepth: this.seekCoalesceOverwrites,
      },
      gop: this.keyframeIndex.gopStats(this.trackInfo.durationS),
      probeRoundTrips: this.keyframeIndex.probeCount,
      keyframesMs: this.keyframeIndex.known.map((s) => Math.round(s * 1000)),
      prefetch: this.prefetchPlanMs(),
      prefetchState: {
        inFlight: this.prefetchTask !== null,
        generation: this.prefetchGen,
      },
      exactToleranceMs: this.exactTolMs,
      previewToleranceMs: this.previewTolMs,
      decoderDead: this.decoderDead,
      decoderStalled: this.decoderStalled,
      drain: {
        draining: this.seekDraining,
        pendingTargetMs:
          this.pendingSeekTargetS === null
            ? null
            : Math.round(this.pendingSeekTargetS * 1000),
        recovering: this.recovering !== null,
      },
    };
  }

  /** Percentile over the bounded recent-latency ring. Copies the live samples
   *  into a small scratch array and sorts; bounded by SCRUB_LATENCY_RING, and
   *  this runs only at snapshot time, never per seek. */
  private scrubPercentile(q: number): number {
    const n = Math.min(this.scrubLatencyCount, this.scrubLatencyRing.length);
    if (n === 0) return 0;
    const sample = Array.from(this.scrubLatencyRing.subarray(0, n)).sort(
      (a, b) => a - b,
    );
    const idx = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1));
    return sample[idx];
  }

  /** The targets the next prefetch sweep would decode for the current mode
   *  and position; a pure recompute from existing state. The Idle plan is
   *  built from the keyframes discovered so far, so it grows as the index
   *  learns, exactly like the sweep it predicts. */
  private prefetchPlanMs(): PrefetchPlan | null {
    if (this.mode === AccessMode.Playing) return null;
    const pos = this.currentPositionS();
    const targetsS =
      this.mode === AccessMode.Idle
        ? selectPreviewTargets(
            this.keyframeIndex.known.filter(
              (k) => Math.abs(k - pos) <= PREVIEW_SWEEP_SPAN_S,
            ),
            pos,
          )
        : this.windowTimestamps(pos);
    if (!targetsS.length) return null;
    // Ascending for the axis; the sweep orders its own copy for the decoder.
    return {
      targetsMs: targetsS
        .map((t) => Math.round(t * 1000))
        .sort((a, b) => a - b),
    };
  }

  seekTo(timestamp: Sec, intent: SeekIntent = "gesture"): void {
    timestamp = this.clampToOrigin(timestamp);
    if (intent === "gesture") {
      this.enterMode(AccessMode.Scrubbing);
      this.trajectory.sample(timestamp, this.now());
    } else {
      this.enterMode(AccessMode.Seeking);
    }
    // A pending target overwritten before it drained means the drag outran
    // the decoder; that intermediate position never paints.
    if (this.pendingSeekTargetS !== null) this.seekCoalesceOverwrites += 1;
    this.pendingSeekTargetS = timestamp;
    this.pendingSeekKeyOnly = false;
    void this.drainSeek();
  }

  seekToKey(timestamp: Sec): void {
    timestamp = this.clampToOrigin(timestamp);
    this.enterMode(AccessMode.Scrubbing);
    this.trajectory.sample(timestamp, this.now());
    if (this.pendingSeekTargetS !== null) this.seekCoalesceOverwrites += 1;
    this.pendingSeekTargetS = timestamp;
    this.pendingSeekKeyOnly = true;
    void this.drainSeek();
  }

  /** Floors a seek target to the track's first timestamp. A seek below the
   *  origin (an offset/trimmed clip) has no sample to land on, so it would
   *  emit nothing; clamping lands it on the first frame instead. */
  private clampToOrigin(timestamp: Sec): Sec {
    return asSec(Math.max(this.trackInfo.firstTimestampS, timestamp));
  }

  /** Motion sampled across a pause, a step, or a stretch of playback describes
   *  no hand still on the timeline, so leaving a scrub drops the gesture. */
  private enterMode(mode: AccessMode): void {
    if (mode !== AccessMode.Scrubbing) this.trajectory.reset();
    this.mode = mode;
  }

  attachPlay(startS: number): void {
    if (this.closed) return;
    this.enterMode(AccessMode.Playing);
    // Signal any running sweep to bail; the first pull awaits its teardown.
    this.abandonPrefetch();
    void this.iterator?.return();
    this.iterator = this.provider.frames(startS);
    // Reset the in-flight latch for the new session. An old-iterator pull may
    // still be settling; its finally is iterator-identity-aware (see next()),
    // so it will not decrement this fresh counter and drive it negative.
    this.nextPending = 0;
    // And start a fresh chain. The chain is strictly FIFO, so a pull left
    // parked on the previous session's generator would hold back every pull
    // issued against this one, including the ones re-priming the pump.
    this.nextInFlight = Promise.resolve();
  }

  detachPlay(): void {
    void this.iterator?.return();
    this.iterator = null;
    // A pull in flight at detach never decrements, since its finally only
    // fires for the iterator it was issued against. Left stranded, the count
    // reports a pull that will never land and isIdle never reads true again.
    this.nextPending = 0;
    this.enterMode(AccessMode.Idle);
    this.schedulePrefetch(this.currentPositionS());
  }

  next(): void {
    if (!this.iterator) return;
    // The consumer stops asking once its queue reaches the depth it wants, so
    // this ceiling only stops a runaway. Capping it at one starves the queue
    // it exists to fill: the consumer's refill call runs inside the pull it is
    // chaining from, before that pull's finally has decremented the count.
    if (this.nextPending >= PLAYBACK.READ_AHEAD_CANVAS) return;
    // Bind this pull to the iterator it was issued against. attachPlay resets
    // nextPending to 0 for the new session, so an orphaned pull from a prior
    // iterator must not decrement the fresh counter, which would drive it
    // negative. Decrement only when the session this pull belongs to is still
    // the live one.
    const iteratorAtIssue = this.iterator;
    this.nextPending++;
    this.nextInFlight = this.nextInFlight
      .catch(() => undefined)
      .then(() => this.pullForwardOne())
      .finally(() => {
        if (iteratorAtIssue === this.iterator) this.nextPending--;
      });
  }

  /**
   * Decodes one named frame of the source and emits it.
   *
   * The retrieval is at-or-before a time the frame table produced, and the
   * demuxer normalises that back to the same integer tick it came from, so it
   * lands on that frame and no other. Nothing here walks, compares or skips,
   * so a step across a frame boundary needs no epsilon, and a burst of steps
   * reuses whatever decode position the session already holds, with no
   * iterator opened per press.
   */
  async seekToFrame(frame: FrameId): Promise<ScrubFrame | null> {
    if (this.closed) return null;
    this.enterMode(AccessMode.Stepping);
    this.abandonPrefetch();
    const decoded = await this.withDecodeWatchdog(
      this.provider.getFrame(this.trackInfo.timeline.timeAt(frame.index)),
    );
    if (this.closed || !decoded) {
      if (decoded?.kind === "sample") decoded.sample.close();
      return null;
    }
    this.emitDecoded(decoded, false);
    this.schedulePrefetch(this.currentPositionS());
    return this.lastEmittedFrame;
  }

  idle(): Promise<void> {
    if (this.isIdle) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  seekSettled(): Promise<void> {
    // seekTo carries no closed guard, so a target armed after close has no
    // drain left to service it.
    if (this.closed) return Promise.resolve();
    if (this.pendingSeekTargetS === null && !this.seekDraining)
      return Promise.resolve();
    return new Promise((resolve) => this.settleResolvers.push(resolve));
  }

  subscribe(listener: ScrubFrameListener): () => void {
    this.listeners.add(listener);
    if (this.lastEmittedFrame) listener(this.lastEmittedFrame);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abandonPrefetch();
    this.pendingSeekTargetS = null;
    this.currentState = ScrubCursorState.Closed;
    this.listeners.clear();
    this.flushIdleResolvers();
    this.flushSettleResolvers();
    this.lastEmittedFrame = null;
    // Not awaited: a native async generator queues return() behind whatever
    // next() is running, so awaiting it here ties teardown to a decode that
    // may never settle and the provider below would never be disposed.
    void this.iterator?.return();
    this.iterator = null;
    await this.prefetchTask?.catch(() => undefined);
    this.cache.clear();
    await this.provider.dispose();
  }

  private async drainSeek(): Promise<void> {
    if (this.seekDraining || this.closed) return;
    let settledS: number | null = null;
    try {
      // Raised inside the try so the flag cannot outlive the finally that
      // clears it: while it is set, every play pull is dropped.
      this.seekDraining = true;
      this.abandonPrefetch();
      // Yield once so a synchronous burst of seekTo calls collapses to its
      // latest target before the first decode starts. Each intermediate
      // target costs a full keyframe-to-target walk on a long-GOP source.
      await Promise.resolve();
      while (this.pendingSeekTargetS !== null && !this.closed) {
        const t = this.pendingSeekTargetS;
        const keyOnly = this.pendingSeekKeyOnly;
        this.pendingSeekTargetS = null;
        settledS = t;
        await this.runSeek(asSec(t), keyOnly);
        // Released per lap: the loop re-arms for as long as the hand keeps
        // moving, so a waiter held to the bottom of the drain waits out the
        // whole gesture.
        this.flushSettleResolvers();
      }
    } finally {
      this.seekDraining = false;
      // Flush even when closed: a resolver registered while the seek was
      // draining would otherwise never fire if close() already ran its one
      // flush, hanging the awaiter. Resolving idle after close is harmless.
      this.flushIdleResolvers();
      this.flushSettleResolvers();
      if (!this.closed && settledS !== null) {
        // One light, mode-appropriate prefetch around the settle (the
        // exact neighbor window while scrubbing). A heavier eager preview
        // sweep here floods the decoder: the next scrub has to cancel and
        // await it, and play collides with it, so scrubbing and play stall.
        this.schedulePrefetch(asSec(settledS));
      }
    }
  }

  private async runSeek(t: Sec, keyOnly: boolean): Promise<void> {
    if (this.closed) return;
    this.currentState = ScrubCursorState.Seeking;
    try {
      if (keyOnly) {
        await this.runKeySeek(t);
      } else {
        await this.runExactSeek(t);
      }
    } finally {
      // Restored on the way out however the seek ended: left on Seeking,
      // isIdle never reads true again and every awaiter of a settled
      // cursor waits for a seek that already finished.
      if (!this.closed) this.currentState = ScrubCursorState.Idle;
    }
  }

  private async runExactSeek(t: Sec): Promise<void> {
    this.exactSeeks += 1;
    const ms = t * 1000;
    const cached = this.cache.get(ms, this.exactTolMs, this.previewTolMs);
    const painted = cached !== null && this.worthPainting(cached, ms);
    if (painted) this.emitCached(cached);
    // An exact hit is the crisp frame already; a coarse preview hit still
    // owes a full-resolution decode. Record a ~0ms sample for the instant hit
    // so the scrub-latency aggregate reflects every felt scrub, not just the
    // decode-bound ones that would otherwise pin the average.
    if (cached?.tier === FrameTier.Exact) {
      this.recordScrubLatency(0);
      this.targetVsLandedLastMs = ms - cached.timestampMs;
      return;
    }
    // A preview paint started the clock on how long the user stares at a
    // blurry frame before the crisp decode lands.
    const previewPaintedAt =
      painted && cached.tier === FrameTier.Preview ? this.now() : null;
    const startedAt = this.now();
    const frame = await this.withDecodeWatchdog(this.provider.getFrame(t));
    if (this.closed || !frame) {
      if (frame?.kind === "sample") frame.sample.close();
      return;
    }
    const nextTargetS = this.pendingSeekTargetS;
    if (nextTargetS !== null && !this.gainsOnTarget(frame, nextTargetS)) {
      this.cacheDecoded(frame);
    } else {
      this.emitDecoded(frame, false);
    }
    this.recordScrubLatency(this.now() - startedAt);
    this.targetVsLandedLastMs = ms - Math.round(frame.timestamp * 1000);
    if (previewPaintedAt !== null)
      this.timeToCrispLastMs = this.now() - previewPaintedAt;
  }

  /**
   * Whether a decode that outlived its target still improves the picture,
   * judged from where the gesture has since reached. A drag that outruns the
   * decoder supersedes every decode it starts, and the screen holds something
   * older than all of them, so refusing the lot pins the picture at whatever
   * was up when the drag began.
   *
   * Only a gesture reads this way. A jump has one destination and no
   * intermediate positions worth showing, so a superseded decode there is
   * work for a place nobody is looking.
   */
  private gainsOnTarget(decoded: DecodedFrame, nextTargetS: number): boolean {
    if (this.mode !== AccessMode.Scrubbing) return false;
    const showing = this.lastEmittedFrame;
    return earnsScreen(
      { timestampMs: Math.round(decoded.timestamp * 1000), quality: "exact" },
      showing
        ? {
            timestampMs: Math.round(showing.timestampS * 1000),
            quality: showing.quality,
          }
        : null,
      Math.round(nextTargetS * 1000),
    );
  }

  /**
   * Whether a cached frame earns the screen over what is already on it. A
   * crisp frame always does. A coarse stand-in exists to bridge the wait for a
   * decode, so it earns the screen only by landing closer to the target than
   * what is showing: replacing a crisp frame with a blurry one at the same
   * position is a visible drop in quality for nothing, and on a slow drag,
   * where each step lands within a frame of the last, it repeats several times
   * a second and reads as the picture flickering between sharp and soft.
   */
  private worthPainting(cached: CachedFrame, targetMs: number): boolean {
    // A crisp hit is the answer to this seek, so it is always emitted. The
    // emit is how the landing position is reported, not only how pixels
    // reach the screen, and suppressing it would also skip the decode that
    // the early return below is only safe to take because the answer is in
    // hand. Whether those pixels actually repaint is the render loop's call,
    // which applies the same rule at the one place that owns the canvas.
    if (cached.tier === FrameTier.Exact) return true;
    // Only the coarse tier reaches here, the crisp one having returned above.
    const showing = this.lastEmittedFrame;
    return earnsScreen(
      { timestampMs: cached.timestampMs, quality: "preview" },
      showing
        ? {
            timestampMs: Math.round(showing.timestampS * 1000),
            quality: showing.quality,
          }
        : null,
      targetMs,
    );
  }

  private async runKeySeek(t: Sec): Promise<void> {
    this.keySeeks += 1;
    // getFrame already anchors on the enclosing keyframe, so re-anchoring the
    // request collapses every target within a GOP onto that one frame. A
    // source carrying a single keyframe answers its whole timeline with the
    // first frame.
    const frame = await this.withDecodeWatchdog(this.provider.getFrame(t));
    if (this.closed || !frame) {
      if (frame?.kind === "sample") frame.sample.close();
      return;
    }
    this.emitDecoded(frame, true);
  }

  private async pullForwardOne(): Promise<void> {
    const iterator = this.iterator;
    if (!iterator || this.closed) return;
    if (this.seekDraining) return;
    this.abandonPrefetch();
    if (this.closed || iterator !== this.iterator) return;
    // Watchdog the play pull too: a hung play decode would otherwise wedge the
    // play pump (nextPending stuck high), so the empty-tick re-pull in the
    // controller could never recover. On timeout this returns null, recovers
    // the decoder, and lets the pump pull again next tick.
    const pulled = await this.withDecodeWatchdog(iterator.next());
    const next = pulled?.value ?? null;
    if (this.closed || iterator !== this.iterator || !next) {
      if (next?.kind === "sample") next.sample.close();
      return;
    }
    // Seed only the coarse tier: playback puts a frame every interval, which
    // would churn the whole crisp window within a second and evict the
    // neighbors a scrub settles onto. A scrub back over watched footage
    // paints that coarse frame at once and pays one re-anchored decode, which
    // the sync-sample spacing bounds.
    this.emitDecoded(next, false, false);
  }

  /**
   * Bounds a decode so a hung mediabunny decode (which takes no AbortSignal and
   * cannot be cancelled) never wedges the caller. On timeout it returns null and
   * kicks provider recovery; the orphaned decode promise is abandoned, since
   * there is no handle to cancel it. The healthy path resolves before the timer
   * and behaves exactly as a bare await: the loser timer is cleared, so it adds
   * no work to a decode that lands in time.
   *
   * A rejected decode takes the same route as a hung one. Every caller here is
   * mid-gesture with no way to answer a decode failure other than to try again
   * on a working decoder, and a throw would escape the fire-and-forget seek
   * drain and the play pull chain as an unhandled rejection. Taking that route
   * is also why an unanswered decode has to be counted here: the failure is
   * absorbed at this one point, so this is the only place that can tell a
   * decoder having a bad moment from one that will never answer again.
   */
  private withDecodeWatchdog<T>(decode: Promise<T>): Promise<T | null> {
    return this.watchdogged(decode, true);
  }

  /**
   * The same watchdog over a container metadata read. Deliberately unbooked:
   * the keyframe probe never touches the decoder, so its answer is no evidence
   * that decoding works, and clearing the stall budget on one would keep a
   * background sweep forgiving a decoder that answers nothing.
   */
  private withProbeWatchdog<T>(probe: Promise<T>): Promise<T | null> {
    return this.watchdogged(probe, false);
  }

  private async watchdogged<T>(
    work: Promise<T>,
    booked: boolean,
    timeoutMs = this.decodeHangTimeoutMs,
  ): Promise<T | null> {
    const outcome = await this.raceWatchdog(work, booked, timeoutMs);
    return outcome.answered ? outcome.value : null;
  }

  private async raceWatchdog<T>(
    work: Promise<T>,
    booked: boolean,
    timeoutMs: number,
  ): Promise<Watchdogged<T>> {
    if (this.decoderDead || this.decoderStalled) {
      // The caller built the decode before this could refuse it, so its
      // rejection still needs an owner even though nobody wants the value.
      void work.catch(() => undefined);
      return UNANSWERED;
    }
    // An abandoned sweep leaves its decode running with this timer still
    // armed. Recovering on it would tear down whatever provider is live when
    // it fires, which by then can be a healthy rebuild.
    const issuedAgainst = this.provider;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reason: unknown = null;
    const hang = new Promise<typeof HUNG>((resolve) => {
      timer = setTimeout(() => resolve(HUNG), timeoutMs);
    });
    try {
      const result = await Promise.race([
        work.catch((cause: unknown) => {
          reason = cause;
          return HUNG;
        }),
        hang,
      ]);
      if (result === HUNG) {
        if (issuedAgainst !== this.provider) return UNANSWERED;
        if (booked) this.noteUnanswered(reason);
        else void this.recoverDecoder();
        return UNANSWERED;
      }
      // The decoder answered, so whatever it was doing before, it is
      // decoding now. A resolved null counts: it is an answer about a
      // position, not a decoder that failed to reach one.
      if (booked) this.unansweredDecodes = 0;
      return { answered: true, value: result as T };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Books one decode the live provider failed to answer, and decides whether
   * to rebuild or to give up. A decoder that refuses outright says so in the
   * rejection and there is nothing to rebuild toward; otherwise the runtime
   * rebuilds until the request budget runs out, which is what stops a source
   * that re-opens cleanly and then decodes nothing from being rebuilt forever
   * while every surface reads as healthy.
   */
  private noteUnanswered(reason: unknown): void {
    this.unansweredDecodes += 1;
    if (
      reason instanceof WebVideoEngineError &&
      reason.code === WebVideoEngineErrorCode.DecoderStalled
    ) {
      this.markStalled(reason);
      return;
    }
    if (this.unansweredDecodes >= MAX_UNANSWERED_DECODES) {
      this.markStalled(
        new WebVideoEngineError(
          WebVideoEngineErrorCode.DecoderStalled,
          `video decode: ${this.unansweredDecodes} decode requests in a row went unanswered on the ${this.provider.decodePath} path`,
          reason,
        ),
      );
      return;
    }
    void this.recoverDecoder();
  }

  /** Latches the terminal decoder failure and hands it out exactly once. */
  private markStalled(error: WebVideoEngineError): void {
    if (this.decoderStalled) return;
    this.decoderStalled = true;
    this.stallFailure = error;
    this.onDecodeFailure?.(error);
  }

  /**
   * Rebuilds the decoder after a hung decode. The old provider is wedged on an
   * uncancellable decode, so it is disposed and a fresh source opened in its
   * place; the keyframe index is repointed at the new probe since disposing the
   * old input invalidated the old one. Single-flight: a second hang during the
   * rebuild awaits the same recovery. When the source cannot be re-opened (a
   * one-shot stream), the decoder is marked dead so later decodes no-op rather
   * than hang, leaving the engine degraded but alive instead of frozen.
   */
  private recoverDecoder(): Promise<void> {
    if (this.recovering) return this.recovering;
    if (this.closed || this.decoderDead || this.decoderStalled)
      return Promise.resolve();
    if (!this.reopen) {
      // No way to re-open this source (a one-shot stream): the wedged decoder
      // cannot be rebuilt, so degrade to a no-op decode state rather than
      // leave the drain flag latched and the engine frozen.
      this.decoderDead = true;
      return Promise.resolve();
    }
    const reopen = this.reopen;
    this.recovering = (async () => {
      const dead = this.provider;
      try {
        const handle = await reopen();
        if (this.closed) {
          await handle.dispose();
          return;
        }
        this.provider = openFrameProvider(handle);
        // Disposing the old input invalidated the old probe, so the index
        // has to be rebuilt against the new one. It starts empty, and
        // nothing else re-walks it: the source's keyframes are exactly
        // where they were, so re-walk them rather than leaving the
        // consumer to believe the file has none.
        this.keyframeIndex = new KeyframeIndex(this.provider.keyframeProbe);
        void this.ensureKeyframeIndex();
        // The play iterator streams from the provider about to be disposed,
        // and the pump's staleness guards compare iterator identity, which
        // swapping the provider leaves untouched. Without re-deriving it
        // here the pump pulls a generator over a disposed input forever.
        //
        // Whether one existed is the question, not what the consumer is
        // doing now: a seek or a step in flight when the decode hung has
        // already moved the mode off Playing, and the pump's only way
        // back is a pull, which no-ops while the iterator is null.
        this.failedRebuilds = 0;
        const resumePlay = this.iterator !== null;
        const modeBefore = this.mode;
        this.iterator = null;
        if (resumePlay) {
          this.attachPlay(this.currentPositionS());
          this.mode = modeBefore;
        }
      } catch {
        // The rebuild failed. A re-openable source can fail once, on a
        // transient read, so one failure leaves the decoder recoverable
        // rather than no-opping every later decode. A source that keeps
        // failing is not transient, and pretending otherwise retries
        // forever while reporting a healthy decoder.
        this.failedRebuilds += 1;
        if (this.failedRebuilds >= MAX_FAILED_REBUILDS) this.decoderDead = true;
      } finally {
        // Best-effort dispose of the wedged provider; its hung decode is
        // abandoned and may never settle, so do not await indefinitely.
        void dead.dispose().catch(() => undefined);
        this.recovering = null;
      }
    })();
    return this.recovering;
  }

  /**
   * The only writer of the generation token, so no bump can move it without
   * also waking the sweep it cancels. A running sweep bails at its next
   * checkpoint and is never joined: joining it puts an unbounded background
   * walk on the critical path of every seek and play pull. The task handle
   * stays so close() can await teardown.
   */
  private abandonPrefetch(): void {
    // Only an armed token has a sweep to cancel: a play pull cancels here on
    // every frame, and playback schedules no sweeps at all, so an unguarded
    // bump measures the play pump rather than prefetch.
    if (this.prefetchArmed) {
      this.prefetchArmed = false;
      this.prefetchGen++;
    }
    const pending = this.abandonResolvers;
    if (pending.length === 0) return;
    this.abandonResolvers = [];
    pending.forEach((r) => r());
  }

  /** Resolves the moment `gen` stops being the live prefetch generation. */
  private whenAbandoned(gen: number): Promise<typeof ABANDONED> {
    return new Promise((resolve) => {
      if (gen !== this.prefetchGen) resolve(ABANDONED);
      else this.abandonResolvers.push(() => resolve(ABANDONED));
    });
  }

  /**
   * Kicks a background sweep around `aroundS` for the current access mode.
   * Fire-and-forget: it waits for any prior sweep to tear down so the decoder
   * is never used twice at once, then runs under a captured generation token.
   */
  private schedulePrefetch(aroundS: Sec): void {
    if (this.mode === AccessMode.Playing) return;
    this.abandonPrefetch();
    const gen = this.prefetchGen;
    const prev = this.prefetchTask;
    this.prefetchArmed = true;
    const sweep = (async () => {
      try {
        await prev?.catch(() => undefined);
        if (gen !== this.prefetchGen || this.closed) return;
        await this.runPrefetch(aroundS, gen);
      } catch {
        // Best-effort: a failed sweep just leaves a future cache miss.
      }
    })();
    const task: Promise<void> = sweep.finally(() => {
      if (this.prefetchTask !== task) return;
      this.prefetchTask = null;
      this.prefetchArmed = false;
    });
    this.prefetchTask = task;
  }

  private async runPrefetch(aroundS: Sec, gen: number): Promise<void> {
    if (this.mode === AccessMode.Idle) {
      await this.runPreviewSweep(aroundS, gen);
    } else {
      await this.runExactWindow(aroundS, gen);
    }
  }

  private async runExactWindow(aroundS: Sec, gen: number): Promise<void> {
    const targets = this.windowTimestamps(aroundS);
    await this.decodeInto(targets, gen, false);
    if (gen !== this.prefetchGen || this.closed) return;
    // The center frame went into the tier before this sweep, so it is the
    // oldest insertion and the first LRU victim once the window fills. It is
    // also the frame on screen and the most likely target of a micro-adjust,
    // so promote it back to most-recently-used after the neighbors land.
    this.cache.bumpExact(aroundS * 1000);
  }

  private async runPreviewSweep(aroundS: Sec, gen: number): Promise<void> {
    const lo = Math.max(0, aroundS - PREVIEW_SWEEP_SPAN_S);
    const hi = Math.min(
      this.trackInfo.durationS,
      aroundS + PREVIEW_SWEEP_SPAN_S,
    );
    const keyframes = await Promise.race([
      this.withProbeWatchdog(this.keyframeIndex.keyframesCovering(lo, hi)),
      this.whenAbandoned(gen),
    ]);
    if (
      keyframes === ABANDONED ||
      !keyframes ||
      gen !== this.prefetchGen ||
      this.closed
    )
      return;
    await this.decodeInto(selectPreviewTargets(keyframes, aroundS), gen, true);
  }

  private async decodeInto(
    timestamps: number[],
    gen: number,
    preview: boolean,
  ): Promise<void> {
    if (!timestamps.length || gen !== this.prefetchGen || this.closed) return;
    const w = this.trackInfo.decodeWidth;
    const h = this.trackInfo.decodeHeight;
    const iter = this.provider.framesAt(timestamps);
    try {
      let result = await this.pullSwept(iter, gen);
      while (result && !result.done) {
        if (gen !== this.prefetchGen || this.closed) {
          // A gesture cancelled the sweep (or close raced it) after this
          // frame decoded but before it was drawn into the cache; close
          // the orphaned sample here, since the cache will never own it.
          if (result.value?.kind === "sample") result.value.sample.close();
          return;
        }
        const frame = result.value;
        if (frame) {
          const ms = frame.timestamp * 1000;
          const blit = frame.kind === "sample" ? frame.sample : frame.canvas;
          if (preview) {
            this.cache.putPreview(ms, blit, w, h);
            this.prefetchPreviewFrames += 1;
          } else {
            this.cache.putExact(ms, blit, w, h);
            this.prefetchExactFrames += 1;
          }
          // A swept sample is drawn into the cache and never emitted, so
          // its close obligation ends here. The cache retains only the
          // blit, never the sample.
          if (frame.kind === "sample") frame.sample.close();
        }
        result = await this.pullSwept(iter, gen);
      }
    } finally {
      void iter.return();
    }
  }

  /**
   * One sweep pull, ended by abandonment rather than by the decode it is
   * waiting on. A native async generator serializes its request queue, so the
   * return() that cancellation would issue is queued behind the in-flight
   * next() and lands only once that walk finishes; the pull itself cannot be
   * called back. The sweep therefore stops awaiting it and leaves it orphaned,
   * closing the sample it may still deliver, which the cache will never own.
   */
  private async pullSwept(
    iter: AsyncGenerator<DecodedFrame | null, void, unknown>,
    gen: number,
  ): Promise<IteratorResult<DecodedFrame | null, void> | null> {
    const pull = this.withDecodeWatchdog(iter.next());
    const settled = await Promise.race([pull, this.whenAbandoned(gen)]);
    if (settled !== ABANDONED) return settled;
    void pull
      .then((late) => {
        if (late && late.value?.kind === "sample") late.value.sample.close();
      })
      .catch(() => undefined);
    return null;
  }

  private windowTimestamps(aroundS: Sec): number[] {
    const n = this.perSideWindowFrames();
    if (n <= 0) return [];
    const stepS = this.frameIntervalS();
    const targets: number[] = [];
    const admit = (t: number): void => {
      if (t >= 0 && t <= this.trackInfo.durationS) targets.push(t);
    };
    // Spend the budget where the gesture is going. Splitting it evenly puts
    // half of every sweep behind a hand that is moving away from there, and
    // those frames are stale before they land: measured on a forward drag,
    // 8% of the resident crisp frames were ahead of the pointer and the rest
    // trailed it by up to six seconds. A minority still goes the other way,
    // since a scrub reverses without warning and a few frames behind cover
    // the moment before the heading is re-established.
    const { withTravel, againstTravel } = this.splitByHeading(2 * n);
    // A gesture with no heading keeps a symmetric window; the split above
    // hands it an even budget, so +1 just picks a side to call forward.
    const travel = this.trajectory.heading() || 1;
    for (let i = 1; i <= withTravel; i++) admit(aroundS + travel * i * stepS);
    for (let i = 1; i <= againstTravel; i++)
      admit(aroundS - travel * i * stepS);
    // Nearest the center first above, so trimming to the budget drops the
    // farthest frames. Then the frames the gesture is about to reach are
    // decoded before the ones behind it. Ascending across the whole batch
    // reads as decoder-friendly, and inside one anchor span it is, but a
    // target behind the read head re-anchors and decodes its entire prefix:
    // on a source whose only sync sample is at the start, that is a walk
    // from zero, ahead of every frame the user actually needs. Each half
    // still climbs, so neither half re-walks within itself.
    // A target the decoder can still reach going forward costs the frames in
    // between and nothing else. One behind it cannot be reached by moving
    // forward at all, so it restarts from the keyframe before it and decodes
    // everything between: a few frames on a short GOP, the whole file on a
    // source whose only keyframe is at the start. Speculative frames are
    // worth the first and not the second.
    const budgeted = targets
      .slice(0, 2 * n)
      .filter(
        (t) =>
          !this.provider.wouldReanchor(t) ||
          this.walkToTargetAffordable(t, 2 * n),
      );
    const ahead = budgeted.filter((t) => t >= aroundS).sort((a, b) => a - b);
    const behind = budgeted.filter((t) => t < aroundS).sort((a, b) => a - b);
    return [...ahead, ...behind];
  }

  /**
   * How a window's slots divide between the way the gesture is heading and the
   * way it came from. An unmoving gesture has no direction to favour, so it
   * splits evenly, which is also what a step or an idle settle wants.
   */
  private splitByHeading(budget: number): {
    withTravel: number;
    againstTravel: number;
  } {
    if (this.trajectory.heading() === 0) {
      const half = Math.floor(budget / 2);
      return { withTravel: half, againstTravel: budget - half };
    }
    const withTravel = Math.max(1, Math.round(budget * WINDOW_LEAD_FRACTION));
    return { withTravel, againstTravel: Math.max(0, budget - withTravel) };
  }

  /**
   * Whether reaching `t` backwards is worth it, measured in frames the walk
   * from its keyframe would decode. The index is what the runtime knows so far,
   * so an empty one is no evidence and does not veto: guessing a source has no
   * keyframes would throw away every backward slot on a source that has plenty.
   */
  private walkToTargetAffordable(t: number, budgetFrames: number): boolean {
    const keyframes = this.keyframeIndex.known;
    if (!keyframes.length) return true;
    let anchor: number | null = null;
    for (const k of keyframes) {
      if (k <= t) anchor = k;
      else break;
    }
    if (anchor === null) return true;
    return t - anchor <= budgetFrames * this.frameIntervalS();
  }

  /**
   * Per-side neighbor count for the current mode, clamped so the whole window
   * (both sides plus the center already in hand) fits the exact tier. A window
   * wider than the tier would evict its own freshly decoded frames, so a
   * re-scrub into the swept region would still miss.
   */
  private perSideWindowFrames(): number {
    const desired =
      this.mode === AccessMode.Stepping
        ? STEP_WINDOW_FRAMES
        : SCRUB_WINDOW_FRAMES;
    const capacity = this.cache.stats.exactCapacity;
    if (capacity <= 1) return 0;
    // One slot holds the center; the rest split across the two sides.
    const fits = Math.floor((capacity - 1) / 2);
    return Math.min(desired, fits);
  }

  private frameIntervalS(): number {
    const fps = this.trackInfo.nativeFps;
    return fps && fps > 0 ? 1 / fps : 1 / FALLBACK_FPS;
  }

  private currentPositionS(): Sec {
    return this.lastEmittedFrame ? this.lastEmittedFrame.timestampS : asSec(0);
  }

  private emitDecoded(
    decoded: DecodedFrame,
    isKey: boolean,
    cacheExact = true,
  ): void {
    this.foregroundDecodes += 1;
    if (isKey) this.keyframeAnchoredEmits += 1;
    // The cache buckets on its own rounded key and reports back whatever
    // timestamp it was handed, so rounding here would make every cache-served
    // paint claim a time no frame has.
    const ms = decoded.timestamp * 1000;
    const w = this.trackInfo.decodeWidth;
    const h = this.trackInfo.decodeHeight;
    const blit = decoded.kind === "sample" ? decoded.sample : decoded.canvas;
    // Blit into the cache first. The cache draws the sample and retains only
    // the blit, so the live sample below is still valid for the controller to
    // paint and then close.
    if (cacheExact) this.cache.putExact(ms, blit, w, h);
    // Always seed the coarse tier too, on every path. The exact tier serves a
    // scrub back over the exact spot; the long preview tier lets a re-scrub
    // near (not on) this spot paint an instant coarse frame while a crisp one
    // decodes.
    this.cache.putPreview(ms, blit, w, h);
    if (decoded.kind === "sample") {
      // The controller closes the sample after it paints; the cache already
      // holds an independent blit.
      this.emit({
        kind: "sample",
        sample: decoded.sample,
        timestampS: decoded.timestamp as Sec,
        width: w,
        height: h,
        isKeyFrame: isKey,
        quality: "exact",
      });
    } else {
      this.emit({
        kind: "canvas",
        source: decoded.canvas,
        timestampS: decoded.timestamp as Sec,
        width: w,
        height: h,
        isKeyFrame: isKey,
        quality: "exact",
      });
    }
  }

  /** Puts a decoded frame in both tiers without painting it, and releases it.
   *  For a frame worth keeping whose moment to be seen has passed. */
  private cacheDecoded(decoded: DecodedFrame): void {
    this.foregroundDecodes += 1;
    const ms = decoded.timestamp * 1000;
    const w = this.trackInfo.decodeWidth;
    const h = this.trackInfo.decodeHeight;
    const blit = decoded.kind === "sample" ? decoded.sample : decoded.canvas;
    this.cache.putExact(ms, blit, w, h);
    this.cache.putPreview(ms, blit, w, h);
    if (decoded.kind === "sample") decoded.sample.close();
  }

  private emitCached(cached: CachedFrame): void {
    this.emit(this.frameFromCache(cached));
  }

  private emit(frame: ScrubFrame): void {
    this.lastEmittedFrame = frame;
    this.listeners.forEach((l) => l(frame));
  }

  private frameFromCache(cached: CachedFrame): ScrubFrame {
    return {
      kind: "canvas",
      timestampS: asSec(cached.timestampMs / 1000),
      source: cached.canvas,
      width: cached.canvas.width,
      height: cached.canvas.height,
      // The cache keeps blits, not the sample's flags, so whether this
      // frame was a keyframe is simply not known here.
      isKeyFrame: false,
      quality: cached.tier === FrameTier.Preview ? "preview" : "exact",
    };
  }

  private recordScrubLatency(ms: number): void {
    this.scrubSamples += 1;
    this.scrubSumMs += ms;
    this.scrubLastMs = ms;
    if (ms > this.scrubMaxMs) this.scrubMaxMs = ms;
    this.scrubLatencyRing[this.scrubLatencyHead] = ms;
    this.scrubLatencyHead =
      (this.scrubLatencyHead + 1) % this.scrubLatencyRing.length;
    this.scrubLatencyCount += 1;
  }

  private flushIdleResolvers(): void {
    const pending = this.idleResolvers;
    this.idleResolvers = [];
    pending.forEach((r) => r());
  }

  private flushSettleResolvers(): void {
    const pending = this.settleResolvers;
    this.settleResolvers = [];
    pending.forEach((r) => r());
  }
}
