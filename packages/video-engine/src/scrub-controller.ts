import type { MediaClock } from "./clock";
import { PLAYBACK, PLAYBACK_RATE } from "./constants";
import type { RendererName } from "./diagnostics";
import {
  createRenderer,
  type FrameSink,
  RendererFrameSink,
  TransferFrameSink,
} from "./renderer";
import {
  earnsScreen,
  type FrameQuality,
  type ScrubCursor,
  type ScrubFrame,
} from "./scrub-cursor";
import type { PresentationMode } from "./types";

/**
 * Per-rAF diagnostics gate. False by default, so the render loop pays a single
 * predicted-false branch per tick and runs no diagnostics math or allocation.
 * The engine flips it on diagnosticsStart and off on diagnosticsStop. Module
 * level (not per-instance) because the loop reads it on the hottest path and a
 * field read through `this.deps` would be one more indirection per tick.
 */
let diagnosticsEnabled = false;

export function setDiagnosticsEnabled(enabled: boolean): void {
  diagnosticsEnabled = enabled;
}

/** Per-rAF realtime needles, collected only while diagnostics are enabled. ticks
 *  is every loop turn; paints is every frame drawn; lateFrames is a playing frame
 *  more than one interval behind the clock; stalls is a playing tick with no frame
 *  to paint; catchUpMs is how far the clock has run past the last painted frame.
 *  playQueueDepth is the decode-ahead buffer's current length: a live read, not a
 *  per-tick accumulator, so 0 while playing means the pipeline ran dry. */
export interface RealtimeStats {
  readonly ticks: number;
  readonly paints: number;
  readonly lateFrames: number;
  readonly stalls: number;
  readonly catchUpMs: number;
  readonly playQueueDepth: number;
  readonly endedFired: boolean;
  /** Decoded frames thrown away before reaching the canvas: ones that arrived
   *  for a position playback had left, buffered ones overtaken by the clock
   *  moving backwards, and the ones the present cadence declines once the rate
   *  asks for more frames a second than it. All three cost a full decode. The
   *  first two are decode bandwidth spent on nothing; the third is the cadence
   *  doing its job, and at a high rate it dominates the count. */
  readonly droppedFrames: number;
  /** Same fact accumulated over the source's lifetime for the pipeline
   *  ledger, so it can sit beside the other monotonic counters. */
  readonly droppedFramesTotal: number;
}

/**
 * Render loop. One rAF tick. Mode-aware:
 *
 *   - Playing: the catch-up loop from the mediabunny media-player example.
 *     On each tick read clock.now(); if the stashed nextFrame's timestamp
 *     has arrived, paint it, then pull forward from the cursor in a
 *     while-loop. Late frames paint immediately; the first future-timestamped
 *     frame is stashed for the next tick. This matches Vanilagy's reference
 *     pattern and prevents visible skips when the decoder lags behind the clock.
 *
 *   - Paused: the cursor's most recent emission is whatever the latest
 *     seek landed on. Tick paints it once, nulls nextFrame, and never
 *     touches the iterator. Subsequent user input that calls seekTo
 *     emits a fresh frame, the listener stashes it, and the next tick
 *     paints it.
 *
 * No backup setInterval. rAF is enough: tab backgrounding will pause the
 * loop, but pause is the right behavior because nothing should advance
 * media time while the surface is not visible.
 *
 * Runs worker-side. It renders frames through a Renderer (the 2D canvas path
 * today, swappable for WebGPU behind the same seam); the cursor owns the frame
 * cache and fills it as it decodes, so this loop only reads it through
 * peekCached. The only way out is the onPaint callback, which EngineCore turns
 * into serializable state emits. No DOM, no React, no main-thread reference
 * ever reaches this loop.
 */
export interface ScrubControllerDeps {
  cursor: ScrubCursor;
  clock: MediaClock;
  /** catchUpMs is supplied only while diagnostics are enabled and playing, so
   *  the engine can fold it onto the broadcast frame event; undefined otherwise.
   *  presented carries the pixels when the sink handed them out instead of
   *  painting them, and transfers ownership of that frame with the call. */
  onPaint: (
    frame: ScrubFrame,
    catchUpMs?: number,
    presented?: VideoFrame | null,
  ) => void;
  /** Fired when playback runs past the source duration so the engine can
   *  transition to Ended status. Without this the iterator yields done
   *  forever and the play UI stays stuck on Playing while the canvas freezes. */
  onEnded: () => void;
  /** Cache lookups whose resolved entry is closer than this to whatever
   *  the visible canvas already shows are rejected. Forces a fresh decode
   *  on small movements (frame-step gestures) so the user sees the actual
   *  next/prev frame, not the cached neighbor. */
  cacheSkipNearMs: number;
  /** Pin the 2D renderer; unset prefers WebGPU, falling back to 2D when unavailable. */
  prefer2d?: boolean;
  /** Defaults to "canvas". Under "frames" the loop binds no canvas and every
   *  paint yields its pixels to onPaint instead. */
  presentation?: PresentationMode;
}

