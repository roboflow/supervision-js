import {
  type AnySourceHandle,
  type DecodedFrame,
  type FrameProvider,
  openFrameProvider,
} from "./decode-source";
import type { FrameId } from "./frame-timeline";
import type { DecodeDimensions } from "./decode-resolution";
import {
  type ScrubCursor,
  ScrubCursorState,
  type ScrubFrame,
  type ScrubFrameListener,
  type ScrubTrackInfo,
} from "./scrub-cursor";
import {
  asSec,
  type Sec,
  WebVideoEngineError,
  WebVideoEngineErrorCode,
} from "./types";

/**
 * Uncached cursor seam: a thin latest-wins queue and play-mode forward iterator
 * over an opened decode source. This is the cacheStrategy "none" backend, kept
 * for consumers that do not want the scheduler's memory footprint.
 *
 * Random-access seeks ride the provider's getFrame(t), which does the keyframe
 * walk and GOP decode internally. Forward playback uses frames(start) as a
 * streaming iterator, alive only between attachPlay and detachPlay so a paused
 * cursor never holds a decoder pipeline open.
 *
 * On the canvas source it emits CanvasScrubFrame; on the zero-copy sample source
 * a fresh decode emits SampleScrubFrame, whose close the controller owns after
 * paint. With no cache this cursor never blits a sample, so every fresh sample
 * is handed straight to the consumer.
 *
 * Coalescing: seekTo/seekToKey overwrite pendingSeekTargetS; drainSeek processes
 * only the latest target after the in-flight one settles, so a burst of scrub
 * seeks collapses to the most recent.
 */
export class CanvasSinkScrubCursor implements ScrubCursor {
  private readonly provider: FrameProvider;
  private trackInfo: ScrubTrackInfo;
  private outputGeneration = 0;
  private readonly outputReads = new Set<Promise<unknown>>();
  private readonly disposeSource: () => Promise<void>;

  /**
   * Forward-playback iterator. Lives only between attachPlay and detachPlay so
   * a paused cursor never holds a decoder pipeline open.
   */
  private iterator: AsyncGenerator<DecodedFrame, void, unknown> | null = null;
  /**
   * Serializes next() calls. AsyncGenerator iterators are single-consumer;
   * without this chain a rAF tick racing a backup pull could double-advance
   * and emit duplicate frames.
   */
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

  constructor(source: AnySourceHandle) {
    this.provider = openFrameProvider(source);
    this.trackInfo = this.provider.track;
    this.disposeSource = () => this.provider.dispose();
  }

  get state(): ScrubCursorState {
    return this.currentState;
  }
  get track(): ScrubTrackInfo {
    return this.trackInfo;
  }
  get isIdle(): boolean {
    return (
      this.currentState === ScrubCursorState.Idle &&
      this.nextPending === 0 &&
      this.pendingSeekTargetS === null &&
      !this.seekDraining
    );
  }

  async resizeOutput({ width, height }: DecodeDimensions): Promise<boolean> {
    if (!this.provider.resizeOutput) {
      throw new WebVideoEngineError(
        WebVideoEngineErrorCode.PresentationMismatch,
        "this decode source cannot resize frame output in place",
      );
    }
    if (
      this.closed ||
      (width === this.trackInfo.decodeWidth &&
        height === this.trackInfo.decodeHeight)
    )
      return false;
    this.outputGeneration++;
    this.pendingSeekTargetS = null;
    const returning = this.iterator?.return();
    this.iterator = null;
    this.nextPending = 0;
    this.lastEmittedFrame = null;
    await Promise.allSettled([
      ...this.outputReads,
      ...(returning ? [returning] : []),
    ]);
    if (this.closed) return false;
    await this.provider.resizeOutput({ width, height });
    if (this.closed) return false;
    this.trackInfo = {
      ...this.trackInfo,
      decodeWidth: width,
      decodeHeight: height,
    };
    return true;
  }

  private trackOutputRead<T>(read: Promise<T>): Promise<T> {
    this.outputReads.add(read);
    void read.then(
      () => this.outputReads.delete(read),
      () => this.outputReads.delete(read),
    );
    return read;
  }

  async open(): Promise<void> {
    // Seed the first paint via the same random-access path used for every
    // seek. Cheaper than a one-shot iterator just for the seed. Seed at the
    // track's real first timestamp, not a hardcoded 0: a trimmed or offset
    // clip's first frame is not at the origin, so getFrame(0) would land
    // before the first sample and seed nothing.
    const seed = await this.provider.getFrame(this.trackInfo.firstTimestampS);
    if (this.closed) return;
    if (seed) this.emitFrame(seed);
    this.currentState = ScrubCursorState.Idle;
  }

  /** No cache to read; the scheduler is the caching backend. */
  peekCached(): ScrubFrame | null {
    return null;
  }

  /**
   * Decodes one named frame of the source and emits it.
   *
   * The retrieval is at-or-before a time the frame table produced, and the
   * demuxer normalises that back to the same integer tick it came from, so it
   * lands on that frame and no other. Nothing here walks, compares or skips,
   * so a step across a frame boundary needs no epsilon.
   */
  async seekToFrame(frame: FrameId): Promise<ScrubFrame | null> {
    if (this.closed) return null;
    const outputGeneration = this.outputGeneration;
    const decoded = await this.trackOutputRead(
      this.provider.getFrame(this.trackInfo.timeline.timeAt(frame.index)),
    );
    if (this.closed || outputGeneration !== this.outputGeneration || !decoded) {
      if (decoded?.kind === "sample") decoded.sample.close();
      return null;
    }
    this.emitFrame(decoded);
    return this.lastEmittedFrame;
  }

