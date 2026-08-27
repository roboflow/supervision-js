import { PLAYBACK, HANG_RECOVERY, PLAYBACK_RATE } from "./constants";
import type { FrameCacheStats } from "./frame-cache";
import type { FrameId } from "./frame-timeline";
import type { GopStats } from "./keyframe-index";
import type { FrameQuality, SchedulerStats } from "./scrub-cursor";
import type { PresentationMode } from "./types";

/** Which render backend is painting the display canvas. */
export type RendererName = "2d" | "webgpu";

/** Resolved track facts worth surfacing for diagnostics. decodeWidth/Height
 *  explain cache slot counts: the exact tier is RAM-budgeted, so large frames
 *  mean few slots. */
export interface DiagnosticsTrack {
  readonly decodeWidth: number;
  readonly decodeHeight: number;
  readonly nativeFps: number | null;
  readonly durationS: number;
}

/**
 * Engine-level diagnostics snapshot the worker assembles on demand. Combines the
 * renderer (controller-owned), track facts, and the scheduler stats (cursor-
 * owned, null on the uncached cursor). All plain data, so it crosses the worker
 * boundary by structured clone.
 *
 * This is the legacy getStats shape, kept as a back-compat subset of the richer
 * DiagnosticsSnapshot the broadcast plane carries. Existing getStats consumers
 * read these three fields; the diagnostics instrument reads the superset.
 */
export interface EngineDiagnostics {
  readonly renderer: RendererName | null;
  readonly track: DiagnosticsTrack | null;
  readonly scheduler: SchedulerStats | null;
}

/** Per-paint realtime needles. effectivePaintFps is the painted rate over a
 *  trailing window of broadcast intervals (see PaintRateMeter), null unless
 *  playback was up across the whole window, so every snapshot in a series
 *  carries its own reading. ticks and paints reset at each play start, so they
 *  count the current play session rather than the source's lifetime.
 *  catchUpMs is how far the clock ran past the last painted frame.
 *  playQueueDepth is the decode-ahead buffer's current length: 0 while playing is
 *  the imminent-stall tell. */
export interface RealtimeDiagnostics {
  readonly effectivePaintFps: number | null;
  readonly catchUpMs: number;
  readonly lateFrames: number;
  readonly stalls: number;
  readonly ticks: number;
  readonly paints: number;
  readonly playQueueDepth: number;
  /** Decoded frames thrown away before reaching the canvas: ones that arrived
   *  for a position playback had left, buffered ones overtaken by the clock
   *  moving backwards, and the ones the present cadence declines once the rate
   *  asks for more frames a second than it. The first two are decode bandwidth
   *  spent on frames nobody ever saw; the third is the cadence doing its job,
   *  and at a high rate it dominates the count. */
  readonly droppedFrames: number;
}

/**
 * Lifetime frame ledger across the decode-to-screen pipe: what the decoder
 * produced, what reached the canvas, what was discarded on the way. These three
 * are only meaningful read together; the ratio between decoded and painted is
 * the cost of every frame nobody saw. Monotonic from load, never reset by a
 * play session. decodedFrames is null when the decode path cannot report it
 * (the uncached cursor).
 */
export interface PipelineDiagnostics {
  readonly decodedFrames: number | null;
  readonly paintedFrames: number;
  readonly droppedFrames: number;
}

/** Last painted frame and its quality; see DiagnosticsSnapshot.screen. */
export interface ScreenDiagnostics {
  /** Which frame of the source is up, by the engine's own frame table. */
  readonly frameId: FrameId;
  readonly mediaTimeMs: number;
  readonly quality: FrameQuality;
}

/** Cache occupancy in bytes, derived from resident slot counts and frame dims.
 *  exactBytesPct is the exact tier's fill against its RAM ceiling; a high value
 *  with a low hit rate is the starved-cache tell. */
export interface CacheBytesDiagnostics {
  readonly exactBytes: number;
  readonly previewBytes: number;
  readonly exactBudgetBytes: number;
  readonly exactBytesPct: number;
}

/** Track geometry that explains decode cost. nativeWidth/Height come from the
 *  source track (omitted when the track exposes no native dims). downscaleRatio
 *  is decodeWidth/nativeWidth; decodeVsDisplayAreaRatio compares the decoded
 *  frame area to the bound canvas area (>1 means decoding larger than painted). */