export class ScrubController {
  private rafHandle = 0;
  /** Paused/seek path: the single most-recent landed frame. */
  private nextFrame: ScrubFrame | null = null;
  /** Playing path: a bounded decode-ahead buffer so a decode that overruns a
   *  frame interval does not starve the next tick. Drained one frame per tick,
   *  refilled toward the read-ahead depth. */
  private playQueue: ScrubFrame[] = [];
  private sink: FrameSink | null = null;
  /** The canvas the latest bind targeted; guards the async renderer race. */
  private boundCanvas: OffscreenCanvas | null = null;
  private disposed = false;
  private unsub: (() => void) | null = null;
  /** Milliseconds-rounded timestamp of whatever the visible canvas
   *  currently shows. Updated on every paint (cursor emit OR cache hit).
   *  Drives the skip-near-current check in tryPaintFromCache. */
  private lastPaintedMs: number | null = null;
  /** Quality of what the canvas shows, so a repaint can be judged on sharpness
   *  as well as position. */
  private lastPaintedQuality: FrameQuality = "preview";
  /** Set true when runTick detects clock past duration so we only emit
   *  the onEnded transition once per playback session. */
  private endedFired = false;

  // Per-rAF realtime needles, advanced only while diagnostics are enabled.
  private ticks = 0;
  private paints = 0;
  private lateFrames = 0;
  private stalls = 0;
  private catchUpMs = 0;
  private droppedFrames = 0;
  /** Lifetime companion to droppedFrames for the pipeline ledger: never reset
   *  by a play session and not gated on diagnostics, so the ledger is honest
   *  even about what happened before the HUD opened. */
  private droppedFramesTotal = 0;
  /** False from every attach of the play walk until its first frame paints.
   *  The bootstrap pull is async, so the opening ticks find nextFrame null
   *  and would each book a stall the user never saw. */
  private paintedSincePlay = false;
  /** Whether a play session the user started is still running. A seek while
   *  playing re-attaches the walk through endPlay and beginPlay without ever
   *  stopping the transport, and a drag stops the transport for the length of
   *  the gesture and walks the playhead across the source under it. Neither is
   *  the user putting the picture down, and the per-session needles count the
   *  session the user is watching, not the walk. */
  private playSessionLive = false;
  /** Clock reading the transport stopped at, or null while it runs. A stopped
   *  clock moves only by being seeked, so a stopped tick reading anything else
   *  is a seek, which is why the comparison against it is exact. */
  private stoppedAtS: number | null = null;
  /** Media time the current play session was attached at, which is what makes
   *  a frame produced for a position the session has left recognisable. */
  private playAnchorS = 0;
  /** Media time the previous playing tick read, so a tick can price its own
   *  span in source frames. Null until the session's second tick. */
  private lastTickS: number | null = null;
  /** Clock reading at the play walk's last delivery, or null when no walk is
   *  attached. Set at the attach too, so the walk's opening frame is priced
   *  against the wait for it. */
  private lastDeliveryS: number | null = null;
  /** Source frames this tick may pull past the one it paints, refreshed per
   *  tick from the span the clock covered. Sourced from ticks so a loop that
   *  stops (a hidden tab parks rAF) takes the pull chain down with it. */
  private catchUpBudget = 0;
  /** Clock reading at the last paint this play session put on screen, which is
   *  what the wall-time gap between presents is measured from. Null until the
   *  session's first paint, so an opening frame is never held for cadence. */
  private lastPresentTickS: number | null = null;
  /** The share of the rate's demand the pump allows itself to present. Held as
   *  a share rather than a frames-a-second figure so it survives a rate change
   *  as the same statement about the machine: a pipeline that was keeping up
   *  at 1x opens 4x at everything 4x asks for, with no ramp to climb. */
  private presentShare = 1;
  /** Frames the running play walk has delivered into the queue, and the two
   *  readings the cadence loop last took: the clock, and that same count.
   *  Between them a tick knows what it asked the pipeline for and what it got. */
  private walkDelivered = 0;
  private cadenceTickS: number | null = null;
  private cadenceDeliveredAt = 0;
  /** Frames the pipeline owes the playhead since the cadence last moved: what
   *  the clock has asked for, less what the walk delivered. Zeroed on every
   *  move, so it holds the evidence for the next one rather than the ground
   *  lost over the session. */
  private cadenceBacklog = 0;
  /** Wall seconds the walk has held a frame the clock has not run past, without
   *  a break, which is the only evidence a pipeline can offer that it has room
   *  to spare. */
  private cadenceCushionS = 0;

