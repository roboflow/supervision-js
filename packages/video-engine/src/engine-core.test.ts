import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { MediaClock } from "./clock";
import { DIAGNOSTICS } from "./constants";
import * as factoryModule from "./create-scrub-cursor";
import { EngineCore } from "./engine-core";
import { setDiagnosticsEnabled } from "./scrub-controller";
import {
  ScrubCursorState,
  type SchedulerStats,
  type ScrubFrame,
} from "./scrub-cursor";
import {
  asSec,
  PlaybackStatus,
  VideoEngineError,
  VideoEngineErrorCode,
} from "./types";
import type { DiagnosticsEvent, MirrorEvent } from "./worker-protocol";
import {
  type FakeCursor,
  FakeClock,
  FakeOffscreenCanvas,
  installWorkerGlobals,
  LOAD_CONFIG,
  makeFakeCursor,
  makeScrubFrame,
} from "../test/fake-engine-deps";

beforeAll(() => {
  installWorkerGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
  setDiagnosticsEnabled(false);
});

function setup(clock?: MediaClock): {
  engine: EngineCore;
  events: MirrorEvent[];
  diags: DiagnosticsEvent[];
  cursor: FakeCursor;
} {
  const cursor = makeFakeCursor();
  vi.spyOn(factoryModule, "createScrubCursor").mockResolvedValue(cursor);
  const events: MirrorEvent[] = [];
  const diags: DiagnosticsEvent[] = [];
  const engine = new EngineCore({
    emit: (event) => events.push(event),
    emitDiagnostics: (event) => diags.push(event),
    clock,
  });
  return { engine, events, diags, cursor };
}

function statusesOf(events: MirrorEvent[]): PlaybackStatus[] {
  return events.flatMap((event) =>
    event.type === "status" ? [event.status] : [],
  );
}

function seekingOf(events: MirrorEvent[]): boolean[] {
  return events.flatMap((event) =>
    event.type === "seeking" ? [event.seeking] : [],
  );
}

function hasPlayhead(events: MirrorEvent[]): boolean {
  return events.some((event) => event.type === "playhead");
}

/** Every published playhead position, in seconds. */
function playheadsOf(events: MirrorEvent[]): number[] {
  return events.flatMap((event) =>
    event.type === "playhead" ? [event.mediaTimeS] : [],
  );
}

/** The frame index for a media time on the fake cursor's 30fps table. */
const FRAME = (timeS: number): number => Math.round(timeS * 30);

function bindFakeCanvas(engine: EngineCore): void {
  engine.setCanvas(
    new FakeOffscreenCanvas(1280, 720) as unknown as OffscreenCanvas,
    {
      displayWidth: 1280,
      devicePixelRatio: 1,
    },
  );
}