export interface TrackGeometryDiagnostics {
  readonly nativeWidth: number | null;
  readonly nativeHeight: number | null;
  readonly decodeWidth: number;
  readonly decodeHeight: number;
  readonly downscaleRatio: number | null;
  readonly decodeVsDisplayAreaRatio: number | null;
  readonly boundCanvasWidth: number | null;
  readonly boundCanvasHeight: number | null;
}

/** GOP distribution plus the labelled estimates. estimatedGopWalkDepthFrames is
 *  an ESTIMATE: frames a worst-case off-anchor scrub would decode, derived from
 *  avg GOP and native fps, never measured inside the decode loop. */
export interface GopDiagnostics extends GopStats {
  /** Media seconds from the playhead to the closest anchor the keyframe index
   *  has discovered so far. The index fills lazily, so this reads null until it
   *  holds one and tightens as it walks further. */
  readonly distanceToNearestKeyframeS: number | null;
  readonly estimatedGopWalkDepthFrames: number;
}

/** Scrub responsiveness aggregates lifted from the scheduler. cacheHitRatePct
 *  reads 0 when nothing has looked the cache up yet, which is indistinguishable
 *  from every lookup missing; cacheLookups() is the denominator that tells the
 *  two apart. */
export interface ScrubDiagnostics {
  readonly samples: number;
  readonly avgMs: number;
  readonly maxMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly targetVsLandedMs: number;
  readonly timeToCrispMs: number;
  readonly cacheHitRatePct: number;
}

/**
 * Seeks served by re-anchoring the running playback walk, the path a seek
 * issued while playing takes, with the wall time each waited for its crisp
 * frame. They never reach the cursor, so nothing in ScrubDiagnostics and no
 * cache lookup counts them. samples is the denominator of avgMs and maxMs: it
 * trails seeks whenever one is superseded, or the transport stopped under it,
 * before its crisp frame arrived.
 */
export interface PlaySeekDiagnostics {
  readonly seeks: number;
  readonly samples: number;
  readonly avgMs: number;
  readonly maxMs: number;
}

/** Decode/seek/prefetch counters lifted from the scheduler. */
export interface CounterDiagnostics {
  readonly foregroundDecodes: number;
  readonly prefetchExact: number;
  readonly prefetchPreview: number;
  readonly keyframeAnchored: number;
  readonly exactSeeks: number;
  readonly keySeeks: number;
  readonly seekCoalesceDepth: number;
  readonly probeRoundTrips: number;
  readonly prefetchInFlight: boolean;
  /**
   * Background sweeps cancelled since the source opened, as a running total, so
   * a rate is only ever the delta between two snapshots. Playback schedules no
   * sweeps, so a clip that only plays never moves this.
   */
  readonly prefetchGeneration: number;
  readonly nextPending: number;
  /** How long the cursor has been draining a seek uninterrupted, in ms; 0 when
   *  none is in flight. Every play pull is refused for the whole of it. */
  readonly seekDrainingForMs: number;
}

/**
 * The page's JS heap in use. Blink exposes performance.memory on Window only,
 * never in a worker scope, so the worker cannot read this at all: it leaves the
 * field null and the main thread fills it on receipt, as it does
 * webgpuAvailable. Null off Blink, and null in a trace, which is assembled
 * inside the worker.
 */
export interface MemoryDiagnostics {
  readonly jsHeapUsedBytes: number | null;
}

/** Severity of a diagnosis, ordered info < warn < critical for sorting. */
export type WarningSeverity = "info" | "warn" | "critical";

/**
 * One self-explaining diagnosis. id is the stable rule key; scenario names what
 * the runtime is doing wrong in plain language; advice is the fix; evidence is
 * the human-readable metric values that tripped the rule, so a trace explains
 * itself to a human or an agent without re-deriving the thresholds.
 */
export interface Warning {
  readonly id: string;
  readonly severity: WarningSeverity;
  readonly title: string;
  readonly scenario: string;
  readonly advice: string;
  readonly evidence: string;
}

