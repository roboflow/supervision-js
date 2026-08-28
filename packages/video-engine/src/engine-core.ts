import { type MediaClock, PerformanceMediaClock } from "./clock";
import { DIAGNOSTICS, FRAME_CACHE } from "./constants";
import { createScrubCursor } from "./create-scrub-cursor";
import { urlRequestInit } from "./decode-source";
import { nativeResolution } from "./decode-resolution";
import type { FrameId, FrameLanding, FrameTimeline } from "./frame-timeline";
import {
  type DiagnosticsSnapshot,
  type EngineDiagnostics,
  evaluateWarnings,
  PaintRateMeter,
  PresentedRateMeter,
  type Warning,
} from "./diagnostics";
import type { Rotation } from "./rotation";
import {
  frameRotation,
  type FrameQuality,
  type ScrubCursor,
  type ScrubFrame,
  ScrubCursorState,
  type SeekIntent,
} from "./scrub-cursor";
import { ScrubController, setDiagnosticsEnabled } from "./scrub-controller";
import {
  TraceRecorder,
  type TraceEvent,
  type EngineTrace,
} from "./trace-recorder";
import {
  createSourceResidency,
  type SourceResidency,
} from "./source-residency";
import {
  asSec,
  canvasBindingRefused,
  type EngineReadySnapshot,
  PlaybackStatus,
  type PresentationMode,
  resolvePlaybackRate,
  SourceKind,
  type VideoEngineError,
} from "./types";
import {
  type DiagnosticsEvent,
  type EngineLoadConfig,
  type MirrorEvent,
  type PresentedFrameEvent,
  serializeEngineError,
  type SerializedViewport,
} from "./worker-protocol";

/** A seek waiting on the crisp frame that says where its walk landed. */
interface AwaitedSeek {
  /** The frame the seek aimed at. The walk answers at or before it, so this
   *  is what separates that answer from a frame decoded for an earlier seek. */
  readonly target: FrameId;
  /** Whether the answer is the keyframe enclosing the target rather than a
   *  frame beside it. A key walk can land a whole GOP back, which is too far
   *  to recognise by position, so its answer is recognised by the keyframe
   *  flag the scheduler puts on exactly the frame it emits for one. */
  readonly keyOnly: boolean;
}

export interface EngineCoreOptions {
  /** Sink for broadcast state. The worker host serializes each event onto
   *  the state plane; tests collect them to assert transitions. */
  emit: (event: MirrorEvent) => void;
  /** Sink for the diagnostics broadcast (the non-mirror 'diag' arm). Optional:
   *  when absent the broadcaster has nowhere to post, so a consumer that never
   *  wires it pays nothing. The worker host wires it to the same postMessage. */
  emitDiagnostics?: (event: DiagnosticsEvent) => void;
  /** Sink for the pixel plane, which carries frames only in "frames"
   *  presentation mode. The VideoFrame is handed over on the transfer list, so
   *  a host wiring this to postMessage detaches the worker's reference by
   *  posting it. Unwired there is no receiver, so the core closes each frame
   *  instead of leaking it. */
  emitPresentedFrame?: (
    event: PresentedFrameEvent,
    transfer: Transferable[],
  ) => void;
  /** Clock seam. Defaults to the wall-clock PerformanceMediaClock; tests
   *  inject a fake so they can drive media time deterministically. */
  clock?: MediaClock;
}

/**
 * The engine, with every main-thread concern removed. Owns the clock, cursor,
 * and render controller; runs entirely inside the worker. It never touches the
 * DOM, a React store, the playhead, or the imperative handle.
 *
 * It speaks two languages. Broadcast state (time, frame index, status,
 * duration, seeking) leaves through the `emit` callback. Command results that
 * the main thread cannot predict (load metadata, the frame a step lands on)
 * are method return values the worker host correlates back to the caller.
 *
 * Time is emitted only while playing. Paused positions are owned by the main
 * thread (written optimistically on scrub, or applied from step's return), so
 * the core never emits a competing time that would yank a settled playhead.
 */
export class EngineCore {
  private readonly emit: (event: MirrorEvent) => void;
  private readonly emitDiagnostics: ((event: DiagnosticsEvent) => void) | null;
  private readonly emitPresentedFrame:
    ((event: PresentedFrameEvent, transfer: Transferable[]) => void) | null;
  private readonly clock: MediaClock;
  private cursor: ScrubCursor | null = null;
  private residency: SourceResidency | null = null;
  private controller: ScrubController | null = null;
  private canvas: OffscreenCanvas | null = null;
  private viewport: SerializedViewport | null = null;
  /** The box the host said it paints these frames into, kept from the load
   *  command. Under "frames" presentation nothing ever measures a canvas here,
   *  so this is the only display geometry the engine is ever given. */
  private displayBox: {
    cssWidth: number;
    cssHeight: number;
    devicePixelRatio: number;
  } | null = null;
  private metadata: EngineReadySnapshot | null = null;
  /**
   * The decoder failure the runtime has given up on, latched. Nothing the
   * transport is asked to do afterwards can decode a frame, so nothing it is
   * asked to do may report otherwise: a play() that answered "playing" over a
   * decoder that had already been condemned is how a source with one unusable
   * entry point read as healthy for the rest of the session.
   */
  private decodeFailure: VideoEngineError | null = null;
  private presentation: PresentationMode = "canvas";
  private durationMs = 0;
  private paintSeq = 0;
  private playing = false;
  /** The frame the last step landed on. A serialized burst resolves each
   *  step before its rAF paints, so getLastPaintedMs lags by one or more
   *  steps; basing the next step on the actual landing keeps every step in a
   *  burst advancing exactly one frame instead of re-stepping a stale base. */
  private lastStepLanded: FrameId | null = null;
  /** Where the current seek's walk actually landed, known once a crisp frame
   *  for it has painted. A requested time is not a frame time: it comes from a
   *  marker rail or a pointer, so it usually sits between two samples. Walking
   *  backward from it reaches the sample already on screen and the press reads
   *  as dead. Null until that crisp paint arrives, so a step pressed before it
   *  still falls back to the clock. */
  private seekLanded: FrameId | null = null;
  /** The seek still waiting on that paint, or null when none is. Every paint
   *  the engine makes runs through this latch, and the render loop paints one
   *  frame per animation frame from a stash a previous seek may have filled,
   *  so without the target on it any leftover frame answers for the seek in
   *  flight and publishes itself as the playhead. */
  private awaitedSeek: AwaitedSeek | null = null;
  /** Wall stamp of a seek being served by re-anchoring the playback walk, or
   *  null when no such seek is waiting on its crisp frame. */
  private playSeekStartedAtMs: number | null = null;
  private playSeeks = 0;
  private playSeekSamples = 0;
  private playSeekSumMs = 0;
  private playSeekMaxMs = 0;
  /** The frame the last paint put up, for the diagnostics screen readout. */
  private lastPaintedId: FrameId | null = null;
  /** Mirrors VideoEngine's interactive-seek latch: true when a drag paused a
   *  playing engine, so endInteractiveSeek knows to resume. */
  private resumeAfterInteractiveSeek = false;