  constructor(private readonly deps: ScrubControllerDeps) {
    this.unsub = this.deps.cursor.subscribe((frame) => {
      this.stash(frame);
    });
    // Frames mode binds no canvas, so the loop has no other start.
    if (deps.presentation === "frames") {
      this.sink = new TransferFrameSink();
      this.start();
    }
  }

  /**
   * Routes an arriving frame. While playing it appends to the decode-ahead
   * queue and chains another pull until the read-ahead depth is reached (the
   * cursor's one-in-flight latch makes the extra pulls free no-ops). While
   * paused it replaces the single stashed frame, closing the superseded one
   * when it is an unpainted sample so a fast drag does not leak VideoSamples.
   */
  private stash(frame: ScrubFrame): void {
    if (this.deps.clock.playing) {
      if (!this.belongsToPlaySession(frame)) {
        if (frame.kind === "sample") frame.sample.close();
        this.droppedFramesTotal += 1;
        if (diagnosticsEnabled) this.droppedFrames += 1;
        return;
      }
      this.reanchorStarvedWalk(frame);
      this.playQueue.push(frame);
      this.walkDelivered += 1;
      const t = this.deps.clock.now();
      this.lastDeliveryS = t;
      this.dropFramesTheClockHasPassed(t);
      if (this.playQueue.length < this.readAhead()) {
        this.deps.cursor.next();
        return;
      }
      if (this.catchUpBudget > 0 && this.trailsTheClock(t)) {
        this.catchUpBudget -= 1;
        this.deps.cursor.next();
      }
      return;
    }
    const prev = this.nextFrame;
    if (prev && prev !== frame && prev.kind === "sample") prev.sample.close();
    this.nextFrame = frame;
  }

  /**
   * Decoded frames to keep queued ahead of the playhead. The decode path
   * decides it, not the shape of the frame: reading it off the frame treated
   * every sample-carrying path as pool-bound, which the long-lived decode
   * session is not, so the default path ran with a queue of one and no cushion
   * at all. A cushion is the whole point, it is what stops a decode that
   * overruns one frame interval from starving the next paint.
   */
  private readAhead(): number {
    return this.deps.cursor.playReadAhead ?? PLAYBACK.READ_AHEAD_CANVAS;
  }

  /**
   * Whether a frame arriving while the clock runs belongs to the running play
   * session. The controller receives every frame the cursor emits, not only
   * the ones its own pulls asked for, so a seek still landing when playback
   * resumes delivers a frame for a position the session has already left.
   * Queued, that frame sits at the head never due, which blocks the paint and
   * the refill alike, and playback resumes only once the clock has run all the
   * way to it: exactly as long as the jump the user just made.
   */
  private belongsToPlaySession(frame: ScrubFrame): boolean {
    // A session opens on the frame at or before its anchor, so one interval
    // behind the anchor is a frame it legitimately starts on.
    if (frame.timestampS < this.playAnchorS - this.frameIntervalS())
      return false;
    return !this.beyondPlayHorizon(frame, this.deps.clock.now());
  }

  /**
   * Whether a queued frame is further ahead of the clock than playback can
   * legitimately buffer. Play frames come from an iterator anchored at the
   * playhead, so the buffer leads the clock by its own depth and no more. A
   * frame past that either arrived for a position the session has left, or was
   * overtaken when the clock moved backwards under the queue, which a step or
   * a seek during playback both do.
   */
  private beyondPlayHorizon(frame: ScrubFrame, t: number): boolean {
    return (
      frame.timestampS >
      t + (PLAYBACK.READ_AHEAD_CANVAS + 2) * this.frameIntervalS()
    );
  }

