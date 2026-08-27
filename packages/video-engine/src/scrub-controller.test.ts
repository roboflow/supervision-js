import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { MediaClock } from "./clock";
import {
  ScrubCursorState,
  type ScrubCursor,
  type ScrubFrame,
  type ScrubFrameListener,
} from "./scrub-cursor";
import { PLAYBACK } from "./constants";
import { FrameTimeline } from "./frame-timeline";
import { ScrubController, setDiagnosticsEnabled } from "./scrub-controller";
import { asSec } from "./types";

// The controller paints on animation frames, which the node environment lacks.
vi.stubGlobal(
  "requestAnimationFrame",
  (callback: FrameRequestCallback): number =>
    setTimeout(() => callback(0), 0) as unknown as number,
);
vi.stubGlobal("cancelAnimationFrame", (handle: number): void => {
  clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
});

class FakeClock implements MediaClock {
  private t = 0;
  private _playing = false;
  private _rate = 1;
  setT(t: number): void {
    this.t = t;
  }
  now(): number {
    return this.t;
  }
  play(t?: number): void {
    if (t !== undefined) this.t = t;
    this._playing = true;
  }
  pause(): void {
    this._playing = false;
  }
  seek(t: number): void {
    this.t = t;
  }
  get playing(): boolean {
    return this._playing;
  }
  get rate(): number {
    return this._rate;
  }
  setRate(rate: number): void {
    this._rate = rate;
  }
  reset(): void {
    this.t = 0;
    this._playing = false;
    this._rate = 1;
  }
}

class FakeCursor implements ScrubCursor {
  state = ScrubCursorState.Idle;
  track = {
    width: 320,
    height: 180,
    decodeWidth: 320,
    decodeHeight: 180,
    nativeFps: 30,
    durationS: asSec(5),
    firstTimestampS: asSec(0),
    timeline: FrameTimeline.uniform(30, 1000),
  };
  get isIdle(): boolean {
    return this.state === ScrubCursorState.Idle;
  }
  playReadAhead: number | undefined = undefined;
  nextCalls = 0;
  attachCalls = 0;
  detachCalls = 0;
  private listener: ScrubFrameListener | null = null;

  async open(): Promise<void> {}
  seekTo(): void {}
  seekToKey(): void {}
  next(): void {
    this.nextCalls++;
  }
  attachStarts: number[] = [];
  attachPlay(startS: number): void {
    this.attachCalls++;
    this.attachStarts.push(startS);
  }
  detachPlay(): void {
    this.detachCalls++;
  }
  async seekToFrame(): Promise<ScrubFrame | null> {
    return null;
  }

  async idle(): Promise<void> {}
  subscribe(listener: ScrubFrameListener): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
  peekCached(): ScrubFrame | null {
    return null;
  }
  async close(): Promise<void> {
    this.listener = null;
  }

  emit(frame: ScrubFrame): void {
    this.listener?.(frame);
  }
}

function makeCanvas(): OffscreenCanvas {
  const ctxStub = { clearRect: vi.fn(), drawImage: vi.fn() };
  return {
    width: 320,
    height: 180,
    getContext: () => ctxStub,
  } as unknown as OffscreenCanvas;
}