  /** Worker-realm broadcast timer handle, or null when diagnostics are off. */
  private diagnosticsTimer: ReturnType<typeof setInterval> | null = null;
  /** Wall time the cursor was first seen draining a seek, or null while it is
   *  not. How long a state has lasted is a diagnostics question, so it is
   *  timed here rather than on the scheduler, whose clock is the seam tests
   *  drive latency measurements through. */
  private drainingSinceMs: number | null = null;
  private readonly paintRateMeter = new PaintRateMeter();
  private readonly presentedRateMeter = new PresentedRateMeter();
  /** Lazily allocated on traceArm, freed on disarm; zero memory off. */
  private traceRecorder: TraceRecorder | null = null;
  /** The last assembled trace, kept after disarm so a stopped capture stays
   *  downloadable until the next arm. Null while armed or never captured. */
  private stoppedTrace: EngineTrace | null = null;

  constructor(options: EngineCoreOptions) {
    this.emit = options.emit;
    this.emitDiagnostics = options.emitDiagnostics ?? null;
    this.emitPresentedFrame = options.emitPresentedFrame ?? null;
    this.clock = options.clock ?? new PerformanceMediaClock();
  }

  /**
   * Receives the transferred display canvas and its measured box. Stored
   * even when the controller does not exist yet (bindCanvas can arrive
   * before load) and bound as soon as load builds the controller. Passing
   * null tears the binding down and stops the render loop.
   */
  setCanvas(
    canvas: OffscreenCanvas | null,
    viewport?: SerializedViewport,
  ): void {
    if (canvas && this.presentation === "frames") throw canvasBindingRefused();
    this.canvas = canvas;
    if (viewport) this.viewport = viewport;
    this.controller?.bindCanvas(canvas);
  }

  async load(config: EngineLoadConfig): Promise<EngineReadySnapshot> {
    this.presentation = config.presentation ?? "canvas";
    this.displayBox =
      config.decodeStrategy?.kind === "displayBox"
        ? {
            cssWidth: config.decodeStrategy.boxWidth,
            cssHeight: config.decodeStrategy.boxHeight,
            devicePixelRatio: config.decodeStrategy.devicePixelRatio,
          }
        : null;
    // A canvas may arrive before load, so a bind that predates the mode can
    // only be judged here, where the mode first exists.
    if (this.canvas && this.presentation === "frames")
      throw canvasBindingRefused();
    // The verdict belongs to the source that earned it, not to the engine.
    this.decodeFailure = null;
    this.emitStatus(PlaybackStatus.Loading);
    this.residency =
      config.sourceResidency && config.source.kind === SourceKind.Url
        ? createSourceResidency({
            url: config.source.url,
            budgetBytes: config.sourceResidency.budgetBytes,
            requestInit: urlRequestInit(config.source.crossOrigin)?.requestInit,
          })
        : null;
    this.cursor = await createScrubCursor({
      source: config.source,
      sourceResidency: this.residency ?? undefined,
      urlSource: config.urlSource,
      decodeStrategy: config.decodeStrategy ?? nativeResolution(),
      viewport: this.viewport ?? { displayWidth: null, devicePixelRatio: 1 },
      prefer2d: config.prefer2d,
      cache:
        config.cacheStrategy === "none"
          ? null
          : {
              previewWidth: config.previewWidth ?? FRAME_CACHE.PREVIEW_WIDTH_PX,
              // Budgets omitted: resolveCacheBudgets sizes both tiers
              // from device memory and frame size. previewCapacity is
              // still honored as an explicit caller override.
              previewCapacity: config.previewCapacity,
            },
      onDecodeFailure: (error) => this.handleDecodeFailure(error),
    });
    const nativeFps = this.cursor.track.nativeFps;
    this.controller = new ScrubController({
      cursor: this.cursor,
      clock: this.clock,
      onPaint: (frame, catchUpMs, presented) =>
        this.onPaint(frame, catchUpMs, presented),
      onEnded: () => this.handleEnded(),
      cacheSkipNearMs: config.cacheSkipNearMs ?? FRAME_CACHE.SKIP_NEAR_MS,
      prefer2d: config.prefer2d,
      presentation: this.presentation,
    });
    if (this.canvas) this.controller.bindCanvas(this.canvas);
    this.durationMs = Math.max(
      0,
      Math.round(this.cursor.track.durationS * 1000),
    );
    this.metadata = {
      // Recorded here rather than where the caller passed it: the cursor above
      // has resolved, so the demuxer really was opened over this kind of
      // reader. toMediabunnySource maps the three kinds one for one and
      // substitutes nothing, so what opened is what was named.
      byteSource: config.source.kind,
      durationMs: this.durationMs,
      nativeFps:
        nativeFps === null
          ? null
          : (nativeFps as EngineReadySnapshot["nativeFps"]),
      naturalWidth: this.cursor.track.width,
      naturalHeight: this.cursor.track.height,
      firstTimestampMs: Math.max(
        0,
        Math.round(this.cursor.track.firstTimestampS * 1000),
      ),
      timeline: this.cursor.track.timeline.toData(),
      codec: null,
      // Reaching here means the open path's canDecode() check passed:
      // openInput throws VideoEngineError(DecodeUnsupported) before the
      // cursor is built when the codec is undecodable, so a resolved cursor
      // is decodable by construction.
      canDecode: true,
    };
    this.emit({ type: "duration", durationMs: this.durationMs });
    this.emitStatus(PlaybackStatus.Ready);
    if (config.sourceResidency?.prefetch) this.residency?.startWarming();
    return this.metadata;
  }