  /**
   * Discards every queued frame the clock has already run past except the last
   * one, which is the frame that belongs on screen now.
   *
   * A tick can only present one frame, so whenever more than one falls due in
   * the same tick the surplus has nowhere to go. Serving them one a tick
   * instead makes the picture drift further behind the playhead every tick,
   * which is what a rate past display-refresh over source-fps produces on a
   * pipeline that is otherwise keeping up perfectly. Skipping keeps the picture
   * on the playhead and charges the difference to the dropped-frame ledger,
   * where a consumer can see what the rate cost.
   */
  private dropFramesTheClockHasPassed(t: number): void {
    let dropped = 0;
    while (this.playQueue.length > 1 && this.playQueue[1].timestampS <= t) {
      const stale = this.playQueue.shift();
      if (stale?.kind === "sample") stale.sample.close();
      dropped += 1;
    }
    if (dropped === 0) return;
    this.droppedFramesTotal += dropped;
    if (diagnosticsEnabled) this.droppedFrames += dropped;
  }

  /**
   * Source frames this tick may pull past the one it paints, measured as the
   * span the clock covered. One of them covers that span, which is what a rate
   * demanding more than a frame per tick needs and cannot get from a queue
   * bounded by read-ahead depth; the rest work off a backlog, so a pipeline a
   * slow stretch knocked behind can return to the playhead.
   */
  private catchUpAllowance(t: number): number {
    const previous = this.lastTickS;
    this.lastTickS = t;
    if (previous === null || t <= previous) return 0;
    return Math.max(1, Math.round((t - previous) / this.frameIntervalS()));
  }

  /**
   * Presents a wall second the pump allows itself right now: the rate's demand
   * cut to the share the machine has been paying for, and never under the
   * source's own frame rate. Rate 1 asks for exactly the source rate, so its
   * floor and its demand are the same figure and no share can come between
   * them, which is what leaves 1x painting every frame of every source.
   */
  private presentCadence(): number {
    const fps = 1 / this.frameIntervalS();
    return Math.max(fps, this.deps.clock.rate * fps * this.presentShare);
  }

  /** Forgets what the cadence loop had gathered. The walk is about to be
   *  attached somewhere else, and a span across that move charges the pipeline
   *  for frames it was never asked to have ready. */
  private resetCadenceTracking(): void {
    this.walkDelivered = 0;
    this.cadenceTickS = null;
    this.cadenceDeliveredAt = 0;
    this.cadenceBacklog = 0;
    this.cadenceCushionS = 0;
  }

  /**
   * Prices this tick against the pipeline and moves the share one step once
   * either reading has gathered the evidence a step takes.
   *
   * What takes the share down is a running bill, in frames, between what the
   * clock passed and what the play walk delivered over the same span.
   * Accumulating rather than thresholding each tick is what tells a shortfall
   * from noise: counting whole frames against a fractional demand leaves every
   * tick out by up to one either way and those cancel, while a machine that
   * cannot sustain the rate falls short every tick and adds up. A machine that
   * can sustain it has no way to run the bill up, since the queue only takes a
   * frame as the clock passes one and catch-up pulls repay any span the walk
   * came up short on, which bounds the bill by the depth being held.
   *
   * What puts the share back is the walk holding a frame the clock has not run
   * past, unbroken for the wall time the source takes to produce that many.
   * Nothing else would do, since a machine at equilibrium delivers exactly what
   * the clock asks for however much headroom it has, so a surplus never appears
   * in the bill to be read.
   *
   * Neither reading is the depth of the decode-ahead queue, which belongs to
   * the decode path and not to the machine: on the zero-copy path, which
   * buffers one frame, a single frame in hand is full depth and one tick from
   * empty alike.
   *
   * Nothing either reading is made of knows what the panel refreshes at, so one
   * machine lands on one cadence on any panel; a present the share declines
   * hands its time back to decode, so the loop this closes is a negative one;
   * and zeroing both on each step makes the next one gather its own evidence,
   * which is what a share sitting at the machine's limit needs to stop it
   * pulsing.
   */
  private observePresentCadence(t: number): void {
    const previousT = this.cadenceTickS;
    const previousDelivered = this.cadenceDeliveredAt;
    this.cadenceTickS = t;
    this.cadenceDeliveredAt = this.walkDelivered;
    // Before the walk's first frame the clock is passing frames nothing was
    // given the chance to have ready, which is the opening buffering window.
    if (this.walkDelivered === 0) return;
    if (previousT === null || t <= previousT) return;
    const intervalS = this.frameIntervalS();
    this.cadenceBacklog +=
      (t - previousT) / intervalS - (this.walkDelivered - previousDelivered);
    if (this.playQueue.length > 0 && !this.trailsTheClock(t)) {
      this.cadenceCushionS += (t - previousT) / this.deps.clock.rate;
    } else {
      this.cadenceCushionS = 0;
    }
    const cushionS = PLAYBACK.PRESENT_CADENCE_EVIDENCE_FRAMES * intervalS;
    if (this.cadenceBacklog >= PLAYBACK.PRESENT_CADENCE_EVIDENCE_FRAMES) {
      this.presentShare = Math.max(
        1 / PLAYBACK_RATE.MAX,
        this.presentShare * PLAYBACK.PRESENT_CADENCE_STEP,
      );
    } else if (this.cadenceCushionS >= cushionS) {
      this.presentShare = Math.min(
        1,
        this.presentShare / PLAYBACK.PRESENT_CADENCE_STEP,
      );
    } else {
      return;
    }
    this.cadenceBacklog = 0;
    this.cadenceCushionS = 0;
  }