/**
 * The clone-safe wire snapshot the worker broadcasts at BROADCAST_HZ. A superset
 * of EngineDiagnostics: it keeps renderer/track/scheduler verbatim so legacy
 * readers still resolve, and adds the realtime needles, the pipeline ledger,
 * derived cache bytes, track geometry, GOP block, scrub aggregates, the
 * play-time seek block, counters, memory, the clock/screen pair, and the
 * worker-evaluated warnings. Only plain data crosses the boundary.
 *
 * webgpuAvailable and memory.jsHeapUsedBytes are the fields the worker leaves at
 * their empty value for the main thread to fill after the broadcast, so a rule
 * in evaluateWarnings (which runs in the worker) can never read them, and an
 * exported trace, assembled worker-side, carries the unfilled value. Warnings
 * are evaluated once, worker-side, so the HUD and an exported trace always show
 * the same diagnoses.
 */
export interface DiagnosticsSnapshot {
  /**
   * Which presentation the engine was loaded for. `renderer` and the geometry
   * fields that need a bound canvas are null for the whole life of a "frames"
   * engine, which holds none by design; without this a reader cannot tell that
   * from a "canvas" engine whose renderer has not resolved yet.
   */
  readonly presentation: PresentationMode;
  readonly renderer: RendererName | null;
  readonly track: DiagnosticsTrack | null;
  readonly scheduler: SchedulerStats | null;
  readonly realtime: RealtimeDiagnostics;
  readonly pipeline: PipelineDiagnostics;
  readonly cacheBytes: CacheBytesDiagnostics;
  readonly geometry: TrackGeometryDiagnostics;
  readonly gop: GopDiagnostics;
  readonly scrub: ScrubDiagnostics;
  readonly playSeek: PlaySeekDiagnostics;
  readonly counters: CounterDiagnostics;
  readonly memory: MemoryDiagnostics;
  readonly nativeFps: number | null;
  /** Media seconds per wall second the transport was told to run at. */
  readonly rate: number;
  /**
   * The same figure measured off the canvas: media seconds of picture actually
   * presented per wall second, over a trailing window; null unless playback was
   * up across the whole of it. Read against `rate` it answers the one question
   * a commanded rate cannot, which is whether the picture is really moving that
   * fast. Falling short means frames are arriving slower than the clock wants
   * them, so the picture lags further behind the playhead every second.
   *
   * It is a window over whole paints, so it quantises when paints are sparse: a
   * slow rate on a low-fps source reads low from a healthy pipeline. Read it
   * against catchUpMs before concluding anything from a shortfall.
   */
  readonly presentedRate: number | null;
  /** The engine clock at assembly, ms; null before load. Paused, it holds the
   *  last commanded target; playing, it advances at rate. The one value the
   *  instruments draw the playhead from, so the playhead and the coverage
   *  lanes cannot disagree about where "now" is. */
  readonly playheadMs: number | null;
  /** What is actually on the canvas: last painted position and its quality;
   *  null before the first paint. Its distance from playheadMs is the live
   *  landing error (paused) or catch-up depth (playing). A sampled
   *  observation for instruments; frame identity for consumers still travels
   *  only on the paint event. */
  readonly screen: ScreenDiagnostics | null;
  readonly status: string;
  readonly webgpuAvailable: boolean;
  readonly warnings: Warning[];
}

/** Frame interval fallback when the source rate is unknown; mirrors the engine. */
const FALLBACK_FPS = 30;

/** Broadcast intervals per paint-rate window: ~600ms at the 10Hz broadcast. */
const PAINT_RATE_WINDOW = 6;

/**
 * Painted-frame rate over a trailing window of broadcast intervals, fed once
 * per snapshot. A single interval can only hold whole paints, so its rate
 * quantises hard; the trailing window smooths that without collapsing the
 * series into a whole-capture average, which could confirm "playback is slow"
 * but never locate it in time.
 */
export class PaintRateMeter {
  private readonly samples: { atMs: number; paints: number }[] = [];

  constructor(private readonly windowSize: number = PAINT_RATE_WINDOW) {}

  /** Rate in paints/second, or null unless playback was up across the whole
   *  window. A pause or a paints reset (each play session restarts the
   *  counter) invalidates the window, not just the sample. */
  sample(atMs: number, paints: number, playing: boolean): number | null {
    const lastPaints = this.samples.at(-1)?.paints ?? 0;
    if (!playing || paints < lastPaints) this.samples.length = 0;
    if (!playing) return null;
    this.samples.push({ atMs, paints });
    if (this.samples.length > this.windowSize) this.samples.shift();
    if (this.samples.length < 2) return null;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dtMs = last.atMs - first.atMs;
    if (dtMs <= 0) return null;
    return ((last.paints - first.paints) / dtMs) * 1000;
  }
}