  play(): void {
    if (!this.cursor || !this.controller) return;
    if (this.decodeFailure) return this.republishFailure();
    // Resume-from-end: a play after the clock crossed duration would tick
    // straight to Ended. Snap back to 0 first.
    const durS = this.durationMs / 1000;
    if (durS > 0 && this.clock.now() >= durS) {
      const first = this.timeline().landingAt(0);
      this.clock.seek(first.mediaTimeS);
      this.emit({
        type: "playhead",
        frameId: first.frame,
        mediaTimeS: first.mediaTimeS,
      });
    }
    this.playing = true;
    // Playback advances the playhead, so a step after pausing must re-base on
    // wherever play left it, not the last manual step.
    this.lastStepLanded = null;
    this.forgetSeekLanding();
    this.clock.play();
    this.controller.beginPlay(this.clock.now());
    this.emitStatus(PlaybackStatus.Playing);
  }

  pause(): void {
    // A pause anyone asked for outranks the drag's own, so releasing the
    // drag has nothing left to resume.
    this.resumeAfterInteractiveSeek = false;
    this.playing = false;
    this.clock.pause();
    this.controller?.endPlay();
    if (this.decodeFailure) return this.republishFailure();
    this.emitStatus(PlaybackStatus.Paused);
  }

  togglePlayback(): void {
    // A drag holding the engine paused as a mechanic did not change what the
    // user chose, and their choice is what there is to toggle.
    if (this.playing || this.resumeAfterInteractiveSeek) this.pause();
    else this.play();
  }

  /**
   * Sets how fast media time runs against wall time. The clock re-anchors, so
   * a change mid-playback bends the slope without moving the playhead, and the
   * decode-ahead buffer keeps its frames: they are positions in media time,
   * which a rate change does not touch. Applied while paused it simply waits,
   * since a paused clock advances at no rate at all.
   *
   * Throws on a rate outside the supported forward range.
   */
  setPlaybackRate(rate: number): void {
    const next = resolvePlaybackRate(rate);
    if (next === this.clock.rate) return;
    this.clock.setRate(next);
    // A new slope makes every sample in the presented-rate window a
    // measurement of the old one.
    this.presentedRateMeter.reset();
    this.emit({ type: "rate", rate: next });
    this.pushTraceEvent({ type: "rate", rate: next });
  }

  getPlaybackRate(): number {
    return this.clock.rate;
  }

  /** Fire-and-forget seek onto a named frame. Emits no playhead: the main
   *  thread snapped the gesture and wrote it. Paints a cache preview, then
   *  walks the cursor. */
  scrub(frameIndex: number, intent: SeekIntent = "gesture"): void {
    if (!this.cursor) return;
    const target = this.timeline().landingAt(frameIndex);
    // A scrub moves the playhead off the last step, so the next step must
    // re-base on the scrub target, not the stale step landing.
    this.lastStepLanded = null;
    this.awaitSeekLanding(target.frame);
    this.clock.seek(target.mediaTimeS);
    this.controller?.tryPaintFromCache(target.mediaTimeS * 1000);
    if (!this.controller) return;
    if (this.playing) {
      this.reanchorPlayback(target.mediaTimeS);
      this.pushTraceEvent({
        type: "scrub",
        targetMs: target.mediaTimeS * 1000,
      });
      return;
    }
    this.emit({ type: "seeking", seeking: true });
    this.cursor.seekTo(asSec(target.mediaTimeS), intent);
    this.pushTraceEvent({ type: "scrub", targetMs: target.mediaTimeS * 1000 });
    void this.observeSeekIdle();
  }

  /** Moves a running playback walk to `tSec`. The clock is already there. */
  private reanchorPlayback(tSec: number): void {
    this.playSeeks += 1;
    this.playSeekStartedAtMs = performance.now();
    // The cache paint each seek path tries first can already have put the
    // crisp frame up, and then the wait is over before the walk restarts.
    if (!this.awaitedSeek) this.closePlaySeekWait();
    this.controller?.endPlay();
    this.controller?.beginPlay(tSec);
  }