  /**
   * Whether the frame that is due arrives too soon after the last painted one
   * to earn the screen. Wall time, read as the media span over the clock's
   * slope, so the same gap decides at every rate. The pump paints at most one
   * frame per display tick, so it can only decline one on a panel whose ticks
   * fall closer together than the interval it compares against.
   *
   * A cadence sitting at its ceiling never reaches the wall-time test, so a
   * machine keeping up declines nothing at any rate, and the ceiling equals the
   * demand at rate 1, which paints every frame of every source. A clock that
   * moved backwards under the pump reads as a non-positive span and paints,
   * which is what stops a step or a seek during playback from holding the
   * picture for the length of the jump it made.
   */
  private skipsForPresentCadence(t: number): boolean {
    if (this.lastPresentTickS === null) return false;
    const rate = this.deps.clock.rate;
    const cadenceHz = this.presentCadence();
    const demandHz = rate / this.frameIntervalS();
    if (demandHz <= cadenceHz) return false;
    const sinceMs = ((t - this.lastPresentTickS) / rate) * 1000;
    if (sinceMs <= 0) return false;
    return sinceMs < (1000 / cadenceHz) * (1 - PLAYBACK.PRESENT_CADENCE_SLACK);
  }

  /**
   * Re-anchors the playback walk when the clock ran further past the previous
   * tick than a loop that was actually running could have let it, and reports
   * whether it did.
   *
   * A hidden tab parks rAF while the clock keeps wall time, so the tick that
   * resumes finds a backlog as deep as the whole absence. Walked, it costs one
   * decode per frame nobody was there to see, and the picture replays the
   * absence at decode rate on its way to the playhead: 30 seconds hidden
   * measured 4961ms of 8x fast-forward. Anchoring at the playhead lands the
   * frame that walk was travelling toward for one keyframe seek, flat in how
   * far the clock went.
   *
   * Dividing the span by the clock's slope is what makes the reading wall time,
   * so a high rate legitimately moving the clock several frames per tick is not
   * read as a loop nobody was driving.
   */
  private reanchorParkedWalk(t: number): boolean {
    const previous = this.lastTickS;
    if (previous === null) return false;
    const wallMs = ((t - previous) / this.deps.clock.rate) * 1000;
    if (wallMs <= PLAYBACK.REANCHOR_STALL_MS) return false;
    this.lastTickS = t;
    this.lastDeliveryS = t;
    this.catchUpBudget = 0;
    this.resetCadenceTracking();
    this.droppedFramesTotal += this.playQueue.length;
    if (diagnosticsEnabled) this.droppedFrames += this.playQueue.length;
    this.clearPlayQueue();
    this.playAnchorS = t;
    this.tryPaintFromCache(t * 1000);
    this.deps.cursor.attachPlay(t);
    this.deps.cursor.next();
    return true;
  }

  /**
   * Puts the clock back onto the frame a starved walk has just delivered.
   *
   * A seek onto unbuffered ground leaves the render loop ticking with nothing
   * to paint, so no tick gap ever opens and reanchorParkedWalk never sees it;
   * what stopped is the walk. The clock runs through the whole wait, so the
   * frame the viewer asked for arrives that far behind it, and a walk left to
   * catch up spends the wait replaying it at decode speed: the position they
   * asked to see, flashed past on the way to one they did not.
   */
  private reanchorStarvedWalk(frame: ScrubFrame): void {
    const since = this.lastDeliveryS;
    if (since === null) return;
    const wallMs =
      ((this.deps.clock.now() - since) / this.deps.clock.rate) * 1000;
    if (wallMs <= PLAYBACK.REANCHOR_STALL_MS) return;
    this.deps.clock.seek(frame.timestampS);
    this.lastTickS = null;
    this.catchUpBudget = 0;
    this.lastPresentTickS = null;
    this.resetCadenceTracking();
  }