/**
 * Playback speed measured off what reached the canvas: media seconds presented
 * per wall second, over the same trailing window PaintRateMeter uses. Fed the
 * last painted media position once per snapshot.
 *
 * It reads painted positions, not paint counts: a source can paint at a healthy
 * 30fps while the clock runs at 4x, and only the distance the picture travelled
 * shows that the two disagree.
 */
export class PresentedRateMeter {
  private readonly samples: { atMs: number; paintedMs: number }[] = [];

  constructor(private readonly windowSize: number = PAINT_RATE_WINDOW) {}

  /** Rate in media seconds per wall second, or null unless playback was up
   *  across the whole window with the picture moving forward through it. */
  sample(
    atMs: number,
    paintedMs: number | null,
    playing: boolean,
  ): number | null {
    const last = this.samples.at(-1);
    // A backward move is a seek, not a slower playback: measuring across it
    // would report the jump as a negative rate.
    if (
      !playing ||
      paintedMs === null ||
      (last !== undefined && paintedMs < last.paintedMs)
    ) {
      this.samples.length = 0;
    }
    if (!playing || paintedMs === null) return null;
    this.samples.push({ atMs, paintedMs });
    if (this.samples.length > this.windowSize) this.samples.shift();
    if (this.samples.length < 2) return null;
    const first = this.samples[0];
    const latest = this.samples[this.samples.length - 1];
    const wallMs = latest.atMs - first.atMs;
    if (wallMs <= 0) return null;
    return (latest.paintedMs - first.paintedMs) / wallMs;
  }

  /** Drops the window, so a rate change is not measured across its own edge. */
  reset(): void {
    this.samples.length = 0;
  }
}

/**
 * Cache lookups across every tier. Only an exact seek looks the cache up, so
 * playback and key seeks never move this and a play-only session sits at zero.
 * A rule or readout that reads the hit rate without this denominator reports a
 * cold cache as a failing one.
 */
export function cacheLookups(
  cache: FrameCacheStats | null | undefined,
): number {
  if (!cache) return 0;
  return cache.exactHits + cache.previewHits + cache.misses;
}

/**
 * Pure threshold evaluator. Reads a snapshot and returns the active diagnoses,
 * critical first. Used both in the worker (so the broadcast carries warnings the
 * UI and the trace share) and in tests. No I/O, no side effects.
 */