  /** Closes the wait of a seek served by re-anchoring, at the crisp paint that
   *  ends it. A seek that walked the cursor leaves no stamp; the scheduler
   *  times those. Stopping the transport abandons the wait: its frame can
   *  still paint minutes later, and the idle time between is not a wait
   *  anyone had, so the seek keeps its count and loses its sample. */
  private closePlaySeekWait(): void {
    const startedAtMs = this.playSeekStartedAtMs;
    if (startedAtMs === null) return;
    this.playSeekStartedAtMs = null;
    if (!this.playing) return;
    const waitMs = performance.now() - startedAtMs;
    this.playSeekSamples += 1;
    this.playSeekSumMs += waitMs;
    if (waitMs > this.playSeekMaxMs) this.playSeekMaxMs = waitMs;
  }

  async commit(frameIndex: number): Promise<FrameLanding | null> {
    if (!this.cursor) return null;
    const target = this.timeline().landingAt(frameIndex);
    const tSec = target.mediaTimeS;
    this.lastStepLanded = null;
    this.awaitSeekLanding(target.frame);
    this.clock.seek(tSec);
    this.controller?.tryPaintFromCache(tSec * 1000);
    // While playing, moving the playhead means re-anchoring the playback
    // walk, exactly as scrub does. Seeking the cursor instead leaves the walk
    // where it was, so playback carries on from the old position and the seek
    // reads as ignored.
    if (this.playing && this.controller) {
      this.reanchorPlayback(tSec);
      this.pushTraceEvent({ type: "seek", targetMs: tSec * 1000 });
      return null;
    }
    this.emit({ type: "seeking", seeking: true });
    this.cursor.seekTo(asSec(tSec));
    await this.cursor.seekSettled();
    this.pushTraceEvent({
      type: "seek",
      targetMs: tSec * 1000,
      landedMs: this.controller?.getLastPaintedMs() ?? undefined,
    });
    this.emit({ type: "seeking", seeking: false });
    // A long GOP can end the walk on a different frame from the one aimed
    // at, and the crisp paint is what recorded which.
    const landed = this.landingOf(this.seekLanded);
    this.closeSeekLanding();
    return landed;
  }

  async seekToKey(timeMs: number): Promise<FrameLanding | null> {
    if (!this.cursor) return null;
    const tSec = timeMs / 1000;
    const timeline = this.timeline();
    const target = timeline.idAt(timeline.indexAtOrBefore(asSec(tSec)));
    this.lastStepLanded = null;
    // Playing, this seek re-anchors the playback walk rather than running a
    // key walk, and an ordinary walk answers beside the target.
    this.awaitSeekLanding(target, !this.playing);
    this.clock.seek(tSec);
    this.controller?.tryPaintFromCache(timeMs);
    if (this.playing && this.controller) {
      this.reanchorPlayback(tSec);
      this.pushTraceEvent({ type: "seek", targetMs: timeMs, keyOnly: true });
      return null;
    }
    this.emit({ type: "seeking", seeking: true });
    this.cursor.seekToKey(asSec(tSec));
    await this.cursor.seekSettled();
    this.pushTraceEvent({
      type: "seek",
      targetMs: timeMs,
      landedMs: this.controller?.getLastPaintedMs() ?? undefined,
      keyOnly: true,
    });
    this.emit({ type: "seeking", seeking: false });
    const landed = this.landingOf(this.seekLanded);
    this.closeSeekLanding();
    return landed;
  }

  /**
   * Moves one frame along the source in presentation order and returns where
   * it landed, or null at either end. Only the worker knows which frame a
   * decode produced, so the landing is the command's return value. The stepped
   * frame paints worker-side via the controller and emits a paint like any
   * other.
   */
  async step(direction: 1 | -1): Promise<FrameLanding | null> {
    if (!this.cursor || !this.controller) return null;
    const timeline = this.timeline();
    // Base a serialized burst on its own last landing, else on where the
    // last seek landed, else on the clock. The order matters: the clock
    // holds what was REQUESTED, so it is a frame only once snapped, while a
    // landing already is one.
    const base =
      this.lastStepLanded ??
      this.seekLanded ??
      timeline.idAt(timeline.indexAtOrBefore(this.clock.now()));
    const target = timeline.landingAt(base.index + direction);
    if (target.frame.index === base.index) return null;
    const next = await this.cursor.seekToFrame(target.frame);
    if (!next) return null;
    this.lastStepLanded = target.frame;
    this.clock.seek(target.mediaTimeS);
    this.pushTraceEvent({
      type: "seek",
      targetMs: timeline.timeAt(base.index) * 1000,
      landedMs: target.mediaTimeS * 1000,
    });
    return target;
  }

  /** Append a runtime event to the trace ring, stamped with worker-clock time
   *  since arm. Predicted-false and free when no trace is armed. */
  private pushTraceEvent(event: Omit<TraceEvent, "tMs">): void {
    const recorder = this.traceRecorder;
    if (!recorder) return;
    recorder.pushEvent({ ...event, tMs: recorder.elapsedMs() });
  }

  /** Broadcast a status transition and record it on the trace ring, so an
   *  exported trace shows the playback-state timeline alongside paints/seeks. */
  private emitStatus(
    status: PlaybackStatus,
    error: VideoEngineError | null = null,
  ): void {
    this.emit({
      type: "status",
      status,
      error: error ? serializeEngineError(error) : null,
    });
    this.pushTraceEvent({ type: "status", status });
  }