  /**
   * Whether the newest decoded frame is already older than the clock, which
   * makes the queue a backlog and the next pull catch-up. Read-ahead depth
   * cannot bound catch-up as well: a path that holds one frame consumes one
   * source frame per tick, which pins the picture to tick rate over source fps
   * whatever rate was commanded.
   */
  private trailsTheClock(t: number): boolean {
    const newest = this.playQueue[this.playQueue.length - 1];
    return (
      newest !== undefined && t - newest.timestampS > this.frameIntervalS()
    );
  }

  /** Drops every queued play frame, closing any that are unpainted samples. */
  private clearPlayQueue(): void {
    for (const frame of this.playQueue) {
      if (frame.kind === "sample") frame.sample.close();
    }
    this.playQueue = [];
  }

  bindCanvas(el: OffscreenCanvas | null): void {
    if (!el) {
      this.stop();
      this.boundCanvas = null;
      this.sink?.dispose();
      this.sink = null;
      // Nothing will paint queued frames now; release any held samples.
      this.clearStash();
      this.clearPlayQueue();
      return;
    }
    const w = this.deps.cursor.track.decodeWidth;
    const h = this.deps.cursor.track.decodeHeight;
    if (w > 0 && h > 0) {
      el.width = w;
      el.height = h;
    }
    this.boundCanvas = el;
    this.sink?.dispose();
    this.sink = null;
    // The render loop starts now and no-ops until the renderer resolves;
    // renderer creation is async because WebGPU device acquisition is.
    this.start();
    void this.attachRenderer(el);
  }

  /** The active render backend, for diagnostics; null until it resolves. */
  rendererName(): RendererName | null {
    return this.sink?.name ?? null;
  }

  private async attachRenderer(el: OffscreenCanvas): Promise<void> {
    const renderer = await createRenderer(el, { prefer2d: this.deps.prefer2d });
    // A re-bind or dispose during the async init supersedes this renderer.
    if (this.disposed || this.boundCanvas !== el) {
      renderer.dispose();
      return;
    }
    this.sink = new RendererFrameSink(renderer);
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.unsub?.();
    this.unsub = null;
    this.clearStash();
    this.clearPlayQueue();
    this.sink?.dispose();
    this.sink = null;
  }

  /** Drops the stashed frame, closing it if it is an unpainted sample. */
  private clearStash(): void {
    const frame = this.nextFrame;
    this.nextFrame = null;
    if (frame?.kind === "sample") frame.sample.close();
  }

  /**
   * Millisecond timestamp of whatever the visible canvas currently shows.
   * Engine.step uses this as the base for "next frame after current" so
   * step lands on the actual neighbor frame, not on a 1/fps arithmetic
   * guess from store.timeMs (which holds user intent during scrub).
   */
  getLastPaintedMs(): number | null {
    return this.lastPaintedMs;
  }

  getLastPaintedQuality(): FrameQuality {
    return this.lastPaintedQuality;
  }

  /**
   * Called by the engine on play(), and again by a seek that re-anchors a walk
   * already running. Attaches the cursor's forward iterator at the current
   * media time and kicks the bootstrap pull. Also clears the EOF latch so a
   * play-restart from past-end can fire onEnded again the next time the clock
   * crosses the duration.
   */
  beginPlay(startS: number): void {
    this.endedFired = false;
    this.playAnchorS = startS;
    // The realtime needles are per-session rates, not lifetime totals: a
    // cumulative count crosses its band on the first heavy file and trips its
    // critical on every later snapshot even once playback is smooth. Zeroing
    // them for a stop the user did not make would take the numbers the HUD is
    // showing backwards in the middle of a session they never interrupted.
    if (!this.playSessionLive) {
      this.ticks = 0;
      this.paints = 0;
      this.lateFrames = 0;
      this.stalls = 0;
      this.catchUpMs = 0;
      this.droppedFrames = 0;
      // What the share had come down to belongs to the source that measured
      // it. A seek re-anchors the walk mid-session and keeps it; the user
      // putting the picture down and starting again does not.
      this.presentShare = 1;
    }
    this.playSessionLive = true;
    this.stoppedAtS = null;
    this.paintedSincePlay = false;
    this.lastTickS = null;
    this.lastDeliveryS = startS;
    this.catchUpBudget = 0;
    this.lastPresentTickS = null;
    this.resetCadenceTracking();
    this.clearPlayQueue();
    this.deps.cursor.attachPlay(startS);
    this.deps.cursor.next();
  }