  seekTo(timestamp: Sec): void {
    this.pendingSeekTargetS = this.clampToOrigin(timestamp);
    this.pendingSeekKeyOnly = false;
    void this.drainSeek();
  }

  /**
   * getFrame(t) lands at or before t, which is the keyframe-or-earlier
   * semantics seekToKey implies. The emitted frame is marked as a keyframe
   * result via the keyOnly flag.
   */
  seekToKey(timestamp: Sec): void {
    this.pendingSeekTargetS = this.clampToOrigin(timestamp);
    this.pendingSeekKeyOnly = true;
    void this.drainSeek();
  }

  /** Floors a seek target to the track's first timestamp. A seek below the
   *  origin (an offset/trimmed clip) has no sample to land on, so it would
   *  emit nothing; clamping lands it on the first frame instead. */
  private clampToOrigin(timestamp: Sec): number {
    return Math.max(this.trackInfo.firstTimestampS, timestamp);
  }

  attachPlay(startS: number): void {
    if (this.closed) return;
    if (this.iterator) void this.trackOutputRead(this.iterator.return());
    this.iterator = this.provider.frames(startS);
  }

  detachPlay(): void {
    if (this.iterator) void this.trackOutputRead(this.iterator.return());
    this.iterator = null;
  }

  next(): void {
    // No-op while paused: pulling the iterator when none is attached would
    // silently advance media time across a paused canvas. The controller
    // calls next() only inside its playing branch.
    if (!this.iterator) return;
    // Cap at one outstanding pull so a slow decoder cannot accumulate a
    // backlog whose delayed burst overwrites the stash and drops frames.
    if (this.nextPending > 0) return;
    this.nextPending++;
    this.nextInFlight = this.nextInFlight
      .catch(() => undefined)
      .then(() => this.pullForwardOne())
      .finally(() => {
        this.nextPending--;
      });
  }

  idle(): Promise<void> {
    if (this.isIdle) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  seekSettled(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pendingSeekTargetS === null && !this.seekDraining)
      return Promise.resolve();
    return new Promise((resolve) => this.settleResolvers.push(resolve));
  }

  subscribe(listener: ScrubFrameListener): () => void {
    this.listeners.add(listener);
    // Replay the most recently emitted frame so a controller that wires up
    // after open() does not miss the seed frame.
    if (this.lastEmittedFrame) listener(this.lastEmittedFrame);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.outputReads.clear();
    this.pendingSeekTargetS = null;
    this.currentState = ScrubCursorState.Closed;
    this.listeners.clear();
    this.flushIdleResolvers();
    this.flushSettleResolvers();
    this.lastEmittedFrame = null;
    await this.iterator?.return();
    this.iterator = null;
    await this.disposeSource();
  }

  private async drainSeek(): Promise<void> {
    if (this.seekDraining || this.closed) return;
    this.seekDraining = true;
    try {
      while (this.pendingSeekTargetS !== null && !this.closed) {
        const t = this.pendingSeekTargetS;
        const keyOnly = this.pendingSeekKeyOnly;
        this.pendingSeekTargetS = null;
        await this.runSeek(asSec(t), keyOnly);
        this.flushSettleResolvers();
      }
    } finally {
      this.seekDraining = false;
      if (!this.closed) this.flushIdleResolvers();
      this.flushSettleResolvers();
    }
  }

  private async runSeek(t: Sec, keyOnly: boolean): Promise<void> {
    if (this.closed) return;
    const outputGeneration = this.outputGeneration;
    this.currentState = ScrubCursorState.Seeking;
    const frame = await this.trackOutputRead(this.provider.getFrame(t));
    if (this.closed || outputGeneration !== this.outputGeneration) {
      if (frame?.kind === "sample") frame.sample.close();
    } else if (frame) this.emitFrame(frame, keyOnly);
    if (!this.closed) this.currentState = ScrubCursorState.Idle;
  }

  private async pullForwardOne(): Promise<void> {
    const iterator = this.iterator;
    if (!iterator || this.closed) return;
    // Skip while a seek is in flight; the seek emits the settled frame and
    // otherwise we would race the iterator state.
    if (this.seekDraining) return;
    const next = (await this.trackOutputRead(iterator.next())).value ?? null;
    if (this.closed || iterator !== this.iterator || !next) {
      if (next?.kind === "sample") next.sample.close();
      return;
    }
    this.emitFrame(next);
  }

  private emitFrame(decoded: DecodedFrame, isKey = false): void {
    const frame: ScrubFrame =
      decoded.kind === "sample"
        ? {
            kind: "sample",
            sample: decoded.sample,
            timestampS: decoded.timestamp as Sec,
            width: this.trackInfo.decodeWidth,
            height: this.trackInfo.decodeHeight,
            isKeyFrame: isKey,
            quality: "exact",
          }
        : {
            kind: "canvas",
            source: decoded.canvas,
            timestampS: decoded.timestamp as Sec,
            width: this.trackInfo.decodeWidth,
            height: this.trackInfo.decodeHeight,
            isKeyFrame: isKey,
            quality: "exact",
          };
    this.lastEmittedFrame = frame;
    this.listeners.forEach((l) => l(frame));
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