function flushRaf(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function canvasFrameAt(ts: number): ScrubFrame {
  return {
    kind: "canvas",
    timestampS: asSec(ts),
    source: makeCanvas(),
    width: 320,
    height: 180,
    isKeyFrame: false,
    quality: "exact",
  };
}

function sampleFrameAt(ts: number, onClose: () => void): ScrubFrame {
  return {
    kind: "sample",
    timestampS: asSec(ts),
    sample: {
      toVideoFrame: () => ({}) as VideoFrame,
      draw: () => undefined,
      close: onClose,
      timestamp: ts * 1e6,
      duration: 0,
    },
    width: 320,
    height: 180,
    isKeyFrame: false,
    quality: "exact",
  };
}

describe("ScrubController", () => {
  it("rAF tick paints stashed frame when paused", async () => {
    const cursor = new FakeCursor();
    const clock = new FakeClock();
    const onPaint = vi.fn();
    const controller = new ScrubController({
      cursor,
      clock,
      onPaint,
      onEnded: () => undefined,
      cacheSkipNearMs: 100,
    });
    controller.bindCanvas(makeCanvas());

    cursor.emit({
      kind: "canvas",
      timestampS: asSec(0.5),
      source: makeCanvas(),
      width: 320,
      height: 180,
      isKeyFrame: false,
      quality: "exact",
    });
    await flushRaf();

    expect(onPaint).toHaveBeenCalled();
    controller.dispose();
  });

  it("beginPlay attaches the cursor; endPlay detaches", () => {
    const cursor = new FakeCursor();
    const clock = new FakeClock();
    const controller = new ScrubController({
      cursor,
      clock,
      onPaint: () => undefined,
      onEnded: () => undefined,
      cacheSkipNearMs: 100,
    });
    controller.bindCanvas(makeCanvas());
    controller.beginPlay(0);
    expect(cursor.attachCalls).toBe(1);
    controller.endPlay();
    expect(cursor.detachCalls).toBe(1);
    controller.dispose();
  });

  it("self-priming pump: empty playing ticks keep pulling so a lost bootstrap pull recovers", async () => {
    const cursor = new FakeCursor();
    const clock = new FakeClock();
    const onPaint = vi.fn();
    const controller = new ScrubController({
      cursor,
      clock,
      onPaint,
      onEnded: () => undefined,
      cacheSkipNearMs: 100,
    });
    controller.bindCanvas(makeCanvas());
    controller.beginPlay(0);
    clock.play(0);
    // Model the freeze: the single bootstrap pull is lost (it bailed on an
    // in-flight drainSeek / a swapped iterator) so no frame ever lands from it.
    const afterBootstrap = cursor.nextCalls;
    for (let i = 0; i < 3; i++) await flushRaf();
    // Without self-priming nextCalls would be stuck at the bootstrap count and
    // playback would freeze forever; the pump must keep asking.
    expect(cursor.nextCalls).toBeGreaterThan(afterBootstrap);

    // And the moment a frame finally arrives, the next tick paints it.
    cursor.emit({
      kind: "canvas",
      timestampS: asSec(0),
      source: makeCanvas(),
      width: 320,
      height: 180,
      isKeyFrame: false,
      quality: "exact",
    });
    await flushRaf();
    expect(onPaint).toHaveBeenCalled();
    controller.dispose();
  });

  it("playing: decode-ahead queue paints buffered frames in order as each falls due", async () => {
    const cursor = new FakeCursor();
    const clock = new FakeClock();
    const painted: number[] = [];
    const controller = new ScrubController({
      cursor,
      clock,
      onPaint: (f) => painted.push(f.timestampS),
      onEnded: () => undefined,
      cacheSkipNearMs: 100,
    });
    controller.bindCanvas(makeCanvas());
    controller.beginPlay(0);
    clock.play(0);
    // Three frames arrive before any tick. The old single-slot stash would
    // overwrite down to the last; the queue must keep all three in order.
    cursor.emit(canvasFrameAt(0));
    cursor.emit(canvasFrameAt(0.01));
    cursor.emit(canvasFrameAt(0.02));
    await flushRaf();
    expect(painted).toEqual([0]);
    clock.setT(0.01);
    await flushRaf();
    expect(painted).toEqual([0, 0.01]);
    clock.setT(0.02);
    await flushRaf();
    expect(painted).toEqual([0, 0.01, 0.02]);
    controller.dispose();
  });

  it("playing: a tick presents the newest due frame and books the passed ones as dropped", async () => {
    setDiagnosticsEnabled(true);
    const cursor = new FakeCursor();
    const clock = new FakeClock();
    const painted: number[] = [];
    const controller = new ScrubController({
      cursor,
      clock,
      onPaint: (f) => painted.push(f.timestampS),
      onEnded: () => undefined,
      cacheSkipNearMs: 100,
    });
    controller.bindCanvas(makeCanvas());
    controller.beginPlay(0);
    clock.play(0);
    // Above display refresh over source fps, several frames fall due in the
    // same tick. Serving the oldest would leave the picture a tick further
    // behind the playhead every tick, so the tick has to skip to the newest.
    clock.setT(0.02);
    cursor.emit(canvasFrameAt(0));
    cursor.emit(canvasFrameAt(0.01));
    cursor.emit(canvasFrameAt(0.02));
    await flushRaf();

    expect(painted).toEqual([0.02]);
    expect(controller.getRealtimeStats().droppedFrames).toBe(2);
    expect(controller.getRealtimeStats().playQueueDepth).toBe(0);
    controller.dispose();
  });

  it("playing: skipping never runs past the clock into frames not yet due", async () => {
    const cursor = new FakeCursor();
    const clock = new FakeClock();
    const painted: number[] = [];
    const controller = new ScrubController({
      cursor,
      clock,
      onPaint: (f) => painted.push(f.timestampS),
      onEnded: () => undefined,
      cacheSkipNearMs: 100,
    });
    controller.bindCanvas(makeCanvas());
    controller.beginPlay(0);
    clock.play(0);
    clock.setT(0.01);
    cursor.emit(canvasFrameAt(0));
    cursor.emit(canvasFrameAt(0.01));
    cursor.emit(canvasFrameAt(0.02));
    await flushRaf();

    // 0.02 is still in the future: presenting it would show the user a frame
    // ahead of the playhead.
    expect(painted).toEqual([0.01]);
    expect(controller.getRealtimeStats().playQueueDepth).toBe(1);
    controller.dispose();
  });

  it("playing: an unpainted sample skipped by the clock is still closed", async () => {
    const cursor = new FakeCursor();
    const clock = new FakeClock();
    const controller = new ScrubController({
      cursor,
      clock,
      onPaint: () => undefined,
      onEnded: () => undefined,
      cacheSkipNearMs: 100,
    });
    controller.bindCanvas(makeCanvas());
    controller.beginPlay(0);
    clock.play(0);
    const closed: string[] = [];
    clock.setT(0.02);
    cursor.emit(sampleFrameAt(0, () => closed.push("skipped")));
    cursor.emit(sampleFrameAt(0.02, () => closed.push("painted")));
    await flushRaf();

    // Each sample pins a decoder slot, so one skipped past has to be released
    // exactly as a painted one is.
    expect(closed).toContain("skipped");
    controller.dispose();
  });

  it("playing: dropped sample frames are closed when the queue clears", () => {
    const cursor = new FakeCursor();
    const clock = new FakeClock();
    const controller = new ScrubController({
      cursor,
      clock,
      onPaint: () => undefined,
      onEnded: () => undefined,
      cacheSkipNearMs: 100,
    });
    controller.bindCanvas(makeCanvas());
    controller.beginPlay(0);
    clock.play(0);
    const closed: string[] = [];
    cursor.emit(sampleFrameAt(0.2, () => closed.push("a")));
    cursor.emit(sampleFrameAt(0.3, () => closed.push("b")));
    // Pausing drops the buffered play frames; both samples must be closed,
    // since each pins a decoder slot.
    controller.endPlay();
    expect(closed.sort()).toEqual(["a", "b"]);
    controller.dispose();
  });

  it("bindCanvas(null) stops the loop without leak", () => {
    const cursor = new FakeCursor();
    const clock = new FakeClock();
    const controller = new ScrubController({
      cursor,
      clock,
      onPaint: () => undefined,
      onEnded: () => undefined,
      cacheSkipNearMs: 100,
    });
    controller.bindCanvas(makeCanvas());
    controller.bindCanvas(null);
    controller.dispose();
  });

  describe("diagnostics gate", () => {
    afterEach(() => {
      // The gate is module-level; leave it off so other suites start clean.
      setDiagnosticsEnabled(false);
    });

    function makeFrame(timestampS: number): ScrubFrame {
      return {
        kind: "canvas",
        timestampS: asSec(timestampS),
        source: makeCanvas(),
        width: 320,
        height: 180,
        isKeyFrame: false,
        quality: "exact",
      };
    }

    it("OFF: no per-rAF counter advances across many ticks", async () => {
      setDiagnosticsEnabled(false);
      const cursor = new FakeCursor();
      const clock = new FakeClock();
      const controller = new ScrubController({
        cursor,
        clock,
        onPaint: () => undefined,
        onEnded: () => undefined,
        cacheSkipNearMs: 100,
      });
      controller.bindCanvas(makeCanvas());
      clock.play(0);
      cursor.emit(makeFrame(0));
      for (let i = 0; i < 5; i++) await flushRaf();

      const realtime = controller.getRealtimeStats();
      expect(realtime.ticks).toBe(0);
      expect(realtime.paints).toBe(0);
      expect(realtime.lateFrames).toBe(0);
      expect(realtime.stalls).toBe(0);
      expect(realtime.catchUpMs).toBe(0);
      controller.dispose();
    });

    it("ON: lateFrames increments for a frame more than one interval behind", async () => {
      setDiagnosticsEnabled(true);
      const cursor = new FakeCursor();
      const clock = new FakeClock();
      const controller = new ScrubController({
        cursor,
        clock,
        onPaint: () => undefined,
        onEnded: () => undefined,
        cacheSkipNearMs: 100,
      });
      controller.bindCanvas(makeCanvas());
      // Clock at 1s, frame timestamped at 0: a full second behind a 30fps
      // interval, so the paint is late.
      clock.play(0);
      clock.setT(1);
      cursor.emit(makeFrame(0));
      await flushRaf();

      expect(controller.getRealtimeStats().lateFrames).toBeGreaterThanOrEqual(
        1,
      );
      controller.dispose();
    });

    it("ON: stalls increments on a playing tick with no frame after first paint", async () => {
      setDiagnosticsEnabled(true);
      const cursor = new FakeCursor();
      const clock = new FakeClock();
      const controller = new ScrubController({
        cursor,
        clock,
        onPaint: () => undefined,
        onEnded: () => undefined,
        cacheSkipNearMs: 100,
      });
      controller.bindCanvas(makeCanvas());
      controller.beginPlay(0);
      clock.play(0);
      // First frame paints, leaving the opening buffering window.
      cursor.emit(makeFrame(0));
      await flushRaf();
      clock.setT(0.5);
      // No further frames: every later playing tick is a real stall.
      for (let i = 0; i < 3; i++) await flushRaf();

      expect(controller.getRealtimeStats().stalls).toBeGreaterThanOrEqual(1);
      controller.dispose();
    });

    it("ON: the buffering window before the first paint is not a stall", async () => {
      setDiagnosticsEnabled(true);
      const cursor = new FakeCursor();
      const clock = new FakeClock();
      const controller = new ScrubController({
        cursor,
        clock,
        onPaint: () => undefined,
        onEnded: () => undefined,
        cacheSkipNearMs: 100,
      });
      controller.bindCanvas(makeCanvas());
      controller.beginPlay(0);
      clock.play(0);
      clock.setT(0.5);
      // No frame yet: the bootstrap pull has not landed, so these ticks
      // are buffering, not stalls the user saw.
      for (let i = 0; i < 3; i++) await flushRaf();

      expect(controller.getRealtimeStats().stalls).toBe(0);
      controller.dispose();
    });

    it("ON: a new play session resets the realtime needles", async () => {
      setDiagnosticsEnabled(true);
      const cursor = new FakeCursor();
      const clock = new FakeClock();
      const controller = new ScrubController({
        cursor,
        clock,
        onPaint: () => undefined,
        onEnded: () => undefined,
        cacheSkipNearMs: 100,
      });
      controller.bindCanvas(makeCanvas());
      // First session accrues a stall after its first paint.
      controller.beginPlay(0);
      clock.play(0);
      cursor.emit(makeFrame(0));
      await flushRaf();
      clock.setT(0.5);
      for (let i = 0; i < 3; i++) await flushRaf();
      expect(controller.getRealtimeStats().stalls).toBeGreaterThanOrEqual(1);

      // Pause stops the clock before it detaches the walk, which is what
      // marks the session over.
      clock.pause();
      controller.endPlay();
      // A fresh play zeroes the cumulative needles rather than carrying the
      // prior session's stall forward into every later snapshot.
      controller.beginPlay(0);
      const after = controller.getRealtimeStats();
      expect(after.stalls).toBe(0);
      expect(after.lateFrames).toBe(0);
      expect(after.paints).toBe(0);
      expect(after.ticks).toBe(0);
      controller.dispose();
    });

    it("ON: a seek during playback keeps the session's needles", async () => {
      setDiagnosticsEnabled(true);
      const cursor = new FakeCursor();
      const clock = new FakeClock();
      const controller = new ScrubController({
        cursor,
        clock,
        onPaint: () => undefined,
        onEnded: () => undefined,
        cacheSkipNearMs: 100,
      });
      controller.bindCanvas(makeCanvas());
      controller.beginPlay(0);
      clock.play(0);
      cursor.emit(makeFrame(0));
      await flushRaf();
      clock.setT(0.5);
      for (let i = 0; i < 3; i++) await flushRaf();
      const before = controller.getRealtimeStats();
      expect(before.paints).toBeGreaterThanOrEqual(1);
      expect(before.stalls).toBeGreaterThanOrEqual(1);

      // What the engine does for a seek while playing: re-anchor the walk
      // with the clock never stopping. The user did not end their session,
      // so the counters they are watching must not go backwards.
      clock.seek(2.0);
      controller.endPlay();
      controller.beginPlay(2.0);

      const after = controller.getRealtimeStats();
      expect(after.paints).toBe(before.paints);
      expect(after.stalls).toBe(before.stalls);
      expect(after.ticks).toBeGreaterThanOrEqual(before.ticks);
      controller.dispose();
    });

    it("ON: a drag across the scrubber keeps the session's needles", async () => {
      setDiagnosticsEnabled(true);
      const cursor = new FakeCursor();
      const clock = new FakeClock();
      const controller = new ScrubController({
        cursor,
        clock,
        onPaint: () => undefined,
        onEnded: () => undefined,
        cacheSkipNearMs: 100,
      });
      controller.bindCanvas(makeCanvas());
      controller.beginPlay(0);
      clock.play(0);
      cursor.emit(makeFrame(0));
      await flushRaf();
      clock.setT(0.5);
      for (let i = 0; i < 3; i++) await flushRaf();
      const before = controller.getRealtimeStats();
      expect(before.paints).toBeGreaterThanOrEqual(1);
      expect(before.stalls).toBeGreaterThanOrEqual(1);

      // The shape a pointer drag produces: the engine stops the transport
      // for the whole gesture, every pointer move seeks the stopped clock,
      // and the release starts playback again wherever the pointer let go.
      clock.pause();
      controller.endPlay();
      for (const target of [1.0, 1.4, 1.9, 2.5]) {
        clock.seek(target);
        await flushRaf();
      }
      clock.play(2.5);
      controller.beginPlay(2.5);

      const after = controller.getRealtimeStats();
      expect(after.paints).toBe(before.paints);
      expect(after.stalls).toBe(before.stalls);
      controller.dispose();
    });

    it("ON: a pause the user sits in still resets the needles", async () => {
      setDiagnosticsEnabled(true);
      const cursor = new FakeCursor();
      const clock = new FakeClock();
      const controller = new ScrubController({
        cursor,
        clock,
        onPaint: () => undefined,
        onEnded: () => undefined,
        cacheSkipNearMs: 100,
      });
      controller.bindCanvas(makeCanvas());
      controller.beginPlay(0);
      clock.play(0);
      cursor.emit(makeFrame(0));
      await flushRaf();
      clock.setT(0.5);
      for (let i = 0; i < 3; i++) await flushRaf();
      expect(controller.getRealtimeStats().stalls).toBeGreaterThanOrEqual(1);

      // The same stopped transport and the same stopped ticks the drag
      // runs under, with nothing moving the playhead. Pausing for a clean
      // reading is the escape hatch the drag has to be told apart from.
      clock.pause();
      controller.endPlay();
      for (let i = 0; i < 4; i++) await flushRaf();
      clock.play(0.5);
      controller.beginPlay(0.5);

      const after = controller.getRealtimeStats();
      expect(after.stalls).toBe(0);
      expect(after.lateFrames).toBe(0);
      expect(after.paints).toBe(0);
      expect(after.ticks).toBe(0);
      controller.dispose();
    });

    it("playQueueDepth reflects the buffered decode-ahead frames (T5)", async () => {
      const cursor = new FakeCursor();
      const clock = new FakeClock();
      const controller = new ScrubController({
        cursor,
        clock,
        onPaint: () => undefined,
        onEnded: () => undefined,
        cacheSkipNearMs: 100,
      });
      controller.bindCanvas(makeCanvas());
      controller.beginPlay(0);
      clock.play(0);
      // Hold the clock behind every frame so none drain this turn; the queue
      // depth then equals the buffered count. One interval apart just ahead
      // of the playhead, which is the spacing the pull chain produces.
      clock.setT(0);
      cursor.emit(canvasFrameAt(0.033));
      cursor.emit(canvasFrameAt(0.066));
      cursor.emit(canvasFrameAt(0.1));
      expect(controller.getRealtimeStats().playQueueDepth).toBe(3);

      // Draining one (clock reaches the front frame) drops the depth by one.
      clock.setT(0.033);
      await flushRaf();
      expect(controller.getRealtimeStats().playQueueDepth).toBe(2);
      controller.dispose();
    });

    it("playQueueDepth is 0 while paused (no decode-ahead buffer)", () => {
      const cursor = new FakeCursor();
      const clock = new FakeClock();
      const controller = new ScrubController({
        cursor,
        clock,
        onPaint: () => undefined,
        onEnded: () => undefined,
        cacheSkipNearMs: 100,
      });
      controller.bindCanvas(makeCanvas());
      cursor.emit(canvasFrameAt(0.5));
      expect(controller.getRealtimeStats().playQueueDepth).toBe(0);
      controller.dispose();
    });

    it("ON: catchUpMs reflects clock-vs-last-painted and rides the onPaint payload", async () => {
      setDiagnosticsEnabled(true);
      const cursor = new FakeCursor();
      const clock = new FakeClock();
      const catchUps: Array<number | undefined> = [];
      const controller = new ScrubController({
        cursor,
        clock,
        onPaint: (_frame, catchUpMs) => catchUps.push(catchUpMs),
        onEnded: () => undefined,
        cacheSkipNearMs: 100,
      });
      controller.bindCanvas(makeCanvas());
      // Painting a 0s frame while the clock reads 0.2s: ~200ms catch-up.
      clock.play(0);
      clock.setT(0.2);
      cursor.emit(makeFrame(0));
      await flushRaf();

      expect(controller.getRealtimeStats().catchUpMs).toBeCloseTo(200, -1);
      expect(catchUps.at(-1)).toBeCloseTo(200, -1);
      controller.dispose();
    });
  });
});

/**
 * The controller receives every frame the cursor emits, so frames produced for
 * a position playback has left reach the play queue too. Queued at the head
 * they are never due, which stops the paint and the refill both.
 */
describe("ScrubController read-ahead depth", () => {
  it("buffers to the depth the decode path allows, not to the shape of the frame", async () => {
    const cursor = new FakeCursor();
    const clock = new FakeClock();
    const controller = new ScrubController({
      cursor,
      clock,
      onPaint: () => undefined,
      onEnded: () => undefined,
      cacheSkipNearMs: 100,
    });
    controller.bindCanvas(makeCanvas());
    controller.beginPlay(0);
    clock.play(0);
    await flushRaf();

    // The long-lived decode session hands out sample-carrying frames but owns
    // them, so it is not pool-bound. Reading the depth off the frame's shape
    // treated it as though it were, leaving the default path with a queue of
    // one and no cushion for a decode that overruns a frame interval.
    const pullsBefore = cursor.nextCalls;
    cursor.emit(sampleFrameAt(0.01, () => undefined));
    expect(cursor.nextCalls).toBeGreaterThan(pullsBefore);
    controller.dispose();
  });
});

/**
 * A rate whose media span per tick exceeds one source frame needs more than one
 * frame out of the source per tick. The read-ahead depth cannot supply it on a
 * path that holds a single frame, so the picture would run at tick rate over
 * source fps whatever rate was commanded.
 */
describe("ScrubController catch-up on a single-frame decode path", () => {
  const INTERVAL_S = 1 / 30;

  function poolBound(): {
    cursor: FakeCursor;
    clock: FakeClock;
    controller: ScrubController;
  } {
    const cursor = new FakeCursor();
    cursor.playReadAhead = 1;
    const clock = new FakeClock();
    const controller = new ScrubController({
      cursor,
      clock,
      onPaint: () => undefined,
      onEnded: () => undefined,
      cacheSkipNearMs: 100,
    });
    controller.bindCanvas(makeCanvas());
    return { cursor, clock, controller };
  }

  async function playTwoTicks(
    clock: FakeClock,
    controller: ScrubController,
    spanS: number,
  ): Promise<void> {
    controller.beginPlay(0);
    clock.play(0);
    await flushRaf();
    clock.setT(spanS);
    await flushRaf();
  }

  it("a frame the clock has already passed chains another pull", async () => {
    const { cursor, clock, controller } = poolBound();
    await playTwoTicks(clock, controller, INTERVAL_S * 2);

    const before = cursor.nextCalls;
    cursor.emit(canvasFrameAt(INTERVAL_S * 0.5));

    expect(cursor.nextCalls).toBe(before + 1);
    controller.dispose();
  });

  it("a frame the clock has yet to reach waits for its tick", async () => {
    const { cursor, clock, controller } = poolBound();
    await playTwoTicks(clock, controller, INTERVAL_S * 2);

    const before = cursor.nextCalls;
    cursor.emit(canvasFrameAt(INTERVAL_S * 3));

    expect(cursor.nextCalls).toBe(before);
    controller.dispose();
  });
});

/**
 * Nothing drives rAF while the tab is hidden, so the loop stops while the clock
 * keeps wall time. The tick that resumes therefore reads a clock that has moved
 * by the whole absence, and what it does with that backlog is the difference
 * between the picture landing on the playhead and the picture replaying every
 * frame of the absence at decode rate.
 */
describe("ScrubController resuming after a parked loop", () => {
  const INTERVAL_S = 1 / 30;

  function parked(): {
    cursor: FakeCursor;
    clock: FakeClock;
    controller: ScrubController;
  } {
    const cursor = new FakeCursor();
    cursor.playReadAhead = 1;
    cursor.track = { ...cursor.track, durationS: asSec(600) };
    const clock = new FakeClock();
    const controller = new ScrubController({
      cursor,
      clock,
      onPaint: () => undefined,
      onEnded: () => undefined,
      cacheSkipNearMs: 100,
    });
    controller.bindCanvas(makeCanvas());
    return { cursor, clock, controller };
  }

  async function playThenJump(
    clock: FakeClock,
    controller: ScrubController,
    toS: number,
  ): Promise<void> {
    controller.beginPlay(0);
    clock.play(0);
    await flushRaf();
    clock.setT(toS);
    await flushRaf();
  }

  it("the walk is anchored at the playhead", async () => {
    const { cursor, clock, controller } = parked();
    await playThenJump(clock, controller, 30);

    expect(cursor.attachStarts).toEqual([0, 30]);
    controller.dispose();
  });

  it("the gap costs one decode request, not one per frame it covered", async () => {
    const { cursor, clock, controller } = parked();
    await playThenJump(clock, controller, 30);

    // The frame the walk was on when the loop stopped. Chaining a pull from
    // it decodes the whole absence one frame at a time, and a run of decode
    // requests is also a run of chances to charge the decode watchdog for an
    // absence the decoder had nothing to do with.
    const afterReanchor = cursor.nextCalls;
    cursor.emit(canvasFrameAt(INTERVAL_S));

    expect(cursor.nextCalls).toBe(afterReanchor);
    controller.dispose();
  });

  it("frames decoded before the gap are dropped rather than replayed", async () => {
    const painted: number[] = [];
    const cursor = new FakeCursor();
    cursor.track = { ...cursor.track, durationS: asSec(600) };
    const clock = new FakeClock();
    const controller = new ScrubController({
      cursor,
      clock,
      onPaint: (frame) => painted.push(frame.timestampS),
      onEnded: () => undefined,
      cacheSkipNearMs: 100,
    });
    controller.bindCanvas(makeCanvas());
    controller.beginPlay(0);
    clock.play(0);
    await flushRaf();
    cursor.emit(canvasFrameAt(INTERVAL_S));
    cursor.emit(canvasFrameAt(INTERVAL_S * 2));

    clock.setT(30);
    await flushRaf();

    expect(painted).not.toContain(INTERVAL_S * 2);
    expect(controller.getRealtimeStats().playQueueDepth).toBe(0);
    controller.dispose();
  });

  it("a high playback rate is not read as a parked loop", async () => {
    const { cursor, clock, controller } = parked();
    controller.beginPlay(0);
    clock.play(0);
    clock.setRate(8);
    await flushRaf();
    const attachesBefore = cursor.attachCalls;
    // 100ms of wall time at 8x, which is 24 source frames of clock travel:
    // a backlog to work off, not an absence to seek past.
    clock.setT(0.8);
    await flushRaf();

    expect(cursor.attachCalls).toBe(attachesBefore);
    controller.dispose();
  });

  it("a tick the loop merely ran late for still walks its backlog", async () => {
    const { cursor, clock, controller } = parked();
    controller.beginPlay(0);
    clock.play(0);
    await flushRaf();
    const attachesBefore = cursor.attachCalls;
    clock.setT(0.4);
    await flushRaf();

    expect(cursor.attachCalls).toBe(attachesBefore);
    const before = cursor.nextCalls;
    cursor.emit(canvasFrameAt(0.1));
    expect(cursor.nextCalls).toBe(before + 1);
    controller.dispose();
  });
});

describe("ScrubController resuming after a starved walk", () => {
  const INTERVAL_S = 1 / 30;

  function starved(): {
    cursor: FakeCursor;
    clock: FakeClock;
    controller: ScrubController;
    painted: number[];
  } {
    const painted: number[] = [];
    const cursor = new FakeCursor();
    cursor.track = { ...cursor.track, durationS: asSec(600) };
    const clock = new FakeClock();
    const controller = new ScrubController({
      cursor,
      clock,
      onPaint: (frame) => painted.push(frame.timestampS),
      onEnded: () => undefined,
      cacheSkipNearMs: 100,
    });
    controller.bindCanvas(makeCanvas());
    return { cursor, clock, controller, painted };
  }

  /** The render loop keeps ticking through a wait on the network. A clock
   *  moved in one step reads as a parked loop, so this walks it forward one
   *  display interval per rendered frame. */
  async function runClock(
    clock: FakeClock,
    fromS: number,
    forS: number,
  ): Promise<void> {
    const stepS = 1 / 60;
    for (let elapsed = stepS; elapsed <= forS; elapsed += stepS) {
      clock.setT(fromS + elapsed);
      await flushRaf();
    }
  }

  /** A seek during playback: the walk re-attaches at the target and the clock
   *  runs on while the decode is still fetching. */
  async function waitOnSeek(
    clock: FakeClock,
    controller: ScrubController,
    targetS: number,
    waitS: number,
  ): Promise<void> {
    controller.beginPlay(targetS);
    clock.play(targetS);
    await flushRaf();
    await runClock(clock, targetS, waitS);
  }

  it("playback resumes at the frame the seek landed on", async () => {
    const { cursor, clock, controller } = starved();
    await waitOnSeek(clock, controller, 30, 2);

    cursor.emit(canvasFrameAt(30));

    expect(clock.now()).toBeCloseTo(30, 5);
    controller.dispose();
  });

  it("the frames the wait covered are played, not flashed past", async () => {
    const { cursor, clock, controller } = starved();
    await waitOnSeek(clock, controller, 30, 2);

    cursor.emit(canvasFrameAt(30));
    cursor.emit(canvasFrameAt(30 + INTERVAL_S));
    cursor.emit(canvasFrameAt(30 + INTERVAL_S * 2));

    expect(controller.getRealtimeStats().playQueueDepth).toBe(3);
    expect(controller.getRealtimeStats().droppedFramesTotal).toBe(0);
    controller.dispose();
  });

  it("a wait short enough to catch up leaves the clock where it is", async () => {
    const { cursor, clock, controller } = starved();
    await waitOnSeek(clock, controller, 30, 0.4);

    cursor.emit(canvasFrameAt(30));

    expect(clock.now()).toBeCloseTo(30.4, 5);
    controller.dispose();
  });

  it("a high playback rate is not read as a starved walk", async () => {
    const { cursor, clock, controller } = starved();
    controller.beginPlay(30);
    clock.play(30);
    clock.setRate(8);
    await flushRaf();
    // 400ms of wall time at 8x, which is 96 source frames of clock travel:
    // a backlog to work off, not a wait the viewer sat through.
    await runClock(clock, 30, 3.2);

    cursor.emit(canvasFrameAt(30));

    expect(clock.now()).toBeCloseTo(33.2, 5);
    controller.dispose();
  });

  it("a walk starved mid-playback resumes from where it ran dry", async () => {
    const { cursor, clock, controller } = starved();
    controller.beginPlay(30);
    clock.play(30);
    await flushRaf();
    cursor.emit(canvasFrameAt(30));
    await flushRaf();

    await runClock(clock, 30, 2);
    cursor.emit(canvasFrameAt(30 + INTERVAL_S));

    expect(clock.now()).toBeCloseTo(30 + INTERVAL_S, 5);
    controller.dispose();
  });

  it("a parked loop still seeks past the absence it woke from", async () => {
    const { cursor, clock, controller } = starved();
    controller.beginPlay(0);
    clock.play(0);
    await flushRaf();
    clock.setT(30);
    await flushRaf();

    // The walk re-attached at 30; the frame it produces there must not read
    // as a wait the viewer sat through and pull the clock back to 0.
    cursor.emit(canvasFrameAt(30));

    expect(clock.now()).toBeCloseTo(30, 5);
    controller.dispose();
  });
});

describe("ScrubController play queue provenance", () => {
  function playing(): {
    cursor: FakeCursor;
    clock: FakeClock;
    controller: ScrubController;
  } {
    const cursor = new FakeCursor();
    const clock = new FakeClock();
    const controller = new ScrubController({
      cursor,
      clock,
      onPaint: () => undefined,
      onEnded: () => undefined,
      cacheSkipNearMs: 100,
    });
    controller.bindCanvas(makeCanvas());
    return { cursor, clock, controller };
  }

  it("a seek still landing when playback resumes does not enter the play queue", async () => {
    const { cursor, clock, controller } = playing();
    // The drag released at 2.0 and playback resumed there, but the decode
    // the drag started was aimed at 20.0 and lands after the resume.
    controller.beginPlay(2.0);
    clock.play(2.0);
    cursor.emit(canvasFrameAt(20.0));
    await flushRaf();

    expect(controller.getRealtimeStats().playQueueDepth).toBe(0);
    // With nothing queued the empty-tick re-prime runs, so the pump keeps
    // asking for the frames it actually needs.
    expect(cursor.nextCalls).toBeGreaterThan(1);
    controller.dispose();
  });

  it("a buffered frame overtaken by a backward clock move is dropped, not waited on", async () => {
    const { cursor, clock, controller } = playing();
    controller.beginPlay(10.0);
    clock.play(10.0);
    cursor.emit(canvasFrameAt(10.033));
    cursor.emit(canvasFrameAt(10.066));
    await flushRaf();
    expect(controller.getRealtimeStats().playQueueDepth).toBe(2);

    // A frame step backward while playing seeks the clock under the buffer.
    clock.setT(9.5);
    const before = cursor.nextCalls;
    await flushRaf();

    expect(controller.getRealtimeStats().playQueueDepth).toBe(0);
    expect(cursor.nextCalls).toBeGreaterThan(before);
    controller.dispose();
  });

  it("the buffer playback legitimately runs ahead with is kept", async () => {
    const { cursor, clock, controller } = playing();
    controller.beginPlay(1.0);
    clock.play(1.0);
    cursor.emit(canvasFrameAt(1.033));
    cursor.emit(canvasFrameAt(1.066));
    cursor.emit(canvasFrameAt(1.1));
    await flushRaf();

    expect(controller.getRealtimeStats().playQueueDepth).toBe(3);
    controller.dispose();
  });
});

describe("ScrubController paint reporting", () => {
  function withCache(hit: ScrubFrame | null): {
    cursor: FakeCursor;
    clock: FakeClock;
    controller: ScrubController;
    painted: ScrubFrame[];
  } {
    const cursor = new FakeCursor();
    cursor.peekCached = (): ScrubFrame | null => hit;
    const clock = new FakeClock();
    const painted: ScrubFrame[] = [];
    const controller = new ScrubController({
      cursor,
      clock,
      onPaint: (f) => painted.push(f),
      onEnded: () => undefined,
      cacheSkipNearMs: 100,
    });
    controller.bindCanvas(makeCanvas());
    return { cursor, clock, controller, painted };
  }

  it("a cached frame further from the pointer than the one showing is not painted", async () => {
    setDiagnosticsEnabled(true);
    // Put 2.0 on screen first.
    const { cursor, controller } = withCache(canvasFrameAt(2.0));
    await flushRaf();
    expect(controller.tryPaintFromCache(2000)).toBe(true);

    // The drag moves forward to 2.1, and the nearest cached frame is 1.9: a
    // position it has already gone past. That is exactly 100ms from what is
    // showing, so it clears the skip-near test, but it is further from the
    // pointer than the frame already up, so painting it would move the
    // picture backwards while the drag goes forwards.
    cursor.peekCached = (): ScrubFrame | null => canvasFrameAt(1.9);
    expect(controller.tryPaintFromCache(2100)).toBe(false);
    setDiagnosticsEnabled(false);
    controller.dispose();
  });

  it("a frame served from the cache is reported like any other paint", async () => {
    setDiagnosticsEnabled(true);
    const hit = canvasFrameAt(4);
    const { controller, painted } = withCache(hit);
    await flushRaf();

    expect(controller.tryPaintFromCache(4000)).toBe(true);

    // The user saw the picture change, so the instruments have to agree.
    expect(painted).toEqual([hit]);
    expect(controller.getRealtimeStats().paints).toBe(1);
    setDiagnosticsEnabled(false);
    controller.dispose();
  });

  it("frames thrown away before the canvas are counted", async () => {
    setDiagnosticsEnabled(true);
    const { cursor, clock, controller } = withCache(null);
    controller.beginPlay(2.0);
    clock.play(2.0);

    // Arrived for a position the session had left.
    cursor.emit(canvasFrameAt(20.0));
    // Buffered legitimately, then overtaken by the clock moving backwards.
    cursor.emit(canvasFrameAt(2.033));
    await flushRaf();
    clock.setT(0.5);
    await flushRaf();

    expect(controller.getRealtimeStats().droppedFrames).toBe(2);
    setDiagnosticsEnabled(false);
    controller.dispose();
  });
});

/**
 * A cursor over a synthetic constant-rate source, answering each pull with the
 * next frame in presentation order on a microtask and holding the same
 * one-pull-in-flight ceiling the real scheduler does. Decode is free here, so a
 * run of ticks measures the pump and nothing else.
 */
class PumpCursor extends FakeCursor {
  private frameIndex = 0;
  private inFlight = 0;

  constructor(private readonly intervalS: number) {
    super();
    this.playReadAhead = 1;
  }

  attachPlay(startS: number): void {
    super.attachPlay(startS);
    this.frameIndex = Math.max(0, Math.floor(startS / this.intervalS));
  }

  next(): void {
    super.next();
    if (this.inFlight >= PLAYBACK.READ_AHEAD_CANVAS) return;
    this.inFlight += 1;
    void Promise.resolve().then(() => {
      this.inFlight -= 1;
      const at = this.frameIndex;
      this.frameIndex += 1;
      this.emit(canvasFrameAt(at * this.intervalS));
    });
  }
}

/**
 * What a commanded rate buys is the rate the PICTURE runs at, so the property
 * worth pinning is the slope of the painted timestamps against the clock, not
 * how many pulls the pump issued to get there. Above tick rate over source fps
 * a tick has to serve more than one source frame, and the read-ahead depth on
 * the single-frame decode path cannot supply it, so a pump that only refilled to
 * depth would hold the picture at tick rate whatever rate was asked for.
 */
describe("ScrubController presented rate on a single-frame decode path", () => {
  const INTERVAL_S = 1 / 30;
  const TICK_S = 1 / 60;
  const TICKS = 30;

  async function playAtRate(
    rate: number,
  ): Promise<{ painted: number[]; clockS: number }> {
    const cursor = new PumpCursor(INTERVAL_S);
    const clock = new FakeClock();
    const painted: number[] = [];
    const controller = new ScrubController({
      cursor,
      clock,
      onPaint: (frame) => painted.push(frame.timestampS),
      onEnded: () => undefined,
      cacheSkipNearMs: 100,
    });
    controller.bindCanvas(makeCanvas());
    clock.setRate(rate);
    controller.beginPlay(0);
    clock.play(0);
    let clockS = 0;
    for (let tick = 1; tick <= TICKS; tick++) {
      clockS = tick * TICK_S * rate;
      clock.setT(clockS);
      await flushRaf();
    }
    controller.dispose();
    return { painted, clockS };
  }

  it.each([1, 2, 8])(
    "the picture tracks %sx rather than the tick rate",
    async (rate) => {
      const { painted, clockS } = await playAtRate(rate);

      // Pinned at the tick rate the picture would reach TICKS * INTERVAL_S,
      // which at 8x is a quarter of where the clock is.
      expect(painted.length).toBeGreaterThan(1);
      expect(painted[painted.length - 1]).toBeGreaterThan(
        clockS - 8 * INTERVAL_S,
      );
      const span = painted[painted.length - 1] - painted[0];
      expect(span / clockS).toBeGreaterThan(0.9);
    },
  );

  it("the picture never runs ahead of the clock", async () => {
    const { painted, clockS } = await playAtRate(8);

    expect(Math.max(...painted)).toBeLessThanOrEqual(clockS);
    for (let i = 1; i < painted.length; i++) {
      expect(painted[i]).toBeGreaterThan(painted[i - 1]);
    }
  });
});

/**
 * A cursor over the same synthetic source given a fixed amount of work per wall
 * second, charging it for a decode and for a present alike, which is what the
 * worker thread is: the pump and the walk run on one thread, so a present the
 * machine cannot afford comes out of the next decode. Work it does not spend
 * stays on the books, so a machine with room delivers past what the clock asked
 * for and rebuilds the cushion, and one without falls further behind every tick.
 * Its capability is the run's to state, which is what lets one fixture stand for
 * a machine that copes and a machine that does not.
 */
class BudgetedPumpCursor extends FakeCursor {
  private frameIndex = 0;
  private inFlight = 0;
  private allowance = 0;

  constructor(
    private readonly intervalS: number,
    readAhead: number,
  ) {
    super();
    this.playReadAhead = readAhead;
  }

  /** Adds this tick's work to what earlier ticks left over. Takes a negative
   *  figure, so a tick whose presents cost more than it was given owes it. */
  fund(units: number): void {
    this.allowance += units;
  }

  attachPlay(startS: number): void {
    super.attachPlay(startS);
    this.frameIndex = Math.max(0, Math.floor(startS / this.intervalS));
  }

  next(): void {
    super.next();
    if (this.inFlight >= PLAYBACK.READ_AHEAD_CANVAS) return;
    if (this.allowance < 1) return;
    this.allowance -= 1;
    this.inFlight += 1;
    void Promise.resolve().then(() => {
      this.inFlight -= 1;
      const at = this.frameIndex;
      this.frameIndex += 1;
      this.emit(canvasFrameAt(at * this.intervalS));
    });
  }
}

/**
 * The pump paints at most one frame per tick of the worker's rAF, so a rate
 * asking for more frames a second than the panel refreshes at cannot show all of
 * them whatever it does. What the cadence decides is the rest: whether to
 * decline a frame it is holding and could paint. It decides on what the machine
 * is delivering against what the rate asks for, so a machine with room declines
 * nothing at any rate, and one that cannot afford the presents it is making
 * sheds them until it can.
 *
 * The panel is not an input to that, which is what the two-panel runs are for. A
 * faster panel offers more slots and a machine with the room fills them; what it
 * must not do is hold the engine above what the machine pays for.
 */
describe("ScrubController adaptive present cadence", () => {
  const INTERVAL_S = 1 / 30;
  const SOURCE_FPS = 30;

  interface Machine {
    readonly rate: number;
    readonly displayHz: number;
    readonly wallS: number;
    /** Frames a second this machine decodes when it presents nothing, as a
     *  figure or as one that changes over the run. */
    readonly decodesPerSecond: number | ((wallS: number) => number);
    /** Decodes one present costs it. */
    readonly presentCost: number;
    /** Decode-ahead depth the path it runs on keeps. */
    readonly readAhead: number;
  }

  interface Run {
    /** Wall second and media timestamp of every present, in order. */
    readonly painted: { wallS: number; timestampS: number }[];
    readonly droppedTotal: number;
    readonly wallS: number;
  }

  /** Several times the work any rate can ask of it, which is every machine the
   *  cadence has to leave alone. */
  const ROOMY = {
    decodesPerSecond: 900,
    presentCost: 1,
    readAhead: 3,
  } as const;
  /** One that cannot pay for the decodes 4x asks for and the presents a 120Hz
   *  panel offers at the same time: 180 units a second against 120 decodes and
   *  up to 120 presents. Its own capability is 60 presents a second, and
   *  shedding to it is the only way it holds the rate. */
  const STRAINED = {
    decodesPerSecond: 180,
    presentCost: 1,
    readAhead: 3,
  } as const;
  /** The same two machines on the zero-copy sample path, whose every queued
   *  frame pins a decoder slot, so it buffers one frame where the canvas path
   *  buffers three. The depth is the only difference between each pair, which
   *  is what makes the pair a reading of the cadence and not of the machine. */
  const ROOMY_SAMPLE = { ...ROOMY, readAhead: 1 } as const;
  const STRAINED_SAMPLE = { ...STRAINED, readAhead: 1 } as const;

  async function play(machine: Machine): Promise<Run> {
    const cursor = new BudgetedPumpCursor(INTERVAL_S, machine.readAhead);
    cursor.track = { ...cursor.track, durationS: asSec(6000) };
    const clock = new FakeClock();
    const painted: { wallS: number; timestampS: number }[] = [];
    let wallS = 0;
    const controller = new ScrubController({
      cursor,
      clock,
      onPaint: (frame) => painted.push({ wallS, timestampS: frame.timestampS }),
      onEnded: () => undefined,
      cacheSkipNearMs: 100,
    });
    controller.bindCanvas(makeCanvas());
    clock.setRate(machine.rate);
    controller.beginPlay(0);
    clock.play(0);
    const budgetAt =
      typeof machine.decodesPerSecond === "function"
        ? machine.decodesPerSecond
        : (): number => machine.decodesPerSecond as number;
    const ticks = Math.round(machine.displayHz * machine.wallS);
    let spent = 0;
    for (let tick = 1; tick <= ticks; tick++) {
      cursor.fund(budgetAt(wallS) / machine.displayHz - spent);
      wallS = tick / machine.displayHz;
      clock.setT(wallS * machine.rate);
      const before = painted.length;
      await flushRaf();
      spent = (painted.length - before) * machine.presentCost;
    }
    const { droppedFramesTotal } = controller.getRealtimeStats();
    controller.dispose();
    return { painted, droppedTotal: droppedFramesTotal, wallS };
  }

  /** Presents a second in each window of the run, in order. */
  function presentsPerSecondByWindow(run: Run, windowS: number): number[] {
    const windows = Math.floor(run.wallS / windowS);
    const counts = new Array<number>(windows).fill(0);
    for (const paint of run.painted) {
      const at = Math.floor(paint.wallS / windowS);
      if (at < windows) counts[at] += 1;
    }
    return counts.map((count) => count / windowS);
  }

  /** Media seconds of picture per wall second across a slice of the run. */
  function achievedRate(run: Run, from: number, to: number): number {
    return (
      (run.painted[to].timestampS - run.painted[from].timestampS) /
      (run.painted[to].wallS - run.painted[from].wallS)
    );
  }

  /** Each run is several hundred rAF turns, so they are made once and the
   *  tests read them. */
  const WINDOW_S = 0.5;
  let roomy60At4x: Run;
  let roomy120At4x: Run;
  let roomy120At8x: Run;
  let roomy120At1x: Run;
  let strained120: Run;
  let strained60: Run;
  let relieved120: Run;
  let starved120At1x: Run;
  let roomySample120At4x: Run;
  let strainedSample120: Run;
  let relievedSample120: Run;

  beforeAll(async () => {
    roomy60At4x = await play({ ...ROOMY, rate: 4, displayHz: 60, wallS: 1 });
    roomy120At4x = await play({ ...ROOMY, rate: 4, displayHz: 120, wallS: 1 });
    roomy120At8x = await play({ ...ROOMY, rate: 8, displayHz: 120, wallS: 1 });
    roomy120At1x = await play({ ...ROOMY, rate: 1, displayHz: 120, wallS: 1 });
    strained120 = await play({
      ...STRAINED,
      rate: 4,
      displayHz: 120,
      wallS: 3,
    });
    strained60 = await play({ ...STRAINED, rate: 4, displayHz: 60, wallS: 3 });
    relieved120 = await play({
      ...STRAINED,
      rate: 4,
      displayHz: 120,
      wallS: 6,
      decodesPerSecond: (wallS) => (wallS < 3 ? 180 : 900),
    });
    starved120At1x = await play({
      ...ROOMY,
      rate: 1,
      displayHz: 120,
      wallS: 1.5,
      decodesPerSecond: 12,
    });
    roomySample120At4x = await play({
      ...ROOMY_SAMPLE,
      rate: 4,
      displayHz: 120,
      wallS: 1,
    });
    strainedSample120 = await play({
      ...STRAINED_SAMPLE,
      rate: 4,
      displayHz: 120,
      wallS: 3,
    });
    relievedSample120 = await play({
      ...STRAINED_SAMPLE,
      rate: 4,
      displayHz: 120,
      wallS: 6,
      decodesPerSecond: (wallS) => (wallS < 3 ? 180 : 900),
    });
  }, 300_000);

  /**
   * 1x asks for exactly the source's frame rate, which is also the floor the
   * cadence never goes under, so there is no band left for it to shed into
   * however the machine is coping. Both runs paint the source's own frames in
   * order: the one with room, and one starved enough that the share is at the
   * bottom of its band by the end.
   */
  it("1x paints every frame of the source, coping or not", () => {
    for (const run of [roomy120At1x, starved120At1x]) {
      expect(run.droppedTotal).toBe(0);
      expect(run.painted.map((paint) => paint.timestampS)).toEqual(
        run.painted.map((_, index) => index * INTERVAL_S),
      );
    }
    expect(roomy120At1x.painted.length).toBeGreaterThanOrEqual(SOURCE_FPS);
    expect(starved120At1x.painted.length).toBeGreaterThan(8);
  });

  /**
   * No drops it does not need, at any rate. Both panels have the room for every
   * slot they offer, the fast one offers twice as many and fills them.
   *
   * At 4x on the 120Hz panel the rate asks for exactly the slots the panel has,
   * so a pipeline on the playhead leaves nothing for any of the three drop
   * paths to pick up, and a ledger this far under the present count is the tick
   * grid rather than a cadence declining every second frame.
   */
  it("a machine with room presents every frame the panel offers", () => {
    expect(roomy60At4x.painted.length).toBeGreaterThanOrEqual(58);
    expect(roomy120At4x.painted.length).toBeGreaterThanOrEqual(116);
    expect(roomy120At8x.painted.length).toBeGreaterThanOrEqual(116);
    expect(roomy120At4x.droppedTotal).toBeLessThan(
      roomy120At4x.painted.length / 10,
    );
  });

  /**
   * How far behind the machine is sets the pace: a shortfall moves the share a
   * quarter only once it has added up to a whole decode-ahead cushion, so the
   * present rate walks down rather than snapping, and it has to arrive
   * somewhere and stay. A rate that oscillates around a machine's limit is the
   * thing a steady lower rate exists to avoid, which is what the flatness of
   * the tail is for.
   */
  it("a machine that cannot afford its presents sheds them until it can", () => {
    const windows = presentsPerSecondByWindow(strained120, WINDOW_S);
    const settled = windows.slice(-3);

    expect(windows.length).toBeGreaterThanOrEqual(5);
    expect(windows[0]).toBeGreaterThan(Math.max(...settled));
    expect(Math.max(...settled) - Math.min(...settled)).toBeLessThanOrEqual(
      Math.max(...settled) * 0.05,
    );
    // Where it stops is this machine's own capability, not the bottom of the
    // band: 180 units a second less the 120 decodes 4x asks for leaves 60
    // presents, well clear of the source frame rate the share floors at.
    expect(Math.min(...settled)).toBeGreaterThan(SOURCE_FPS * 1.5);
    // Same rate, same panel, a machine with room: what the cadence reads is
    // the machine and not the rate.
    expect(roomy120At4x.painted.length / roomy120At4x.wallS).toBeGreaterThan(
      Math.max(...settled) * 1.5,
    );
  });

  /**
   * And it gives them back. The same machine, strained for three seconds and
   * then handed the work of one with room, returns to filling the panel: a
   * cadence that only ever came down would leave every machine at whatever its
   * worst stretch measured.
   */
  it("a machine that recovers gets its presents back", () => {
    const windows = presentsPerSecondByWindow(relieved120, WINDOW_S);
    const strainedTail = windows.slice(4, 6);
    const relievedTail = windows.slice(-2);

    expect(Math.max(...strainedTail)).toBeLessThanOrEqual(SOURCE_FPS * 2.5);
    expect(Math.min(...relievedTail)).toBeGreaterThan(
      Math.max(...strainedTail) * 1.5,
    );
  });

  /**
   * What the rate buys is the rate the picture runs at, and declining a present
   * must not cost any of it. Both strained runs hold the commanded rate across
   * the half where the cadence has shed hardest, and every frame they show is
   * one the clock had already reached, in order.
   */
  it("the picture keeps the commanded rate while the cadence sheds", () => {
    for (const run of [strained120, strained60]) {
      const half = Math.floor(run.painted.length / 2);
      const last = run.painted.length - 1;

      expect(achievedRate(run, half, last)).toBeGreaterThanOrEqual(4 * 0.95);
      expect(achievedRate(run, half, last)).toBeLessThanOrEqual(4 * 1.05);
      for (const paint of run.painted) {
        expect(paint.timestampS).toBeLessThanOrEqual(paint.wallS * 4);
      }
      for (let at = 1; at < run.painted.length; at++) {
        expect(run.painted[at].timestampS).toBeGreaterThan(
          run.painted[at - 1].timestampS,
        );
      }
    }
  });

  /**
   * Nothing in the decision knows what the panel refreshes at: the reading is
   * frames the walk delivered against frames the clock asked for, and the clock
   * runs the same on both. One machine therefore settles on one present rate on
   * either panel, and the faster one does not make it work harder to get there.
   */
  it("one machine settles on the same present rate on a 60Hz panel and a 120Hz one", () => {
    const settled = (run: Run): number => {
      const windows = presentsPerSecondByWindow(run, WINDOW_S).slice(-2);
      return windows.reduce((total, hz) => total + hz, 0) / windows.length;
    };

    expect(
      Math.abs(settled(strained120) - settled(strained60)),
    ).toBeLessThanOrEqual(settled(strained60) * 0.1);
  });

  /**
   * A declined frame cost a full decode, so a consumer reading the ledger can
   * see what the rate cost on this machine.
   */
  it("the frames the cadence declines reach the dropped-frame ledger", () => {
    expect(strained120.droppedTotal).toBeGreaterThan(0);
  });

  /**
   * The same machine and the same rate on the path that buffers one frame.
   * Everything the cadence reads has to mean the same thing at that depth: a
   * pipeline holding its single frame is one tick from empty, not one with
   * room to spare, and a machine whose evidence of strain is wiped by every
   * such tick sheds nothing and pays for the presents out of the picture.
   */
  it("a machine on the zero-copy path sheds the presents it cannot afford", () => {
    const windows = presentsPerSecondByWindow(strainedSample120, WINDOW_S);
    const settled = windows.slice(-3);

    expect(windows[0]).toBeGreaterThan(Math.max(...settled));
    expect(Math.max(...settled) - Math.min(...settled)).toBeLessThanOrEqual(
      Math.max(...settled) * 0.05,
    );
    expect(Math.min(...settled)).toBeGreaterThan(SOURCE_FPS * 1.5);
  });

  /**
   * And the rate the picture runs at survives the shedding there too, which is
   * what the shedding is for: a pump holding presents it cannot pay for buys
   * them out of the decodes the clock is waiting on, and the picture comes in
   * under the rate that was commanded.
   */
  it("the picture keeps the commanded rate on the zero-copy path", () => {
    const half = Math.floor(strainedSample120.painted.length / 2);
    const last = strainedSample120.painted.length - 1;

    expect(achievedRate(strainedSample120, half, last)).toBeGreaterThanOrEqual(
      4 * 0.95,
    );
    expect(achievedRate(strainedSample120, half, last)).toBeLessThanOrEqual(
      4 * 1.05,
    );
    for (const paint of strainedSample120.painted) {
      expect(paint.timestampS).toBeLessThanOrEqual(paint.wallS * 4);
    }
  });

  /** And it gives them back on that path, on the same evidence. */
  it("a machine on the zero-copy path gets its presents back", () => {
    const windows = presentsPerSecondByWindow(relievedSample120, WINDOW_S);
    const strainedTail = windows.slice(4, 6);
    const relievedTail = windows.slice(-2);

    expect(Math.max(...strainedTail)).toBeLessThanOrEqual(SOURCE_FPS * 2.5);
    expect(Math.min(...relievedTail)).toBeGreaterThan(
      Math.max(...strainedTail) * 1.5,
    );
  });

  /**
   * A single buffered frame is the most that path ever holds, so a cadence
   * reading depth alone would take the machine with room for its presents for
   * one that has none and shed on it.
   */
  it("a machine with room on the zero-copy path presents every frame the panel offers", () => {
    expect(roomySample120At4x.painted.length).toBeGreaterThanOrEqual(116);
  });
});

describe("ScrubController present cadence and a clock that moved", () => {
  it("a clock that jumped backwards paints without waiting out the jump", async () => {
    const cursor = new FakeCursor();
    cursor.track = { ...cursor.track, durationS: asSec(600) };
    const clock = new FakeClock();
    const painted: number[] = [];
    const controller = new ScrubController({
      cursor,
      clock,
      onPaint: (frame) => painted.push(frame.timestampS),
      onEnded: () => undefined,
      cacheSkipNearMs: 100,
    });
    controller.bindCanvas(makeCanvas());
    clock.setRate(4);
    controller.beginPlay(0);
    clock.play(0);
    for (let tick = 1; tick <= 8; tick++) {
      const t = (tick / 120) * 4;
      cursor.emit(canvasFrameAt(t));
      clock.setT(t);
      await flushRaf();
    }
    expect(painted.length).toBeGreaterThan(1);

    // A step during playback moves the clock under the pump, so the gap back
    // to the frame on screen is negative for as far as the step travelled.
    clock.setT(0.05);
    await flushRaf();
    cursor.emit(canvasFrameAt(0.05));
    await flushRaf();

    expect(painted[painted.length - 1]).toBe(0.05);
    controller.dispose();
  });
});