  /**
   * The decoder cannot decode this source, and nothing else was going to say
   * so: a stalled decoder keeps accepting commands and the clock keeps
   * running, so playback reads as healthy over a canvas that will never change
   * again. Stop the transport first, then report, so the status a consumer
   * sees and what the engine is doing agree.
   */
  private handleDecodeFailure(error: VideoEngineError): void {
    this.decodeFailure ??= error;
    this.playing = false;
    this.clock.pause();
    this.controller?.endPlay();
    this.republishFailure();
  }

  /** Says the failure again for whoever just asked the transport to move. A
   *  consumer that only listens for changes has already been told; one that
   *  reads the status after its own command has to find the same answer. */
  private republishFailure(): void {
    this.emitStatus(PlaybackStatus.Errored, this.decodeFailure);
  }

  beginInteractiveSeek(): void {
    if (this.resumeAfterInteractiveSeek) return;
    if (!this.playing) return;
    this.pause();
    this.resumeAfterInteractiveSeek = true;
  }

  endInteractiveSeek(): void {
    if (!this.resumeAfterInteractiveSeek) return;
    this.resumeAfterInteractiveSeek = false;
    this.play();
  }

  async dispose(): Promise<void> {
    this.playing = false;
    this.diagnosticsStop();
    // A capture still running is evidence someone asked for; keep it, marked
    // with what cut it short, so it survives to the final traceExport.
    if (this.traceRecorder) {
      this.traceRecorder.truncate(
        "engine disposed while the capture was armed",
      );
      this.stoppedTrace = this.traceRecorder.assemble();
    }
    this.traceRecorder = null;
    this.controller?.dispose();
    this.controller = null;
    await this.cursor?.close();
    this.cursor = null;
    this.residency?.dispose();
    this.residency = null;
    this.emitStatus(PlaybackStatus.Idle);
  }

  /** True only when the cursor exists and reports settled. Mirrors
   *  VideoEngine.isIdle for tests; the facade derives its own from state. */
  isIdle(): boolean {
    const cursor = this.cursor;
    if (!cursor) return true;
    if (cursor.state === ScrubCursorState.Closed) return false;
    return cursor.isIdle;
  }

  /** Engine diagnostics snapshot (renderer, track facts, scheduler stats), or
   *  null before load. The scheduler field is null on the uncached cursor. */
  getStats(): EngineDiagnostics | null {
    const cursor = this.cursor;
    if (!cursor) return null;
    return {
      renderer: this.controller?.rendererName() ?? null,
      track: {
        decodeWidth: cursor.track.decodeWidth,
        decodeHeight: cursor.track.decodeHeight,
        nativeFps: cursor.track.nativeFps,
        durationS: cursor.track.durationS,
      },
      scheduler: cursor.getStats?.() ?? null,
    };
  }

  private async observeSeekIdle(): Promise<void> {
    if (!this.cursor) return;
    await this.cursor.idle();
    this.emit({ type: "seeking", seeking: false });
  }

  private handleEnded(): void {
    this.playing = false;
    this.clock.pause();
    this.controller?.endPlay();
    if (this.decodeFailure) return this.republishFailure();
    this.emitStatus(PlaybackStatus.Ended);
  }

  private awaitSeekLanding(target: FrameId, keyOnly = false): void {
    this.seekLanded = null;
    this.awaitedSeek = { keyOnly, target };
    this.playSeekStartedAtMs = null;
  }

  private forgetSeekLanding(): void {
    this.seekLanded = null;
    this.awaitedSeek = null;
    this.playSeekStartedAtMs = null;
  }

  /** Releases the latch of a seek that has already answered its caller. The
   *  landing rode back on the return value, so a paint arriving after it would
   *  move the playhead to somewhere the caller was never told about. */
  private closeSeekLanding(): void {
    this.awaitedSeek = null;
  }

  /**
   * Whether this paint is the landing of the seek waiting on one.
   *
   * An exact walk answers at or before the frame it aimed at, and no further
   * back than the sample next to it, so the target falls inside the answering
   * frame's own span. That span is the whole test: a frame decoded for some
   * earlier position sits outside it however recently it was painted.
   */
  private answersAwaitedSeek(painted: FrameId, isKeyFrame: boolean): boolean {
    const awaited = this.awaitedSeek;
    if (!awaited) return false;
    if (painted.ticks > awaited.target.ticks) return false;
    if (awaited.keyOnly) return isKeyFrame;
    return awaited.target.ticks <= this.timeline().endTicksAt(painted.index);
  }

  /** The frame table of the loaded source. Reached only from paths that have
   *  already established a cursor, which is what carries it. */
  private timeline(): FrameTimeline {
    const cursor = this.cursor;
    if (!cursor) throw new Error("EngineCore: no source is loaded");
    return cursor.track.timeline;
  }

  private landingOf(frame: FrameId | null): FrameLanding | null {
    return frame === null ? null : this.timeline().landingAt(frame.index);
  }

  /**
   * Points the background walk at where the viewer is, as a byte offset. The
   * file's own byte layout is not exposed, so this reads position as a share of
   * duration: enough to order the walk outward from the playhead, and wrong by
   * at most the amount the bitrate varies.
   */
  private aimResidency(mediaMs: number): void {
    const residency = this.residency;
    if (!residency || this.durationMs <= 0) return;
    const totalBytes = residency.snapshot().totalBytes;
    if (totalBytes === null) return;
    residency.focusAt((mediaMs / this.durationMs) * totalBytes);
  }