export function evaluateWarnings(snapshot: DiagnosticsSnapshot): Warning[] {
  const out: Warning[] = [];
  const { gop, geometry, scrub, counters, realtime, scheduler } = snapshot;
  const nativeFps = snapshot.nativeFps ?? null;
  const status = snapshot.status;
  const lookups = cacheLookups(scheduler?.cache);
  const cacheHit = lookups > 0 ? scrub.cacheHitRatePct : null;
  const hitRateText =
    cacheHit === null
      ? "n/a (0 lookups)"
      : `${cacheHit.toFixed(0)}% over ${lookups} lookups`;
  const exactCapacity = scheduler?.cache.exactCapacity ?? 0;
  const evictions = scheduler?.cache.exactEvictions ?? 0;

  // GOP stats are computed over the lazily-discovered keyframe subset. A
  // handful of non-adjacent anchors can fabricate or hide a long GOP, so wait
  // for a representative sample before raising the critical.
  const GOP_MIN_SAMPLE = 8;
  if (
    gop.count >= GOP_MIN_SAMPLE &&
    (gop.maxGopS > 6 ||
      (gop.avgGopS > 5 && gop.estimatedGopWalkDepthFrames > 60))
  ) {
    out.push({
      id: "LONG_GOP",
      severity: "critical",
      title: "Long GOPs",
      scenario:
        "Long GOPs make every off-anchor scrub decode a wall of frames before it can paint.",
      advice:
        "Re-encode with keyint ~= 2x fps, or navigate with key-seek instead.",
      evidence: `maxGopS=${gop.maxGopS.toFixed(2)}, avgGopS=${gop.avgGopS.toFixed(2)}, est walk=${gop.estimatedGopWalkDepthFrames} frames over ${gop.count} discovered keyframes`,
    });
  }

  if (
    geometry.decodeVsDisplayAreaRatio !== null &&
    geometry.decodeVsDisplayAreaRatio > 2
  ) {
    out.push({
      id: "DECODE_LARGER_THAN_DISPLAY",
      severity: "critical",
      title: "Decoding larger than display",
      scenario:
        "Decoding far larger than you paint wastes decode bandwidth every frame.",
      advice:
        "Enable or tighten the decode-resolution downscale to track the canvas.",
      evidence: `decode=${geometry.decodeWidth}x${geometry.decodeHeight}, areaRatio=${geometry.decodeVsDisplayAreaRatio?.toFixed(2) ?? "n/a"}`,
    });
  }

  if (scheduler !== null && exactCapacity <= 3) {
    out.push({
      id: "CACHE_STARVED",
      severity: "critical",
      title: "Cache starved",
      scenario:
        "The exact tier holds only a couple of slots, so neighbor scrubs re-decode.",
      advice:
        "Raise the exact-cache budget or decode smaller so more frames fit.",
      evidence: `exactCapacity=${exactCapacity}, hitRate=${hitRateText}`,
    });
  }

  const catchUpThreshold = 3 * (1000 / Math.max(nativeFps ?? FALLBACK_FPS, 30));
  // catchUpMs is only meaningful while playing; a paused paint that landed
  // short of its target would otherwise trip a false critical.
  if (status === "PLAYING" && realtime.catchUpMs > catchUpThreshold) {
    out.push({
      id: "PLAYBACK_BEHIND",
      severity: "critical",
      title: "Playback behind",
      scenario: "Playback cannot keep up with the source rate.",
      advice:
        "Lower decode resolution, prefer WebGPU, avoid play-start deep in a long GOP.",
      evidence: `catchUpMs=${realtime.catchUpMs} over a ${Math.round(catchUpThreshold)}ms budget, nativeFps=${nativeFps?.toFixed(1) ?? "n/a"}`,
    });
  }

  // A commanded rate is a promise about the picture, and the clock keeps that
  // promise whether or not the pipeline can: media time runs at rate either
  // way, so the transport reads healthy while the picture falls further behind
  // every second. The measured rate is what says so. Scoped to a non-default
  // rate, whose ceiling is a property of the source; at 1x the same shortfall
  // is PLAYBACK_BEHIND.
  //
  // Both halves are required. presentedRate quantises hard when paints are
  // sparse, which a slow rate on a low-fps source produces from a perfectly
  // healthy pipeline, so catch-up depth has to corroborate that the picture
  // really has fallen behind.
  const presented = snapshot.presentedRate;
  if (
    status === "PLAYING" &&
    snapshot.rate !== 1 &&
    presented !== null &&
    presented < snapshot.rate * PLAYBACK_RATE.SUSTAINED_SHORTFALL &&
    realtime.catchUpMs > catchUpThreshold
  ) {
    out.push({
      id: "PLAYBACK_RATE_NOT_SUSTAINED",
      severity: "warn",
      title: "Playback rate not sustained",
      scenario:
        "The clock is running at the rate it was given but the picture is not keeping up, so what you see is slower than what the playhead reports.",
      advice:
        "This source cannot decode that many frames a second. Drop to a rate the measured one can reach, or decode smaller.",
      evidence: `rate=${snapshot.rate}x, presented=${presented.toFixed(2)}x, effectivePaintFps=${realtime.effectivePaintFps?.toFixed(1) ?? "n/a"}, nativeFps=${nativeFps?.toFixed(1) ?? "n/a"}, catchUpMs=${realtime.catchUpMs}`,
    });
  }

  // A stall is only booked after the session's first paint, so a pump that
  // never paints books none and PLAYBACK_STARVING cannot see it. 120 ticks is
  // ~2s of rAF, past any plausible first-frame decode.
  const PUMP_DEAD_TICKS = 120;
  const drain = scheduler?.drain;
  if (
    status === "PLAYING" &&
    realtime.ticks >= PUMP_DEAD_TICKS &&
    realtime.paints === 0
  ) {
    out.push({
      id: "PLAYBACK_PUMP_DEAD",
      severity: "critical",
      title: "Playback pump dead",
      scenario:
        "Playback is running and the render loop is ticking, but not one frame has reached the canvas this play session.",
      advice: drain?.draining
        ? "A seek is still draining, and every play pull is refused while one is. Find why that seek has not finished; the dead pump is its symptom, not the cause."
        : "Follow the play pull: a lost or abandoned iterator pull leaves the loop ticking over an empty queue forever, which reads as a frozen canvas.",
      evidence: `ticks=${realtime.ticks}, paints=0, playQueueDepth=${realtime.playQueueDepth}, nextPending=${counters.nextPending}, decoderDead=${scheduler?.decoderDead ?? false}, seekDraining=${drain?.draining ?? false}, seekDrainingForMs=${Math.round(counters.seekDrainingForMs)}`,
    });
  }

  // A drain outliving every decode it can be waiting on IS the wedge: it
  // refuses every play pull for as long as it lasts, and the pump warning
  // above only fires once playback has been asked for and denied.
  // Half the ceiling the runtime allows one decode, so this can only fire on a
  // drain that has outlived a decode the runtime itself would still be waiting
  // on. A flat two seconds fired on GOP walks the hang guard documents as
  // healthy.
  const DRAIN_STUCK_MS = HANG_RECOVERY.DECODE_HANG_TIMEOUT_MS / 2;
  if (drain?.draining && counters.seekDrainingForMs >= DRAIN_STUCK_MS) {
    out.push({
      id: "SEEK_DRAIN_STUCK",
      severity: "critical",
      title: "Seek never settled",
      scenario:
        "A seek has been draining far longer than a decode takes. Play pulls are refused for the whole time, so the picture is frozen while the transport still reads as playing.",
      advice:
        "The seek's decode has not come back. Look for a walk holding the decode session, and check whether the hang watchdog has fired yet.",
      evidence: `seekDrainingForMs=${Math.round(counters.seekDrainingForMs)}, pendingTargetMs=${drain.pendingTargetMs}, recovering=${drain.recovering}, foregroundDecodes=${counters.foregroundDecodes}`,
    });
  }

  // Frames decoded and thrown away before reaching the canvas: the provenance
  // guard drops frames that arrived for a position playback had left, and the
  // horizon flush drops a buffer the clock moved backwards under. A few around
  // a seek are the mechanism working; a stream of them while playing is decode
  // bandwidth spent on frames nobody ever saw.
  //
  // Once the rate asks for more frames a second than the present cadence, the
  // pump declines the surplus on purpose and charges it to this same ledger,
  // fast enough to clear any threshold within a second. Nothing in the
  // snapshot tells a declined frame from a wasted one, so above the cadence
  // this rule has nothing left to read and stays quiet.
  const DROPPED_FRAMES_LIMIT = 30;
  const sourceFps = nativeFps ?? FALLBACK_FPS;
  const rateOutrunsCadence =
    snapshot.rate * sourceFps >
    Math.max(PLAYBACK.PRESENT_CADENCE_HZ, sourceFps);
  if (
    status === "PLAYING" &&
    !rateOutrunsCadence &&
    realtime.droppedFrames >= DROPPED_FRAMES_LIMIT
  ) {
    out.push({
      id: "PLAYBACK_FRAMES_DISCARDED",
      severity: "warn",
      title: "Decoded frames are being thrown away",
      scenario:
        "Playback keeps decoding frames that are then discarded before they reach the canvas, so decode time is being spent on frames nobody sees.",
      advice:
        "Check what keeps arriving for a position playback has left: a seek that outlives its gesture, or a clock moving backwards under the buffer.",
      evidence: `droppedFrames=${realtime.droppedFrames}, playQueueDepth=${realtime.playQueueDepth}, paints=${realtime.paints}, rate=${snapshot.rate}x, nativeFps=${nativeFps?.toFixed(1) ?? "n/a"}`,
    });
  }

  if (scheduler?.decoderDead === true) {
    out.push({
      id: "DECODER_DEAD",
      severity: "critical",
      title: "Decoder dead",
      scenario:
        "A decode hung and the source could not be re-opened, so every later decode no-ops: the canvas holds its last frame and nothing new ever lands.",
      advice:
        "Reload the source. A re-openable source (a URL or a File rather than a one-shot stream) lets the runtime rebuild the decoder instead of degrading.",
      evidence: `decoderDead=true, foregroundDecodes=${counters.foregroundDecodes}, playQueueDepth=${realtime.playQueueDepth}`,
    });
  }

  if (realtime.stalls > 2 && status === "PLAYING") {
    out.push({
      id: "PLAYBACK_STARVING",
      severity: "critical",
      title: "Playback starving",
      scenario:
        "The canvas is freezing mid-play; the pipeline is out of buffered output.",
      advice:
        "Reduce decode resolution, warm the forward iterator, or use a lighter encode.",
      evidence: `stalls=${realtime.stalls}, status=${status}`,
    });
  }

  if (cacheHit !== null && cacheHit < 50 && scrub.avgMs > 200) {
    out.push({
      id: "SCRUB_DECODE_BOUND",
      severity: "warn",
      title: "Scrub decode-bound",
      scenario: "Most drags wait on a fresh decode rather than the cache.",
      advice:
        "Shrink decode resolution; let the playhead settle so the sweep warms the region.",
      evidence: `hitRate=${hitRateText}, avgMs=${scrub.avgMs.toFixed(0)}`,
    });
  }

  if (scrub.p95Ms > 350 && scrub.avgMs <= 200) {
    out.push({
      id: "SCRUB_P95_JANK",
      severity: "warn",
      title: "Worst-case scrub jank",
      scenario:
        "Worst-case seeks are janky though averages look fine: irregular GOP regions.",
      advice: "Check the max GOP and keyframe regularity.",
      evidence: `p95Ms=${scrub.p95Ms.toFixed(0)}, avgMs=${scrub.avgMs.toFixed(0)}`,
    });
  }

  if (scrub.targetVsLandedMs > 200) {
    out.push({
      id: "PLAYHEAD_STICKS",
      severity: "warn",
      title: "Playhead sticks short",
      scenario:
        "The playhead lands short of where you aimed; a long GOP forces a distant anchor.",
      advice: "Use shorter keyframe spacing or lower decode resolution.",
      evidence: `targetVsLandedMs=${scrub.targetVsLandedMs}`,
    });
  }

  if (counters.seekCoalesceDepth > 6) {
    out.push({
      id: "SCRUB_OUTRUNS_DECODER",
      severity: "warn",
      title: "Scrub outruns the decoder",
      scenario:
        "Dragging faster than the decoder resolves; only the final position lands.",
      advice: "Reduce per-frame decode cost so the cache can warm as you drag.",
      evidence: `seekCoalesceDepth=${counters.seekCoalesceDepth}`,
    });
  }

  if (scrub.timeToCrispMs > 300) {
    out.push({
      id: "SLOW_TIME_TO_CRISP",
      severity: "warn",
      title: "Slow time-to-crisp",
      scenario:
        "Preview frames stay blurry too long; the crisp decode behind them is slow.",
      advice:
        "A large frame or long GOP is the cause; lower decode resolution.",
      evidence: `timeToCrispMs=${scrub.timeToCrispMs.toFixed(0)}`,
    });
  }

  if (
    evictions > 0 &&
    cacheHit !== null &&
    cacheHit < 60 &&
    exactCapacity > 0 &&
    evictions > exactCapacity
  ) {
    out.push({
      id: "CACHE_THRASH",
      severity: "warn",
      title: "Cache thrash",
      scenario:
        "Frames you just used keep getting evicted; the budget is too small for the frame size.",
      advice: "Reduce decode resolution or raise the cache budget.",
      evidence: `evictions=${evictions}, exactCapacity=${exactCapacity}, hitRate=${hitRateText}`,
    });
  }

  if (gop.count >= GOP_MIN_SAMPLE && gop.minGopS < 0.05 && gop.avgGopS < 0.2) {
    out.push({
      id: "ALL_INTRA",
      severity: "info",
      title: "All-intra encode",
      scenario: "A tiny-GOP or all-intra encode is burning decode bandwidth.",
      advice: "A normal 1-2s GOP cuts file size and decode bandwidth.",
      evidence: `minGopS=${gop.minGopS.toFixed(3)}, avgGopS=${gop.avgGopS.toFixed(3)} over ${gop.count} discovered keyframes`,
    });
  }

  if (nativeFps === null) {
    out.push({
      id: "NATIVE_FPS_UNKNOWN",
      severity: "info",
      title: "Frame rate unknown",
      scenario:
        "Frame rate is unknown; step and prefetch math fall back to 30fps.",
      advice:
        "Prefer real stepForward/Backward, or re-mux with timing metadata.",
      evidence: "nativeFps=null",
    });
  }

  return out.sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity),
  );
}

function severityRank(severity: WarningSeverity): number {
  return severity === "critical" ? 2 : severity === "warn" ? 1 : 0;
}