function flushRaf(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/** Scheduler stats whose only live field is the discovered keyframe lane. */
function schedulerWithKeyframes(keyframesMs: number[]): SchedulerStats {
  return {
    mode: "idle",
    decodePath: "canvas",
    cache: {
      exactHits: 0,
      previewHits: 0,
      misses: 0,
      exactSize: 0,
      previewSize: 0,
      exactCapacity: 30,
      previewCapacity: 0,
      exactTimestampsMs: [],
      previewTimestampsMs: [],
      bucketMs: 33,
      exactEvictions: 0,
      previewEvictions: 0,
      bucketCollapses: 0,
      exactFrameWidth: 640,
      exactFrameHeight: 360,
      previewFrameWidth: 320,
      previewFrameHeight: 180,
      exactBudgetBytes: 0,
    },
    scrub: {
      samples: 0,
      lastMs: 0,
      avgMs: 0,
      maxMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      targetVsLandedMs: 0,
      timeToCrispMs: 0,
    },
    decode: {
      foreground: 0,
      prefetchExact: 0,
      prefetchPreview: 0,
      keyframeAnchored: 0,
      framesOut: 0,
      nextPending: 0,
    },
    seek: { exact: 0, key: 0, coalesceDepth: 0 },
    gop: {
      count: 0,
      avgGopS: 0,
      maxGopS: 0,
      minGopS: 0,
      stddevS: 0,
      densityPerS: 0,
    },
    probeRoundTrips: 0,
    keyframesMs,
    prefetch: null,
    prefetchState: { inFlight: false, generation: 0 },
    exactToleranceMs: 50,
    previewToleranceMs: 250,
    decoderDead: false,
    decoderStalled: false,
    drain: { draining: false, pendingTargetMs: null, recovering: false },
  };
}

describe("EngineCore", () => {
  it("load emits Loading then Ready, broadcasts duration, returns metadata", async () => {
    const { engine, events } = setup();
    const meta = await engine.load(LOAD_CONFIG);
    expect(meta.naturalWidth).toBe(1280);
    expect(meta.naturalHeight).toBe(720);
    expect(meta.durationMs).toBe(10000);
    expect(statusesOf(events)).toEqual([
      PlaybackStatus.Loading,
      PlaybackStatus.Ready,
    ]);
    expect(events).toContainEqual({ type: "duration", durationMs: 10000 });
    await engine.dispose();
  });

  it("play emits Playing; pause emits Paused", async () => {
    const clock = new FakeClock();
    const { engine, events } = setup(clock);
    await engine.load(LOAD_CONFIG);
    engine.play();
    expect(clock.playing).toBe(true);
    engine.pause();
    expect(clock.playing).toBe(false);
    expect(statusesOf(events)).toEqual([
      PlaybackStatus.Loading,
      PlaybackStatus.Ready,
      PlaybackStatus.Playing,
      PlaybackStatus.Paused,
    ]);
    await engine.dispose();
  });

  it("togglePlayback alternates between play and pause", async () => {
    const clock = new FakeClock();
    const { engine } = setup(clock);
    await engine.load(LOAD_CONFIG);
    engine.togglePlayback();
    expect(clock.playing).toBe(true);
    engine.togglePlayback();
    expect(clock.playing).toBe(false);
    await engine.dispose();
  });

  it("play past duration snaps the clock back to zero", async () => {
    const clock = new FakeClock();
    const { engine, events } = setup(clock);
    await engine.load(LOAD_CONFIG);
    clock.seek(10);
    engine.play();
    expect(clock.now()).toBe(0);
    expect(events).toContainEqual({
      type: "playhead",
      frameId: { index: 0, ticks: 0 },
      mediaTimeS: 0,
    });
    await engine.dispose();
  });

  it("scrub seeks the cursor and clock, flags seeking, never emits a playhead", async () => {
    const clock = new FakeClock();
    const { engine, events, cursor } = setup(clock);
    await engine.load(LOAD_CONFIG);
    engine.scrub(FRAME(1.5));
    expect(cursor.seekToCalls.at(-1)).toBeCloseTo(1.5);
    expect(clock.now()).toBeCloseTo(1.5);
    expect(events).toContainEqual({ type: "seeking", seeking: true });
    expect(hasPlayhead(events)).toBe(false);
    await engine.dispose();
  });

  it("scrub while playing re-anchors playback instead of seeking the cursor", async () => {
    const clock = new FakeClock();
    const { engine, cursor } = setup(clock);
    await engine.load(LOAD_CONFIG);
    engine.play();
    const seeksBefore = cursor.seekToCalls.length;
    engine.scrub(FRAME(1.5));
    expect(cursor.seekToCalls.length).toBe(seeksBefore);
    expect(cursor.detachPlayCalls).toBe(1);
    expect(cursor.attachPlayCalls).toBe(2);
    expect(clock.now()).toBeCloseTo(1.5);
    await engine.dispose();
  });

  it("commit awaits its seek, toggles seeking, seeks the cursor, never emits a playhead", async () => {
    const clock = new FakeClock();
    const { engine, events, cursor } = setup(clock);
    await engine.load(LOAD_CONFIG);
    await engine.commit(FRAME(2));
    expect(cursor.seekToCalls.at(-1)).toBeCloseTo(2);
    expect(clock.now()).toBeCloseTo(2);
    expect(seekingOf(events)).toEqual([true, false]);
    expect(hasPlayhead(events)).toBe(false);
    await engine.dispose();
  });

  it("commit while playing re-anchors playback instead of seeking the cursor", async () => {
    const clock = new FakeClock();
    const { engine, cursor } = setup(clock);
    await engine.load(LOAD_CONFIG);
    engine.play();
    const seeksBefore = cursor.seekToCalls.length;
    await engine.commit(FRAME(2));

    // Seeking the cursor here would leave the playback walk at its old
    // position, so playback would carry on from there and the commit would
    // read as ignored.
    expect(cursor.seekToCalls.length).toBe(seeksBefore);
    expect(cursor.attachPlayCalls).toBe(2);
    expect(clock.now()).toBeCloseTo(2);
    await engine.dispose();
  });

  it("seekToKey while playing re-anchors playback instead of seeking the cursor", async () => {
    const clock = new FakeClock();
    const { engine, cursor } = setup(clock);
    await engine.load(LOAD_CONFIG);
    engine.play();
    const keySeeksBefore = cursor.seekToKeyCalls.length;
    await engine.seekToKey(3000);

    expect(cursor.seekToKeyCalls.length).toBe(keySeeksBefore);
    expect(cursor.attachPlayCalls).toBe(2);
    expect(clock.now()).toBeCloseTo(3);
    await engine.dispose();
  });

  it("a seek while playing is counted and timed in its own ledger", async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const { engine, diags, cursor } = setup(clock);
    await engine.load(LOAD_CONFIG);
    bindFakeCanvas(engine);
    engine.play();
    const seeksBefore = cursor.seekToCalls.length;

    await engine.commit(FRAME(2));
    // The walk decodes for this long before its crisp frame reaches the
    // canvas.
    vi.advanceTimersByTime(50);
    cursor.emit(asSec(2));
    vi.advanceTimersByTime(20);

    engine.diagnosticsStart(10);
    vi.advanceTimersByTime(100);

    const { playSeek } = diags[0].snapshot;
    expect(playSeek.seeks).toBe(1);
    expect(playSeek.samples).toBe(1);
    expect(playSeek.avgMs).toBeGreaterThanOrEqual(50);
    expect(playSeek.avgMs).toBeLessThan(100);
    expect(playSeek.maxMs).toBe(playSeek.avgMs);
    // Nothing reached the cursor, so the scheduler's seek ledger and the
    // scrub timings it feeds cannot have counted this seek.
    expect(cursor.seekToCalls.length).toBe(seeksBefore);

    engine.diagnosticsStop();
    vi.useRealTimers();
    await engine.dispose();
  });

  it("a seek while playing the cache answers is timed at no wait", async () => {
    const clock = new FakeClock();
    const { engine, diags, cursor } = setup(clock);
    await engine.load(LOAD_CONFIG);
    bindFakeCanvas(engine);
    cursor.peekCached = (): ScrubFrame => makeScrubFrame(2);
    // The sink attaches asynchronously and nothing paints until it does;
    // this first paint is what proves it is up.
    cursor.emit(asSec(0));
    await flushRaf();

    vi.useFakeTimers();
    engine.play();
    await engine.commit(FRAME(2));

    engine.diagnosticsStart(10);
    vi.advanceTimersByTime(100);

    const { playSeek } = diags[0].snapshot;
    expect(playSeek.seeks).toBe(1);
    // A cache-answered seek waited zero, and zero is a wait, so it is a
    // sample like any other.
    expect(playSeek.samples).toBe(1);
    expect(playSeek.avgMs).toBe(0);

    engine.diagnosticsStop();
    vi.useRealTimers();
    await engine.dispose();
  });

  it("a seek while playing superseded before it lands is counted, not timed", async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const { engine, diags, cursor } = setup(clock);
    await engine.load(LOAD_CONFIG);
    bindFakeCanvas(engine);
    engine.play();

    await engine.commit(FRAME(2));
    await engine.commit(FRAME(4));
    cursor.emit(asSec(4));
    vi.advanceTimersByTime(20);

    engine.diagnosticsStart(10);
    vi.advanceTimersByTime(100);

    const { playSeek } = diags[0].snapshot;
    expect(playSeek.seeks).toBe(2);
    expect(playSeek.samples).toBe(1);

    engine.diagnosticsStop();
    vi.useRealTimers();
    await engine.dispose();
  });

  it("a cursor seek after one while playing is left to the scheduler to time", async () => {
    const clock = new FakeClock();
    const { engine, diags, cursor } = setup(clock);
    await engine.load(LOAD_CONFIG);
    bindFakeCanvas(engine);
    engine.play();

    await engine.commit(FRAME(2));
    engine.pause();
    await engine.commit(FRAME(4));
    cursor.emit(asSec(4));
    await flushRaf();

    vi.useFakeTimers();
    engine.diagnosticsStart(10);
    vi.advanceTimersByTime(100);

    const { playSeek } = diags[0].snapshot;
    expect(playSeek.seeks).toBe(1);
    // The landing that paints here is the paused seek's, and the scheduler
    // times that one.
    expect(playSeek.samples).toBe(0);

    engine.diagnosticsStop();
    vi.useRealTimers();
    await engine.dispose();
  });

  it("a seek while playing whose frame paints after a pause is counted, not timed", async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const { engine, diags, cursor } = setup(clock);
    await engine.load(LOAD_CONFIG);
    bindFakeCanvas(engine);
    engine.play();

    await engine.commit(FRAME(2));
    engine.pause();
    // The engine sits idle for this long between the seek and its frame.
    vi.advanceTimersByTime(5000);
    cursor.emit(asSec(2));
    vi.advanceTimersByTime(20);

    engine.diagnosticsStart(10);
    vi.advanceTimersByTime(100);

    const { playSeek, screen } = diags[0].snapshot;
    // The crisp frame really did reach the canvas, which is what makes the
    // empty ledger evidence of the abandoned wait.
    expect(screen?.quality).toBe("exact");
    expect(playSeek.seeks).toBe(1);
    expect(playSeek.samples).toBe(0);
    expect(playSeek.avgMs).toBe(0);
    expect(playSeek.maxMs).toBe(0);

    engine.diagnosticsStop();
    vi.useRealTimers();
    await engine.dispose();
  });

  it("seekToKey lands on the key sample and toggles seeking", async () => {
    const { engine, events, cursor } = setup();
    await engine.load(LOAD_CONFIG);
    await engine.seekToKey(3000);
    expect(cursor.seekToKeyCalls.at(-1)).toBeCloseTo(3);
    expect(seekingOf(events)).toEqual([true, false]);
    await engine.dispose();
  });

  it("step returns the frame it landed on, which the main thread cannot predict", async () => {
    const clock = new FakeClock();
    const { engine, cursor } = setup(clock);
    await engine.load(LOAD_CONFIG);
    clock.seek(1.2);
    const landed = await engine.step(1);
    expect(landed).toEqual({
      frame: { index: 37, ticks: 37000 },
      mediaTimeS: 37 / 30,
    });
    expect(cursor.seekToFrameCalls.at(-1)).toEqual({ index: 37, ticks: 37000 });
    expect(clock.now()).toBe(37 / 30);
    await engine.dispose();
  });

  it("step returns null at a source boundary", async () => {
    const clock = new FakeClock();
    const { engine } = setup(clock);
    await engine.load(LOAD_CONFIG);
    expect(await engine.step(-1)).toBeNull();
    // Past the last frame of the fake's 1000-frame table.
    clock.seek(35);
    expect(await engine.step(1)).toBeNull();
    await engine.dispose();
  });

  it("a burst of steps walks one frame each, forward and back to where it began", async () => {
    const clock = new FakeClock();
    const { engine, cursor } = setup(clock);
    await engine.load(LOAD_CONFIG);

    const forward: number[] = [];
    for (let i = 0; i < 40; i++)
      forward.push((await engine.step(1))?.frame.index ?? -1);
    expect(forward).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));

    const back: number[] = [];
    for (let i = 0; i < 40; i++)
      back.push((await engine.step(-1))?.frame.index ?? -1);
    expect(back).toEqual(Array.from({ length: 40 }, (_, i) => 39 - i));
    expect(cursor.seekToFrameCalls.at(-1)).toEqual({ index: 0, ticks: 0 });
    await engine.dispose();
  });

  it("a scrub re-bases the next step off the scrub target, not the stale step", async () => {
    const clock = new FakeClock();
    const { engine } = setup(clock);
    await engine.load(LOAD_CONFIG);

    await engine.step(1);
    // A scrub moves the playhead; the next step must start from there.
    engine.scrub(FRAME(5));
    expect((await engine.step(1))?.frame.index).toBe(FRAME(5) + 1);
    await engine.dispose();
  });

  it("the crisp landing of a paused seek corrects the playhead", async () => {
    const { engine, events, cursor } = setup();
    await engine.load(LOAD_CONFIG);
    bindFakeCanvas(engine);

    engine.scrub(FRAME(5));
    const before = playheadsOf(events).length;
    cursor.emit(asSec(4.967), "preview");
    await flushRaf();
    expect(playheadsOf(events).length).toBe(before);
    cursor.emit(asSec(4.967));
    await flushRaf();
    // 4.967s is not a frame of a 30fps source; the frame covering it is.
    expect(playheadsOf(events).at(-1)).toBe(149 / 30);
  });

  it("a step after a seek walks from the frame the seek landed on", async () => {
    const clock = new FakeClock();
    const { engine, cursor } = setup(clock);
    await engine.load(LOAD_CONFIG);
    bindFakeCanvas(engine);

    // A marker or a pointer names a time between two samples, and the walk
    // lands on the sample at or before it. Stepping back from the requested
    // frame would re-decode the sample already on screen.
    engine.scrub(FRAME(5));
    cursor.emit(asSec(4.967));
    await flushRaf();

    expect((await engine.step(-1))?.frame.index).toBe(148);
    await engine.dispose();
  });

  it("the coarse stand-in painted at seek time is not taken for the landing", async () => {
    const clock = new FakeClock();
    const { engine, cursor } = setup(clock);
    await engine.load(LOAD_CONFIG);
    bindFakeCanvas(engine);

    engine.scrub(FRAME(5));
    cursor.emit(asSec(2.5), "preview");
    await flushRaf();

    expect((await engine.step(-1))?.frame.index).toBe(FRAME(5) - 1);
    await engine.dispose();
  });

  it("paint emits a frame always but a playhead only while playing", async () => {
    const clock = new FakeClock();
    const { engine, events, cursor } = setup(clock);
    await engine.load(LOAD_CONFIG);
    bindFakeCanvas(engine);

    // Paused: a freshly-seeked frame paints, but the main thread owns the
    // paused position, so the core must stay quiet on time.
    cursor.emit(asSec(0.5));
    await flushRaf();
    expect(events.some((event) => event.type === "frame")).toBe(true);
    expect(hasPlayhead(events)).toBe(false);

    // Playing: paint owns the playhead.
    engine.play();
    cursor.emit(asSec(0));
    await flushRaf();
    expect(hasPlayhead(events)).toBe(true);

    await engine.dispose();
  });

  it("interactive seek pauses a playing engine and resumes on release", async () => {
    const clock = new FakeClock();
    const { engine } = setup(clock);
    await engine.load(LOAD_CONFIG);
    engine.play();
    engine.beginInteractiveSeek();
    expect(clock.playing).toBe(false);
    engine.endInteractiveSeek();
    expect(clock.playing).toBe(true);
    await engine.dispose();
  });

  it("a pause during the drag is the one the release leaves standing", async () => {
    const clock = new FakeClock();
    const { engine } = setup(clock);
    await engine.load(LOAD_CONFIG);
    engine.play();
    engine.beginInteractiveSeek();
    engine.pause();
    engine.endInteractiveSeek();
    expect(clock.playing).toBe(false);
    await engine.dispose();
  });

  it("a toggle during the drag pauses the playback the drag interrupted", async () => {
    const clock = new FakeClock();
    const { engine } = setup(clock);
    await engine.load(LOAD_CONFIG);
    engine.play();
    engine.beginInteractiveSeek();
    engine.togglePlayback();
    expect(clock.playing).toBe(false);
    engine.endInteractiveSeek();
    expect(clock.playing).toBe(false);
    await engine.dispose();
  });

  it("a drag started after a pause has nothing to resume", async () => {
    const clock = new FakeClock();
    const { engine } = setup(clock);
    await engine.load(LOAD_CONFIG);
    engine.play();
    engine.beginInteractiveSeek();
    engine.pause();
    engine.endInteractiveSeek();

    engine.beginInteractiveSeek();
    engine.endInteractiveSeek();
    expect(clock.playing).toBe(false);
    await engine.dispose();
  });

  it("interactive seek on a paused engine is a no-op", async () => {
    const clock = new FakeClock();
    const { engine } = setup(clock);
    await engine.load(LOAD_CONFIG);
    engine.beginInteractiveSeek();
    engine.endInteractiveSeek();
    expect(clock.playing).toBe(false);
    await engine.dispose();
  });

  it("dispose closes the cursor and emits Idle", async () => {
    const { engine, events, cursor } = setup();
    await engine.load(LOAD_CONFIG);
    await engine.dispose();
    expect(cursor.closed).toBe(true);
    expect(statusesOf(events).at(-1)).toBe(PlaybackStatus.Idle);
  });

  it("isIdle is false once the cursor is closed", async () => {
    const { engine, cursor } = setup();
    expect(engine.isIdle()).toBe(true);
    await engine.load(LOAD_CONFIG);
    expect(engine.isIdle()).toBe(true);
    cursor.state = ScrubCursorState.Closed;
    expect(engine.isIdle()).toBe(false);
    await engine.dispose();
  });

  it("getStats reports a snapshot after load; scheduler null on the uncached fake cursor", async () => {
    const { engine } = setup();
    expect(engine.getStats()).toBeNull();
    await engine.load(LOAD_CONFIG);
    const stats = engine.getStats();
    expect(stats?.scheduler).toBeNull();
    expect(stats?.track?.decodeWidth).toBe(1280);
    await engine.dispose();
  });

  it("a decoder that cannot decode stops playback and broadcasts the error", async () => {
    const clock = new FakeClock();
    const cursor = makeFakeCursor();
    const decode: { reportFailure?: (error: VideoEngineError) => void } = {};
    vi.spyOn(factoryModule, "createScrubCursor").mockImplementation(
      async (options) => {
        decode.reportFailure = options.onDecodeFailure;
        return cursor;
      },
    );
    const events: MirrorEvent[] = [];
    const engine = new EngineCore({
      emit: (event) => events.push(event),
      clock,
    });
    await engine.load(LOAD_CONFIG);
    engine.play();
    expect(clock.playing).toBe(true);

    decode.reportFailure?.(
      new VideoEngineError(
        VideoEngineErrorCode.DecoderStalled,
        "the decoder never started",
      ),
    );

    // Playing over a canvas that will never change again is the state this
    // exists to end, so the clock has to stop with the status.
    expect(clock.playing).toBe(false);
    expect(statusesOf(events).at(-1)).toBe(PlaybackStatus.Errored);
    const errored = events.at(-1);
    expect(errored?.type === "status" && errored.error).toEqual({
      code: VideoEngineErrorCode.DecoderStalled,
      message: "the decoder never started",
    });
    await engine.dispose();
  });

  describe("diagnostics broadcast", () => {
    it("diagnosticsStart posts a diag snapshot at the requested cadence", async () => {
      vi.useFakeTimers();
      const { engine, diags } = setup();
      await engine.load(LOAD_CONFIG);
      engine.diagnosticsStart(10);
      expect(diags).toHaveLength(0);

      vi.advanceTimersByTime(300);
      // 10Hz = one post per 100ms.
      expect(diags.length).toBeGreaterThanOrEqual(3);
      expect(diags[0].type).toBe("diag");

      engine.diagnosticsStop();
      const after = diags.length;
      vi.advanceTimersByTime(300);
      expect(diags.length).toBe(after);

      vi.useRealTimers();
      await engine.dispose();
    });

    it("the snapshot carries derived fields and worker-assembled warnings", async () => {
      vi.useFakeTimers();
      const { engine, diags } = setup();
      await engine.load(LOAD_CONFIG);
      engine.diagnosticsStart(10);
      vi.advanceTimersByTime(100);

      const { snapshot } = diags[0];
      expect(snapshot.geometry.decodeWidth).toBe(1280);
      // The fake cursor has no native fps stat path, but the fake track does
      // report 30; downscaleRatio derives from native/decode.
      expect(snapshot.geometry.downscaleRatio).not.toBeNull();
      expect(Array.isArray(snapshot.warnings)).toBe(true);
      expect(snapshot.nativeFps).toBe(30);

      engine.diagnosticsStop();
      vi.useRealTimers();
      await engine.dispose();
    });

    it("the snapshot carries the pipeline ledger and the one-clock fields", async () => {
      vi.useFakeTimers();
      const { engine, diags } = setup();
      await engine.load(LOAD_CONFIG);
      engine.diagnosticsStart(10);
      vi.advanceTimersByTime(100);

      const { snapshot } = diags[0];
      // Uncached fake cursor: the decode path cannot report, so decoded
      // reads null (n/a), never a lying zero.
      expect(snapshot.pipeline).toEqual({
        decodedFrames: null,
        paintedFrames: 0,
        droppedFrames: 0,
      });
      expect(snapshot.playheadMs).toBe(0);
      // Nothing painted yet, so nothing is claimed to be on screen.
      expect(snapshot.screen).toBeNull();
      // Paused: a painted rate is not a live truth, so the series says so.
      expect(snapshot.realtime.effectivePaintFps).toBeNull();

      engine.diagnosticsStop();
      vi.useRealTimers();
      await engine.dispose();
    });

    it("decodeVsDisplay is null when the display box is unmeasured", async () => {
      vi.useFakeTimers();
      const { engine, diags } = setup();
      await engine.load(LOAD_CONFIG);
      // No setCanvas with a viewport, so displayWidth stays null and the
      // ratio must read n/a rather than a misleading 1.00.
      engine.diagnosticsStart(10);
      vi.advanceTimersByTime(100);

      expect(diags[0].snapshot.geometry.decodeVsDisplayAreaRatio).toBeNull();

      engine.diagnosticsStop();
      vi.useRealTimers();
      await engine.dispose();
    });

    it("decodeVsDisplay uses the real display box, not the backing store", async () => {
      vi.useFakeTimers();
      const { engine, diags } = setup();
      await engine.load(LOAD_CONFIG);
      // Decode is 1280x720 (the fake track). A 320 CSS-px box at dpr 2 paints
      // a 640px-wide physical area, so decode dwarfs display even though the
      // backing store equals the decode size by construction.
      engine.setCanvas(
        new FakeOffscreenCanvas(1280, 720) as unknown as OffscreenCanvas,
        {
          displayWidth: 320,
          devicePixelRatio: 2,
        },
      );
      engine.diagnosticsStart(10);
      vi.advanceTimersByTime(100);

      const ratio = diags[0].snapshot.geometry.decodeVsDisplayAreaRatio;
      expect(ratio).not.toBeNull();
      // (1280*720) / (640*640) ~= 2.25, well above 1, not pinned to 1.00.
      expect(ratio).toBeGreaterThan(2);

      engine.diagnosticsStop();
      vi.useRealTimers();
      await engine.dispose();
    });

    it("the recorder stamps the broadcast snapshot without re-assembling it", async () => {
      vi.useFakeTimers();
      const { engine, diags } = setup();
      await engine.load(LOAD_CONFIG);
      engine.traceArm(60000);
      engine.diagnosticsStart(10);
      vi.advanceTimersByTime(100);

      const broadcast = diags[0].snapshot;
      const traced = engine.traceExport()?.snapshots[0];
      // Stamped with when it was taken, so the series has a time axis to
      // line up against the events. Every block under it is still the same
      // object the broadcast posted, so no second assembly happened.
      expect(typeof traced?.tMs).toBe("number");
      expect(traced?.scheduler).toBe(broadcast.scheduler);
      expect(traced?.realtime).toBe(broadcast.realtime);
      expect(traced?.counters).toBe(broadcast.counters);

      engine.diagnosticsStop();
      vi.useRealTimers();
      await engine.dispose();
    });

    it("a paint event names the frame it put up", async () => {
      const clock = new FakeClock();
      const { engine, cursor } = setup(clock);
      await engine.load(LOAD_CONFIG);
      bindFakeCanvas(engine);
      engine.traceArm(60000);

      cursor.emit(asSec(1.5));
      await flushRaf();

      const paint = engine
        .traceExport()
        ?.events.find((event) => event.type === "paint");
      // The snapshot ring samples at 10Hz and paints outrun it, so a paint that
      // names no frame is a paint the trace cannot place.
      expect(paint?.frameIndex).toBe(FRAME(1.5));

      await engine.dispose();
    });

    it("the keyframe distance is measured against the playhead once an anchor is known", async () => {
      vi.useFakeTimers();
      const { engine, diags, cursor } = setup();
      let keyframesMs: number[] = [];
      cursor.getStats = () => schedulerWithKeyframes(keyframesMs);
      await engine.load(LOAD_CONFIG);
      engine.scrub(FRAME(2.3));
      engine.diagnosticsStart(10);
      vi.advanceTimersByTime(100);

      // The index fills lazily, and a distance to nothing is not zero.
      expect(diags[0].snapshot.gop.distanceToNearestKeyframeS).toBeNull();

      keyframesMs = [0, 2_000, 4_000, 6_000];
      vi.advanceTimersByTime(100);

      // The playhead sits 0.3s past the 2s anchor and 1.7s short of the 4s one.
      expect(diags[1].snapshot.gop.distanceToNearestKeyframeS).toBeCloseTo(
        0.3,
        5,
      );

      engine.diagnosticsStop();
      vi.useRealTimers();
      await engine.dispose();
    });

    it("the trace ring records scrub, seek, step, and status events, not just paints", async () => {
      const clock = new FakeClock();
      const { engine } = setup(clock);
      await engine.load(LOAD_CONFIG);
      engine.traceArm(60000);

      engine.scrub(FRAME(2));
      await engine.commit(FRAME(3));
      await engine.seekToKey(4000);
      await engine.step(1);
      engine.play();
      engine.pause();

      const trace = engine.traceExport();
      const types = trace?.events.map((e) => e.type) ?? [];
      expect(types).toContain("scrub");
      expect(types).toContain("seek");
      expect(types).toContain("status");
      // A key-only seek is tagged so a cold reader can tell it apart.
      const keySeek = trace?.events.find((e) => e.type === "seek" && e.keyOnly);
      expect(keySeek).toBeDefined();
      // Status transitions ride the ring (play then pause are the last two).
      const statuses = (trace?.events ?? [])
        .filter((e) => e.type === "status")
        .map((e) => e.status);
      expect(statuses).toContain(PlaybackStatus.Playing);
      expect(statuses).toContain(PlaybackStatus.Paused);

      await engine.dispose();
    });

    it("the armed window sizes the snapshot ring, up to the memory ceiling", async () => {
      const { engine } = setup();
      await engine.load(LOAD_CONFIG);

      engine.traceArm(10_000);
      expect(engine.traceExport()?.coverage.snapshots.capacity).toBe(
        (10_000 / 1000) * DIAGNOSTICS.BROADCAST_HZ,
      );

      engine.traceArm(24 * 60 * 60 * 1000);
      expect(engine.traceExport()?.coverage.snapshots.capacity).toBe(
        DIAGNOSTICS.TRACE_SNAPSHOT_CAP,
      );

      await engine.dispose();
    });

    it("traceExport is null when nothing was armed", async () => {
      const { engine } = setup();
      await engine.load(LOAD_CONFIG);
      expect(engine.traceExport()).toBeNull();
      await engine.dispose();
    });

    it("traceDisarm keeps the stopped capture exportable; a fresh arm clears it", async () => {
      vi.useFakeTimers();
      const { engine } = setup();
      await engine.load(LOAD_CONFIG);
      engine.traceArm(60000);
      engine.diagnosticsStart(10);
      vi.advanceTimersByTime(100);
      engine.traceDisarm();
      // Stop must not lose the capture: record-then-stop-then-download.
      expect(engine.traceExport()).not.toBeNull();
      // A fresh arm with no capture clears the stopped trace.
      engine.traceArm(60000);
      engine.traceDisarm();
      const second = engine.traceExport();
      expect(second).not.toBeNull();
      expect(second?.snapshots.length ?? 0).toBe(0);

      engine.diagnosticsStop();
      vi.useRealTimers();
      await engine.dispose();
    });
  });
});