  private onPaint(
    frame: ScrubFrame,
    catchUpMs?: number,
    presented?: VideoFrame | null,
  ): void {
    this.paintSeq += 1;
    const timeline = this.timeline();
    // The decoded timestamp has been through the microsecond plane; this is
    // the one place in the engine that turns it back into a frame, and every
    // position published downstream comes from the table, not from it.
    const landing = timeline.landingAt(
      timeline.indexOfDecoded(frame.timestampS),
    );
    const { frame: frameId, mediaTimeS } = landing;
    const mediaTimeMs = mediaTimeS * 1000;
    this.lastPaintedId = frameId;
    this.aimResidency(mediaTimeMs);
    // Only a crisp frame names where the walk landed. The coarse stand-in
    // that paints the instant a seek is issued can be a long way off.
    if (
      frame.quality === "exact" &&
      this.answersAwaitedSeek(frameId, frame.isKeyFrame)
    ) {
      this.seekLanded = frameId;
      this.awaitedSeek = null;
      this.closePlaySeekWait();
      // Paused paints normally never move the playhead, but the landing
      // of an awaited seek is the one paint that says where the request
      // really settled; without this the readout keeps the requested
      // time, which almost never falls on a sample.
      if (!this.clock.playing) {
        this.emit({ type: "playhead", frameId, mediaTimeS });
      }
    }
    // Position and quality ride every paint. A consumer that only learns a
    // paint happened cannot tell whether the picture matches the playhead,
    // nor a crisp frame from the coarse stand-in, which is the whole
    // question while scrubbing. The catch-up needle is still playing-only.
    this.emit({
      type: "frame",
      paintSeq: this.paintSeq,
      frameId,
      mediaTimeS,
      quality: frame.quality,
      ...(catchUpMs === undefined ? {} : { catchUpMs }),
    });
    if (presented)
      this.present(presented, landing, frame.quality, frameRotation(frame));
    // Append to the trace event ring only while armed (predicted-false when
    // disarmed), at the same paint point that already fires.
    this.traceRecorder?.pushEvent({
      type: "paint",
      tMs: this.traceRecorder.elapsedMs(),
      mediaTimeMs: Math.round(mediaTimeMs),
      paintSeq: this.paintSeq,
      frameIndex: frameId.index,
      catchUpMs,
      quality: frame.quality,
      // The clock holds what this paint was serving: the last commanded
      // target while paused, the running position while playing. Recorded
      // per paint so a trace can put every paint against its target
      // without a second clock.
      targetMs: Math.round(this.clock.now() * 1000),
    });
    // Two sources of truth gated by clock state. Playing: paint owns time.
    // Paused: the main thread owns it, so stay quiet.
    if (!this.clock.playing) return;
    this.emit({ type: "playhead", frameId, mediaTimeS });
  }

  /**
   * Posts one frame with the identity of the paint it came from, in the same
   * message. With no sink wired there is no receiver, so the frame is closed
   * here: the controller has already let go of it, and a frame left open pins
   * a decoder buffer.
   */
  private present(
    frame: VideoFrame,
    landing: FrameLanding,
    quality: FrameQuality,
    rotation: Rotation,
  ): void {
    const emit = this.emitPresentedFrame;
    if (!emit) {
      frame.close();
      return;
    }
    emit(
      {
        type: "presentedFrame",
        paintSeq: this.paintSeq,
        frameId: landing.frame,
        mediaTimeS: landing.mediaTimeS,
        mediaTimeMs: landing.mediaTimeS * 1000,
        quality,
        rotation,
        frame,
      },
      [frame],
    );
  }

  // -----------------------------------------------------------------------
  // Diagnostics plane: opt-in worker broadcast + on-demand trace.
  // -----------------------------------------------------------------------

  /**
   * Starts the worker-realm broadcast timer at hz (default BROADCAST_HZ) and
   * flips the controller's per-rAF counter gate on. Decode-independent: the
   * timer callback does synchronous reads plus one post, never an await and
   * never the sink, so it runs between event-loop tasks, not inside a decode.
   */
  diagnosticsStart(hz: number = DIAGNOSTICS.BROADCAST_HZ): void {
    setDiagnosticsEnabled(true);
    if (this.diagnosticsTimer !== null) clearInterval(this.diagnosticsTimer);
    const periodMs = 1000 / Math.max(1, hz);
    this.diagnosticsTimer = setInterval(
      () => this.broadcastDiagnostics(),
      periodMs,
    );
    // Fill the keyframe lane across the whole file once diagnostics are on.
    // Fire-and-forget and metadata-only (the decoder-less EncodedPacketSink),
    // so it never blocks this call nor contends with the foreground decode;
    // it runs only because diagnostics just started, never when they are off.
    void this.cursor?.ensureKeyframeIndex?.();
  }

  diagnosticsStop(): void {
    setDiagnosticsEnabled(false);
    if (this.diagnosticsTimer !== null) {
      clearInterval(this.diagnosticsTimer);
      this.diagnosticsTimer = null;
    }
  }

  /** Lazily allocate the trace rings and begin capturing. windowMs sizes the
   *  snapshot ring alone: the event ring is fed by paints and gestures at no
   *  fixed rate, so wall clock cannot size it. */
  traceArm(windowMs: number): void {
    this.traceRecorder = new TraceRecorder(
      this.traceEnvironment(),
      undefined,
      DIAGNOSTICS.TRACE_EVENT_CAP,
      snapshotCapForWindow(windowMs),
    );
    this.stoppedTrace = null;
  }

  /** Stop capturing and free the rings, but keep the assembled trace so it can
   *  still be exported. A record-then-stop-then-download flow would otherwise
   *  lose the capture, since stop used to null the recorder outright. */
  traceDisarm(): void {
    if (this.traceRecorder) this.stoppedTrace = this.traceRecorder.assemble();
    this.traceRecorder = null;
  }