  /** Called by the engine on pause(), and by a seek re-anchoring a running
   *  walk. Detaches the iterator and drops the read-ahead so paused ticks
   *  never paint a stale play frame. */
  endPlay(): void {
    // Every caller that ends a session stops the clock before it detaches the
    // walk, so a clock still running here is a seek re-anchoring mid-session.
    this.playSessionLive = this.deps.clock.playing;
    this.stoppedAtS = this.playSessionLive ? null : this.deps.clock.now();
    this.deps.cursor.detachPlay();
    this.lastTickS = null;
    this.lastDeliveryS = null;
    this.catchUpBudget = 0;
    this.lastPresentTickS = null;
    this.resetCadenceTracking();
    this.clearPlayQueue();
  }

  /**
   * Cache lookup helper used by the engine on scrub. Asks the cursor for a
   * cached frame near the target and, if it is far enough from what the canvas
   * already shows, paints it and returns true. Either way the engine still
   * calls cursor.seekTo to land the full-res frame; the cursor's emit listener
   * stashes it for the next tick.
   *
   * The skip-near-current check rejects hits whose timestamp falls within
   * cacheSkipNearMs of the currently-displayed frame. This is the knob
   * consumers tune to control single-frame-step UX: a higher value forces a
   * fresh decode on tighter movements, a value of 0 always serves the cache.
   */
  tryPaintFromCache(timestampMs: number): boolean {
    if (!this.sink) return false;
    const hit = this.deps.cursor.peekCached(timestampMs);
    if (!hit) return false;
    const hitMs = Math.round(hit.timestampS * 1000);
    if (this.lastPaintedMs !== null) {
      if (Math.abs(hitMs - this.lastPaintedMs) < this.deps.cacheSkipNearMs)
        return false;
      // And it has to be an improvement on what is showing, measured from
      // where the user is pointing. The check above measures only distance
      // from the current frame, which is blind to direction: a cached frame
      // on the far side of the playhead clears it just as easily as one
      // between the two, so scrubbing forward could paint a frame further
      // behind than the one already up.
      const showing = {
        timestampMs: this.lastPaintedMs,
        quality: this.lastPaintedQuality,
      };
      if (
        !earnsScreen(
          { timestampMs: hitMs, quality: hit.quality },
          showing,
          timestampMs,
        )
      ) {
        return false;
      }
    }
    // A cache hit is always a canvas blit, never a live sample, so there is
    // no close obligation here.
    const presented = this.sink.present(hit);
    this.lastPaintedMs = hitMs;
    this.lastPaintedQuality = hit.quality;
    // This is a full frame on the display canvas and the user sees the
    // picture change, so it is a paint. Reporting only decoded frames left
    // every cache-served scrub invisible to the instruments.
    if (diagnosticsEnabled) this.paints += 1;
    this.deps.onPaint(hit, undefined, presented);
    return true;
  }