/**
 * The clock owns the rate, so what these pin is that every transport path leaves
 * it alone: none of pause, seek, replay, or an interactive-seek gesture may
 * quietly restore 1x, and a change mid-playback may not move the playhead.
 */
describe("EngineCore playback rate", () => {
  it("setPlaybackRate drives the clock and broadcasts the new rate", async () => {
    const clock = new FakeClock();
    const { engine, events } = setup(clock);
    await engine.load(LOAD_CONFIG);
    engine.setPlaybackRate(2);
    expect(clock.rate).toBe(2);
    expect(engine.getPlaybackRate()).toBe(2);
    expect(events).toContainEqual({ type: "rate", rate: 2 });
    await engine.dispose();
  });

  it("re-commanding the rate it already runs at broadcasts nothing", async () => {
    const clock = new FakeClock();
    const { engine, events } = setup(clock);
    await engine.load(LOAD_CONFIG);
    engine.setPlaybackRate(2);
    const after = events.length;
    engine.setPlaybackRate(2);
    expect(events).toHaveLength(after);
    await engine.dispose();
  });

  it.each([0, -1, -2, 0.1, 16, Number.NaN, Number.POSITIVE_INFINITY])(
    "a rate of %p is refused and leaves the running rate alone",
    async (rate) => {
      const clock = new FakeClock();
      const { engine } = setup(clock);
      await engine.load(LOAD_CONFIG);
      engine.setPlaybackRate(2);
      expect(() => engine.setPlaybackRate(rate)).toThrow(VideoEngineError);
      try {
        engine.setPlaybackRate(rate);
      } catch (error) {
        expect((error as VideoEngineError).code).toBe(
          VideoEngineErrorCode.RateUnsupported,
        );
      }
      expect(clock.rate).toBe(2);
      await engine.dispose();
    },
  );

  it("a rate change while playing re-anchors the clock without moving the playhead", async () => {
    const clock = new FakeClock();
    const { engine, events, cursor } = setup(clock);
    await engine.load(LOAD_CONFIG);
    engine.play();
    clock.seek(4);
    const attachesBeforeChange = cursor.attachPlayCalls;

    engine.setPlaybackRate(2);

    // Where the playhead is, and the walk feeding it, both survive: a rate
    // change that tore the play session down would re-attach the cursor and
    // stall playback for the length of a fresh decode.
    expect(clock.now()).toBe(4);
    expect(cursor.attachPlayCalls).toBe(attachesBeforeChange);
    expect(clock.playing).toBe(true);
    expect(statusesOf(events).at(-1)).toBe(PlaybackStatus.Playing);
    expect(seekingOf(events)).toEqual([]);
    await engine.dispose();
  });

  it("a rate set while paused survives into the next play", async () => {
    const clock = new FakeClock();
    const { engine, events } = setup(clock);
    await engine.load(LOAD_CONFIG);
    engine.setPlaybackRate(0.5);
    // Setting a rate is not a transport command; nothing may start running.
    expect(clock.playing).toBe(false);
    expect(statusesOf(events).at(-1)).toBe(PlaybackStatus.Ready);

    engine.play();
    expect(clock.rate).toBe(0.5);
    expect(clock.playing).toBe(true);
    await engine.dispose();
  });

  it("an interactive seek keeps the rate across the whole gesture", async () => {
    const clock = new FakeClock();
    const { engine } = setup(clock);
    await engine.load(LOAD_CONFIG);
    engine.setPlaybackRate(4);
    engine.play();

    engine.beginInteractiveSeek();
    expect(clock.playing).toBe(false);
    expect(clock.rate).toBe(4);
    engine.scrub(FRAME(2));
    expect(clock.rate).toBe(4);
    engine.endInteractiveSeek();

    expect(clock.playing).toBe(true);
    expect(clock.rate).toBe(4);
    expect(engine.getPlaybackRate()).toBe(4);
    await engine.dispose();
  });

  it("replaying from the end keeps the rate while snapping the playhead back", async () => {
    const clock = new FakeClock();
    const { engine, events } = setup(clock);
    await engine.load(LOAD_CONFIG);
    engine.setPlaybackRate(2);
    engine.play();
    clock.seek(10);
    engine.pause();
    expect(clock.rate).toBe(2);

    engine.play();
    expect(clock.now()).toBe(0);
    expect(clock.rate).toBe(2);
    expect(events).toContainEqual({
      type: "playhead",
      frameId: { index: 0, ticks: 0 },
      mediaTimeS: 0,
    });
    await engine.dispose();
  });

  it("time stays monotonic across a rate change mid-playback", async () => {
    const clock = new FakeClock();
    const { engine, events, cursor } = setup(clock);
    await engine.load(LOAD_CONFIG);
    bindFakeCanvas(engine);
    engine.play();

    for (const t of [0, 0.1, 0.2]) {
      clock.seek(t);
      cursor.emit(asSec(t));
      await flushRaf();
    }
    engine.setPlaybackRate(3);
    for (const t of [0.3, 0.4, 0.5]) {
      clock.seek(t);
      cursor.emit(asSec(t));
      await flushRaf();
    }

    const times = playheadsOf(events);
    expect(times.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
    }
    await engine.dispose();
  });

  it("the diagnostics snapshot carries the commanded rate", async () => {
    vi.useFakeTimers();
    const { engine, diags } = setup();
    await engine.load(LOAD_CONFIG);
    engine.setPlaybackRate(2);
    engine.diagnosticsStart(10);
    vi.advanceTimersByTime(100);

    expect(diags[0].snapshot.rate).toBe(2);
    engine.diagnosticsStop();
    vi.useRealTimers();
    await engine.dispose();
  });
});