  /** The current capture if still armed, else the last stopped capture. Non
   *  destructive so a download can be retried; a new arm clears the stopped one. */
  traceExport(): EngineTrace | null {
    return this.traceRecorder?.assemble() ?? this.stoppedTrace;
  }

  /**
   * Assembles ONE snapshot and posts it as the 'diag' event. When a trace is
   * armed, the SAME reference is ring-appended, so there is no second
   * serialization. Synchronous: reads current stats, never awaits, never paints.
   */
  private broadcastDiagnostics(): void {
    if (!this.emitDiagnostics) return;
    const snapshot = this.assembleSnapshot();
    this.emitDiagnostics({ type: "diag", snapshot });
    this.traceRecorder?.pushSnapshot(snapshot);
  }

  private assembleSnapshot(): DiagnosticsSnapshot {
    const base = this.getStats();
    const scheduler = base?.scheduler ?? null;
    const cache = scheduler?.cache ?? null;
    const realtimeRaw = this.controller?.getRealtimeStats() ?? {
      ticks: 0,
      paints: 0,
      lateFrames: 0,
      stalls: 0,
      catchUpMs: 0,
      playQueueDepth: 0,
      endedFired: false,
      droppedFrames: 0,
      droppedFramesTotal: 0,
    };
    const nativeFps = this.cursor?.track.nativeFps ?? null;

    const exactBytes = cache
      ? cache.exactSize * cache.exactFrameWidth * cache.exactFrameHeight * 4
      : 0;
    const previewBytes = cache
      ? cache.previewSize *
        cache.previewFrameWidth *
        cache.previewFrameHeight *
        4
      : 0;
    const exactBudgetBytes = cache?.exactBudgetBytes ?? 0;

    const decodeW = this.cursor?.track.decodeWidth ?? 0;
    const decodeH = this.cursor?.track.decodeHeight ?? 0;
    const nativeW = this.cursor?.track.width ?? null;
    const nativeH = this.cursor?.track.height ?? null;
    // The backing-store size equals the decode size by construction (the
    // controller forces it), so it cannot answer "decode vs display". The
    // real painted box is the measured CSS width scaled by device pixels.
    const displayCssWidth =
      this.viewport?.displayWidth ?? this.paintedBoxCssWidth(nativeW, nativeH);
    const dpr = this.devicePixelRatio();
    const boundW = this.canvas?.width ?? null;
    const boundH = this.canvas?.height ?? null;

    const downscaleRatio = nativeW && nativeW > 0 ? decodeW / nativeW : null;
    const decodeArea = decodeW * decodeH;
    // Square the painted physical width against the decode height so the
    // ratio compares physical pixels painted to physical pixels decoded.
    // Null when the display box is unmeasured, so the metric reads n/a
    // rather than a misleading 1.00.
    const paintedW =
      displayCssWidth !== null && dpr !== null ? displayCssWidth * dpr : null;
    const paintedArea = paintedW !== null ? paintedW * paintedW : null;
    const decodeVsDisplayAreaRatio =
      paintedArea && paintedArea > 0 ? decodeArea / paintedArea : null;

    const gop = scheduler?.gop ?? {
      count: 0,
      avgGopS: 0,
      maxGopS: 0,
      minGopS: 0,
      stddevS: 0,
      densityPerS: 0,
    };
    const fpsForWalk = nativeFps && nativeFps > 0 ? nativeFps : 30;
    const estimatedGopWalkDepthFrames = Math.round(gop.avgGopS * fpsForWalk);

    const scrub = scheduler?.scrub ?? null;
    const hits = cache ? cache.exactHits + cache.previewHits : 0;
    const lookups = cache ? hits + cache.misses : 0;
    const cacheHitRatePct = lookups > 0 ? (hits / lookups) * 100 : 0;

    const nowMs = performance.now();
    const playheadMs = this.cursor ? Math.round(this.clock.now() * 1000) : null;
    const paintedMs = this.controller?.getLastPaintedMs() ?? null;
    const screen =
      paintedMs === null || !this.controller || !this.lastPaintedId
        ? null
        : {
            frameId: this.lastPaintedId,
            mediaTimeMs: paintedMs,
            quality: this.controller.getLastPaintedQuality(),
          };

    const draining = scheduler?.drain.draining ?? false;
    if (!draining) this.drainingSinceMs = null;
    else this.drainingSinceMs ??= performance.now();
    const seekDrainingForMs =
      this.drainingSinceMs === null
        ? 0
        : performance.now() - this.drainingSinceMs;

    const snapshot: DiagnosticsSnapshot = {
      presentation: this.presentation,
      renderer: base?.renderer ?? null,
      track: base?.track ?? null,
      scheduler,
      realtime: {
        effectivePaintFps: this.paintRateMeter.sample(
          nowMs,
          realtimeRaw.paints,
          this.playing,
        ),
        catchUpMs: realtimeRaw.catchUpMs,
        lateFrames: realtimeRaw.lateFrames,
        stalls: realtimeRaw.stalls,
        ticks: realtimeRaw.ticks,
        paints: realtimeRaw.paints,
        playQueueDepth: realtimeRaw.playQueueDepth,
        droppedFrames: realtimeRaw.droppedFrames,
      },
      pipeline: {
        decodedFrames: scheduler?.decode.framesOut ?? null,
        paintedFrames: this.paintSeq,
        droppedFrames: realtimeRaw.droppedFramesTotal,
      },
      sourceResidency: this.residency?.snapshot() ?? null,
      cacheBytes: {
        exactBytes,
        previewBytes,
        exactBudgetBytes,
        exactBytesPct:
          exactBudgetBytes > 0 ? (exactBytes / exactBudgetBytes) * 100 : 0,
      },
      geometry: {
        nativeWidth: nativeW,
        nativeHeight: nativeH,
        decodeWidth: decodeW,
        decodeHeight: decodeH,
        downscaleRatio,
        decodeVsDisplayAreaRatio,
        boundCanvasWidth: boundW,
        boundCanvasHeight: boundH,
      },
      gop: {
        ...gop,
        distanceToNearestKeyframeS:
          playheadMs === null
            ? null
            : nearestKeyframeDistanceS(
                scheduler?.keyframesMs ?? [],
                playheadMs,
              ),
        estimatedGopWalkDepthFrames,
      },
      scrub: {
        samples: scrub?.samples ?? 0,
        avgMs: scrub?.avgMs ?? 0,
        maxMs: scrub?.maxMs ?? 0,
        p50Ms: scrub?.p50Ms ?? 0,
        p95Ms: scrub?.p95Ms ?? 0,
        targetVsLandedMs: scrub?.targetVsLandedMs ?? 0,
        timeToCrispMs: scrub?.timeToCrispMs ?? 0,
        cacheHitRatePct,
      },
      playSeek: {
        seeks: this.playSeeks,
        samples: this.playSeekSamples,
        avgMs:
          this.playSeekSamples > 0
            ? this.playSeekSumMs / this.playSeekSamples
            : 0,
        maxMs: this.playSeekMaxMs,
      },
      counters: {
        foregroundDecodes: scheduler?.decode.foreground ?? 0,
        prefetchExact: scheduler?.decode.prefetchExact ?? 0,
        prefetchPreview: scheduler?.decode.prefetchPreview ?? 0,
        keyframeAnchored: scheduler?.decode.keyframeAnchored ?? 0,
        exactSeeks: scheduler?.seek.exact ?? 0,
        keySeeks: scheduler?.seek.key ?? 0,
        seekCoalesceDepth: scheduler?.seek.coalesceDepth ?? 0,
        probeRoundTrips: scheduler?.probeRoundTrips ?? 0,
        prefetchInFlight: scheduler?.prefetchState.inFlight ?? false,
        prefetchGeneration: scheduler?.prefetchState.generation ?? 0,
        nextPending: scheduler?.decode.nextPending ?? 0,
        seekDrainingForMs,
      },
      memory: { jsHeapUsedBytes: null },
      nativeFps,
      rate: this.clock.rate,
      presentedRate: this.presentedRateMeter.sample(
        nowMs,
        paintedMs,
        this.playing,
      ),
      playheadMs,
      screen,
      status: this.statusString(),
      webgpuAvailable: false,
      warnings: [],
    };

    const warnings: Warning[] = evaluateWarnings(snapshot);
    return { ...snapshot, warnings };
  }