  private start(): void {
    const tick = (): void => {
      if (this.disposed) return;
      const t = this.deps.clock.now();
      const playing = this.deps.clock.playing;
      this.runTick(t, playing);
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private runTick(t: number, playing: boolean): void {
    if (!this.sink) return;
    if (diagnosticsEnabled) this.ticks += 1;
    if (!playing) {
      // A reading away from where the transport stopped is a gesture
      // walking the playhead through a stop it made for itself. The engine
      // detaches the walk the same way for that stop and for a pause, so
      // this tick is the only place the two are told apart.
      if (this.stoppedAtS !== null && t !== this.stoppedAtS) {
        this.playSessionLive = true;
        this.stoppedAtS = null;
      }
      // Paused: paint a freshly-arrived frame from the most recent
      // seek exactly once. Cursor never advances on its own.
      const frame = this.nextFrame;
      if (!frame) return;
      this.paint(frame, t, false);
      this.nextFrame = null;
      return;
    }
    // End-of-source detection. mediabunny's iterator silently yields
    // done past EOF; without this check the playing branch keeps calling
    // cursor.next() forever and the engine never transitions out of
    // Playing status. cursor.track.durationS is set once at open().
    const durS = this.deps.cursor.track.durationS;
    if (!this.endedFired && durS > 0 && t >= durS) {
      this.endedFired = true;
      this.deps.onEnded();
      return;
    }
    if (this.reanchorParkedWalk(t)) return;
    this.catchUpBudget = this.catchUpAllowance(t);
    // Playing: paint at most one buffered frame per rAF, then pull the next.
    // The cursor's nextPending latch holds one pull in flight, so the pump is
    // self-healing -- paint-then-pull, or pull again when empty (below) -- and
    // that one-pull cap is what makes the empty-tick re-pull safe.
    const frame = this.playQueue[0] ?? null;
    if (!frame) {
      // A playing tick with nothing to paint is the pipeline out of buffered
      // output: a stall the user sees as a freeze. The opening buffering
      // window before the first paint is expected, not a stall.
      if (diagnosticsEnabled && this.paintedSincePlay) this.stalls += 1;
      this.observePresentCadence(t);
      // Re-prime the pump. beginPlay's single bootstrap pull can be lost --
      // bailing on an in-flight drainSeek, or aimed at an iterator a
      // scrub-during-play already swapped -- which otherwise freezes
      // playback for good. The nextPending latch caps work at one decode,
      // so re-pulling on every empty tick recovers without stacking.
      this.deps.cursor.next();
      return;
    }
    // Overtaken by a backward clock move: waiting for the clock to reach it
    // would hold the paint and the refill for the length of the jump. Drop
    // the buffer and refill from where the clock actually is.
    if (this.beyondPlayHorizon(frame, t)) {
      this.droppedFramesTotal += this.playQueue.length;
      if (diagnosticsEnabled) this.droppedFrames += this.playQueue.length;
      this.clearPlayQueue();
      this.deps.cursor.next();
      return;
    }
    this.dropFramesTheClockHasPassed(t);
    this.observePresentCadence(t);
    const due = this.playQueue[0];
    // Front frame not due yet: keep it queued (the buffer is running ahead of
    // the clock, which is exactly the cushion we want).
    if (due.timestampS > t) return;
    this.playQueue.shift();
    if (this.skipsForPresentCadence(t)) {
      if (due.kind === "sample") due.sample.close();
      this.droppedFramesTotal += 1;
      if (diagnosticsEnabled) this.droppedFrames += 1;
    } else {
      if (diagnosticsEnabled && t - due.timestampS > this.frameIntervalS()) {
        this.lateFrames += 1;
      }
      this.lastPresentTickS = t;
      this.paint(due, t, true);
    }
    // Refill toward the read-ahead depth so a slow decode does not starve the
    // next tick. Latched to one in-flight pull, so this never stacks decodes.
    if (this.playQueue.length < this.readAhead()) this.deps.cursor.next();
  }

  private paint(frame: ScrubFrame, t: number, playing: boolean): void {
    if (!this.sink) {
      // No sink to consume it, but we still own the sample's close.
      if (frame.kind === "sample") frame.sample.close();
      return;
    }
    const presented = this.sink.present(frame);
    this.lastPaintedMs = Math.round(frame.timestampS * 1000);
    this.lastPaintedQuality = frame.quality;
    // The controller owns the sample lifetime: once presented, the live
    // sample is done. Idempotent close means a teardown that also closes it
    // is safe. A VideoFrame taken out of the sample is a separate reference
    // with its own owner, so this close does not reach it.
    if (frame.kind === "sample") frame.sample.close();
    if (!diagnosticsEnabled) {
      this.deps.onPaint(frame, undefined, presented);
      return;
    }
    this.paints += 1;
    // How far the clock has run past the frame we just painted; the live
    // catch-up depth the realtime needle reads. Only meaningful while
    // playing: paused, clock.now() holds the seek target while the canvas
    // shows the landed frame, so the gap would read as a phantom lag.
    if (playing) {
      this.paintedSincePlay = true;
      this.catchUpMs = Math.max(0, Math.round(t * 1000) - this.lastPaintedMs);
    } else {
      this.catchUpMs = 0;
    }
    this.deps.onPaint(frame, playing ? this.catchUpMs : undefined, presented);
  }

  /** Frame interval in seconds; the source rate when known, else a 30fps
   *  fallback. Used to decide whether a playing frame painted late. */
  private frameIntervalS(): number {
    const fps = this.deps.cursor.track.nativeFps;
    return fps && fps > 0 ? 1 / fps : 1 / 30;
  }

  /** Realtime needles for the diagnostics snapshot. Plain reads; the worker
   *  broadcaster calls this synchronously. */
  getRealtimeStats(): RealtimeStats {
    return {
      ticks: this.ticks,
      paints: this.paints,
      lateFrames: this.lateFrames,
      stalls: this.stalls,
      catchUpMs: this.catchUpMs,
      playQueueDepth: this.playQueue.length,
      endedFired: this.endedFired,
      droppedFrames: this.droppedFrames,
      droppedFramesTotal: this.droppedFramesTotal,
    };
  }

  private stop(): void {
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }
}