  private statusString(): string {
    if (!this.cursor) return PlaybackStatus.Idle;
    if (this.decodeFailure) return PlaybackStatus.Errored;
    return this.playing ? PlaybackStatus.Playing : PlaybackStatus.Paused;
  }

  /**
   * CSS width the picture occupies inside the box the host declared, native
   * aspect fitted into it, or null when no box was declared. A portrait source
   * in a landscape box paints far narrower than the box, so the fit is what the
   * ratio has to be measured against.
   */
  private paintedBoxCssWidth(
    nativeWidth: number | null,
    nativeHeight: number | null,
  ): number | null {
    const box = this.displayBox;
    if (!box || !(box.cssWidth > 0) || !(box.cssHeight > 0)) return null;
    if (!nativeWidth || !nativeHeight) return box.cssWidth;
    return (
      nativeWidth *
      Math.min(box.cssWidth / nativeWidth, box.cssHeight / nativeHeight)
    );
  }

  /** The ratio whichever side measured one reported, or null when neither did.
   *  The engine has no window of its own to read it off. */
  private devicePixelRatio(): number | null {
    return (
      this.viewport?.devicePixelRatio ??
      this.displayBox?.devicePixelRatio ??
      null
    );
  }

  private traceEnvironment(): {
    userAgent: string;
    webgpuAvailable: boolean;
    devicePixelRatio: number | null;
    hardwareConcurrency: number;
  } {
    const nav = (globalThis as { navigator?: Navigator }).navigator;
    return {
      userAgent: nav?.userAgent ?? "",
      webgpuAvailable:
        typeof (globalThis as { GPU?: unknown }).GPU !== "undefined",
      devicePixelRatio: this.devicePixelRatio(),
      hardwareConcurrency: nav?.hardwareConcurrency ?? 0,
    };
  }
}

function nearestKeyframeDistanceS(
  keyframesMs: readonly number[],
  playheadMs: number,
): number | null {
  let nearestMs: number | null = null;
  for (const keyframeMs of keyframesMs) {
    const distanceMs = Math.abs(keyframeMs - playheadMs);
    if (nearestMs === null || distanceMs < nearestMs) nearestMs = distanceMs;
  }
  return nearestMs === null ? null : nearestMs / 1000;
}

/** Snapshots needed to reach back windowMs at the broadcast rate, bounded by
 *  the ceiling that caps what an armed capture costs in memory. */
function snapshotCapForWindow(windowMs: number): number {
  const wanted = Math.round((windowMs / 1000) * DIAGNOSTICS.BROADCAST_HZ);
  return Math.min(DIAGNOSTICS.TRACE_SNAPSHOT_CAP, Math.max(1, wanted));
}
