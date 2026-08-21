import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import * as factoryModule from "./create-scrub-cursor";
import { EngineCore } from "./engine-core";
import { FrameTimeline } from "./frame-timeline";
import { asSec, PlaybackStatus } from "./types";
import { VideoEngine, type EngineWorkerPort } from "./video-engine";
import { handleEngineCommand } from "./worker-dispatch";
import type { EngineCommand, EngineEvent } from "./worker-protocol";
import {
  type FakeCursor,
  FakeClock,
  FakeOffscreenCanvas,
  installWorkerGlobals,
  LOAD_CONFIG,
  makeFakeCursor,
  makeScrubFrame,
  replaceProperty,
} from "../test/fake-engine-deps";

import horseTicks from "../test/fixtures/horse-trail-ticks.json";

vi.mock("./worker-bridge", () => ({ createEngineWorker: vi.fn() }));

beforeAll(() => {
  installWorkerGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The source's frames, computed here and not asked of anything under test.
 *
 * The dump is mediabunny's own packet table for `1min-horse-video.mov`, taken
 * metadata-only: the container's tick rate and each packet's presentation
 * timestamp in ticks, in the order the container stores them, which on this
 * B-frame clip is not presentation order. Everything below is derived from that
 * with plain arithmetic, so an engine that agrees with it agrees with the file.
 */
function readTruth(): {
  tickRate: number;
  ticks: number[];
  times: number[];
  tickSet: Set<number>;
  lastDurationTicks: number;
} {
  const { tickRate, decodeOrderTicks, decodeOrderDurationTicks } = horseTicks;
  const ticks = [...decodeOrderTicks].sort((a, b) => a - b);
  const lastAt = decodeOrderTicks.indexOf(ticks[ticks.length - 1]);
  return {
    lastDurationTicks: decodeOrderDurationTicks[lastAt],
    tickRate,
    ticks,
    tickSet: new Set(ticks),
    times: ticks.map((t) => t / tickRate),
  };
}

const TRUTH = readTruth();
const LAST_INDEX = TRUTH.ticks.length - 1;
const DURATION_S =
  (TRUTH.ticks[LAST_INDEX] + TRUTH.lastDurationTicks) / TRUTH.tickRate;

/**
 * What the decoder would report for the frame at `index`.
 *
 * A decoded timestamp reaches the engine through WebCodecs' microsecond plane,
 * and the two framings in play round it differently: mediabunny's sinks
 * truncate, the engine's own decode session rounds. Alternating between them is
 * the worst case the snap has to survive.
 */
function decodedTimeAt(index: number): number {
  const exact = TRUTH.times[index];
  const micros =
    index % 2 === 0 ? Math.trunc(exact * 1e6) : Math.round(exact * 1e6);
  return micros / 1e6;
}

/**
 * A deterministic pseudo-random stream, so a failure names a reproducible
 * gesture rather than one that vanishes on the next run.
 */
function randoms(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

interface Restored {
  readonly asked: number;
  readonly landed: number;
  readonly restored: number;
}

interface Sample {
  readonly phase: string;
  readonly index: number;
  readonly ticks: number;
  readonly mediaTimeS: number;
  readonly timeMs: number;
}

class FakeWorkerPort implements EngineWorkerPort {
  readonly engine: EngineCore;
  terminated = false;
  private listener: ((event: MessageEvent<EngineEvent>) => void) | null = null;

  constructor(clock: FakeClock) {
    this.engine = new EngineCore({
      emit: (event) => this.deliver(event),
      clock,
    });
  }

  postMessage(command: EngineCommand): void {
    void handleEngineCommand(this.engine, command, (out) => this.deliver(out));
  }

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<EngineEvent>) => void,
  ): void {
    this.listener = listener;
  }

  terminate(): void {
    this.terminated = true;
  }

  private deliver(event: EngineEvent): void {
    this.listener?.({ data: event } as MessageEvent<EngineEvent>);
  }
}

function horseCursor(): FakeCursor {
  const cursor = makeFakeCursor();
  const timeline = FrameTimeline.from({
    lastDurationTicks: TRUTH.lastDurationTicks,
    tickRate: TRUTH.tickRate,
    ticks: Float64Array.from(TRUTH.ticks),
  });
  replaceProperty(cursor, "track", {
    ...cursor.track,
    durationS: asSec(DURATION_S),
    firstTimestampS: asSec(TRUTH.times[0]),
    timeline,
  });
  cursor.seekToFrame = async (frame) => {
    cursor.seekToFrameCalls.push(frame);
    return makeScrubFrame(decodedTimeAt(frame.index));
  };
  return cursor;
}

const flushRaf = (): Promise<void> =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe("the published playhead is always a frame of the source", () => {
  /**
   * Runs the whole gesture programme once against the facade, the wire, the
   * core and the frame table, sampling every playhead the engine publishes.
   */
  async function runProgramme(): Promise<{
    samples: Sample[];
    stepIndices: number[];
    loopIndices: number[];
    restored: Restored[];
  }> {
    const cursor = horseCursor();
    vi.spyOn(factoryModule, "createScrubCursor").mockResolvedValue(cursor);
    const clock = new FakeClock();
    let port: FakeWorkerPort | null = null;
    const engine = new VideoEngine({ source: LOAD_CONFIG.source }, () => {
      port = new FakeWorkerPort(clock);
      return port;
    });
    await engine.load();
    const core = (port as unknown as FakeWorkerPort).engine;
    core.setCanvas(
      new FakeOffscreenCanvas(1280, 720) as unknown as OffscreenCanvas,
      {
        displayWidth: 1280,
        devicePixelRatio: 1,
      },
    );

    const samples: Sample[] = [];
    let phase = "load";
    const take = (): void => {
      const playhead = engine.getPlayhead();
      samples.push({
        index: playhead.frame.index,
        mediaTimeS: playhead.mediaTimeS,
        phase,
        ticks: playhead.frame.ticks,
        timeMs: engine.getTimeMs(),
      });
    };
    // Every publication, not a polled subset: the store wakes this on each
    // move, and `take` after each drive catches the moves that changed
    // nothing.
    engine.subscribe("time", take);
    take();

    // --- play -------------------------------------------------------------
    phase = "play";
    await engine.play();
    for (let i = 0; i < 90; i++) {
      clock.seek(TRUTH.times[i]);
      cursor.emit(asSec(decodedTimeAt(i)));
      await flushRaf();
      take();
    }

    // --- pause ------------------------------------------------------------
    phase = "pause";
    engine.pause();
    take();

    // --- step -------------------------------------------------------------
    phase = "step";
    const stepIndices: number[] = [];
    for (let i = 0; i < 40; i++) {
      await engine.step(1);
      stepIndices.push(engine.getPlayhead().frame.index);
      take();
    }
    for (let i = 0; i < 40; i++) {
      await engine.step(-1);
      stepIndices.push(engine.getPlayhead().frame.index);
      take();
    }

    // --- scrub ------------------------------------------------------------
    phase = "scrub";
    const random = randoms(0x5eed);
    const spanMs = DURATION_S * 1000;
    for (let i = 0; i < 200; i++) {
      const pointerMs = i < 150 ? (spanMs * i) / 150 : random() * spanMs;
      engine.scrub(pointerMs, "gesture");
      // Sampled before any paint can land: this is the drag, where the
      // playhead used to be the raw pointer position.
      take();
    }

    // --- seek -------------------------------------------------------------
    phase = "seek";
    for (let i = 0; i < 20; i++) {
      await engine.commit(random() * spanMs);
      take();
    }

    // --- restore ----------------------------------------------------------
    phase = "restore";
    const restored: Restored[] = [];
    for (let index = 0; index < LAST_INDEX; index++) {
      const insideMs =
        ((TRUTH.ticks[index] + TRUTH.ticks[index + 1]) / 2 / TRUTH.tickRate) *
        1000;
      engine.scrub(insideMs, "jump");
      const landed = engine.getPlayhead().frame.index;
      engine.scrub(engine.getTimeMs(), "jump");
      restored.push({
        asked: index,
        landed,
        restored: engine.getPlayhead().frame.index,
      });
      take();
    }

    // --- loop -------------------------------------------------------------
    phase = "loop";
    const loopIndices: number[] = [];
    await engine.play();
    for (const index of [LAST_INDEX - 2, LAST_INDEX - 1, LAST_INDEX]) {
      clock.seek(TRUTH.times[index]);
      cursor.emit(asSec(decodedTimeAt(index)));
      await flushRaf();
      loopIndices.push(engine.getPlayhead().frame.index);
      take();
    }
    engine.pause();
    clock.seek(DURATION_S + 1);
    await engine.play();
    loopIndices.push(engine.getPlayhead().frame.index);
    take();

    // --- rate -------------------------------------------------------------
    phase = "rate";
    for (const rate of [0.25, 1, 2, 4, 8]) {
      engine.setPlaybackRate(rate);
      for (let i = 0; i < 10; i++) {
        const index = 100 + i;
        clock.seek(TRUTH.times[index]);
        cursor.emit(asSec(decodedTimeAt(index)));
        await flushRaf();
        take();
      }
    }

    expect(engine.getStatus()).toBe(PlaybackStatus.Playing);
    await engine.dispose();
    return { loopIndices, restored, samples, stepIndices };
  }

  let result: Awaited<ReturnType<typeof runProgramme>>;

  beforeAll(async () => {
    result = await runProgramme();
  });

  it("the programme published a playhead in every phase", () => {
    const phases = new Set(result.samples.map((s) => s.phase));
    expect([...phases].sort()).toEqual([
      "load",
      "loop",
      "pause",
      "play",
      "rate",
      "restore",
      "scrub",
      "seek",
      "step",
    ]);
    expect(result.samples.length).toBeGreaterThan(500);
  });

  it("every published index names a frame of the source", () => {
    const offenders = result.samples.filter(
      (s) => !Number.isInteger(s.index) || s.index < 0 || s.index > LAST_INDEX,
    );
    expect(offenders.slice(0, 10)).toEqual([]);
  });

  it("every published position is a tick the container itself carries", () => {
    const offenders = result.samples
      .filter((s) => !TRUTH.tickSet.has(s.ticks))
      .map((s) => ({
        nearest: nearestTick(s.ticks),
        phase: s.phase,
        ticks: s.ticks,
      }));
    expect(offenders.slice(0, 10)).toEqual([]);
  });

  it("every published position is its own frame's tick, not a neighbour's", () => {
    const offenders = result.samples.filter(
      (s) => s.ticks !== TRUTH.ticks[s.index],
    );
    expect(offenders.slice(0, 10)).toEqual([]);
  });

  /**
   * Bit equality, never a tolerance. Both sides divide the same two integers
   * of the same container, so a consumer holding only seconds matches with
   * `===`; the moment that stops being true, a tolerance would hide it.
   */
  it("every published second is bit-identical to ticks over tick rate", () => {
    const offenders = result.samples.filter(
      (s) => s.mediaTimeS !== TRUTH.times[s.index],
    );
    expect(offenders.slice(0, 10)).toEqual([]);
  });

  it("the millisecond plane still lands on a real frame", () => {
    const offenders = result.samples
      .map((s) => ({
        phase: s.phase,
        ticks: Math.round((s.timeMs / 1000) * TRUTH.tickRate),
      }))
      .filter((s) => !TRUTH.tickSet.has(s.ticks));
    expect(offenders.slice(0, 10)).toEqual([]);
  });

  it("forty steps forward advance one frame each and forty back return", () => {
    const forward = result.stepIndices.slice(0, 40);
    const backward = result.stepIndices.slice(40);
    const start = forward[0] - 1;
    expect(forward).toEqual(
      Array.from({ length: 40 }, (_, i) => start + 1 + i),
    );
    expect(backward).toEqual(
      Array.from({ length: 40 }, (_, i) => start + 39 - i),
    );
  });

  it("a loop wraps to the first frame exactly once", () => {
    const wraps = result.loopIndices.filter(
      (index, at) => at > 0 && index < result.loopIndices[at - 1],
    );
    expect(wraps).toEqual([0]);
    expect(result.loopIndices.at(-1)).toBe(0);
  });

  it("a rate change moves no playhead off its frame", () => {
    const rated = result.samples.filter((s) => s.phase === "rate");
    expect(rated.length).toBeGreaterThan(0);
    for (const sample of rated) {
      expect(sample.mediaTimeS).toBe(TRUTH.times[sample.index]);
    }
  });

  it("a position inside a frame lands on that frame", () => {
    const offenders = result.restored.filter((r) => r.landed !== r.asked);
    expect(result.restored).toHaveLength(LAST_INDEX);
    expect(offenders.slice(0, 10)).toEqual([]);
  });

  it("handing a published position back leaves the playhead on its frame", () => {
    const offenders = result.restored.filter((r) => r.restored !== r.landed);
    expect(offenders.slice(0, 10)).toEqual([]);
  });
});

/**
 * A second source's frames, on the grain NTSC video uses.
 *
 * Read out of `raw_waterballoons.mp4` the same metadata-only way as the dump
 * above, and it comes to three numbers: 24000 ticks a second, 235 frames, each
 * one 1001 ticks after the last and 1001 ticks long. A table that short is
 * written here rather than dumped.
 *
 * The grain is why it is here. Two of these 235 frames publish a millisecond
 * that divides back to a second below the one it came from, and that is the
 * only kind of frame a host round trip can lose. The horse's 600 ticks a second
 * has none, so the programme above cannot tell an exact conversion from a lossy
 * one.
 */
const NTSC = {
  frameCount: 235,
  lastDurationTicks: 1001,
  tickRate: 24000,
  ticksPerFrame: 1001,
};
const NTSC_TICKS = Array.from(
  { length: NTSC.frameCount },
  (_, i) => i * NTSC.ticksPerFrame,
);
const NTSC_TIMES = NTSC_TICKS.map((ticks) => ticks / NTSC.tickRate);

function ntscCursor(): FakeCursor {
  const cursor = makeFakeCursor();
  const lastTicks = NTSC_TICKS[NTSC.frameCount - 1];
  replaceProperty(cursor, "track", {
    ...cursor.track,
    durationS: asSec((lastTicks + NTSC.lastDurationTicks) / NTSC.tickRate),
    firstTimestampS: asSec(NTSC_TIMES[0]),
    timeline: FrameTimeline.from({
      lastDurationTicks: NTSC.lastDurationTicks,
      tickRate: NTSC.tickRate,
      ticks: Float64Array.from(NTSC_TICKS),
    }),
  });
  return cursor;
}

interface Trip {
  readonly frame: number;
  readonly publishedMs: number;
  readonly restoredMs: number;
  readonly viaCommit: number;
  readonly viaFrame: number;
  readonly viaKey: number;
  readonly viaMs: number;
  readonly viaSeconds: number;
}

describe("a published position hands back the frame it came from", () => {
  /**
   * Every frame of the source, reached from a pointer inside it and then
   * restored through each way a host has of naming where it already is.
   */
  async function runRoundTrips(): Promise<Trip[]> {
    vi.spyOn(factoryModule, "createScrubCursor").mockResolvedValue(
      ntscCursor(),
    );
    const clock = new FakeClock();
    const engine = new VideoEngine(
      { source: LOAD_CONFIG.source },
      () => new FakeWorkerPort(clock),
    );
    await engine.load();

    const trips: Trip[] = [];
    for (let index = 0; index < NTSC.frameCount; index++) {
      const endTicks =
        index + 1 < NTSC.frameCount
          ? NTSC_TICKS[index + 1]
          : NTSC_TICKS[index] + NTSC.lastDurationTicks;
      engine.scrub(
        ((NTSC_TICKS[index] + endTicks) / 2 / NTSC.tickRate) * 1000,
        "jump",
      );
      const landed = engine.getPlayhead();
      const publishedMs = engine.getTimeMs();

      engine.scrub(publishedMs, "jump");
      const viaMs = engine.getPlayhead().frame.index;
      const restoredMs = engine.getTimeMs();

      // A host whose own surface speaks seconds divides on the way out
      // and multiplies on the way back, which is one more rounding.
      engine.scrub((publishedMs / 1000) * 1000, "jump");
      const viaSeconds = engine.getPlayhead().frame.index;

      engine.scrub(landed.frame, "jump");
      const viaFrame = engine.getPlayhead().frame.index;

      await engine.commit(publishedMs);
      const viaCommit = engine.getPlayhead().frame.index;

      await engine.seekToKey(publishedMs);
      const viaKey = engine.getPlayhead().frame.index;

      trips.push({
        frame: landed.frame.index,
        publishedMs,
        restoredMs,
        viaCommit,
        viaFrame,
        viaKey,
        viaMs,
        viaSeconds,
      });
    }

    await engine.dispose();
    return trips;
  }

  let trips: Trip[];

  beforeAll(async () => {
    trips = await runRoundTrips();
  });

  /**
   * Pins the hazard itself: a table that stopped carrying such a frame fails
   * here, instead of quietly passing everything below.
   */
  it("this source has frames whose millisecond does not divide back", () => {
    const lossy = NTSC_TIMES.filter(
      (seconds) => (seconds * 1000) / 1000 < seconds,
    );
    expect(lossy.length).toBeGreaterThan(0);
  });

  it("a pointer inside a frame reaches that frame, for every frame", () => {
    expect(trips).toHaveLength(NTSC.frameCount);
    const offenders = trips.filter((trip, index) => trip.frame !== index);
    expect(offenders.slice(0, 10)).toEqual([]);
  });

  it("every published millisecond is its own frame's ticks over tick rate", () => {
    const offenders = trips.filter(
      (trip) => trip.publishedMs !== NTSC_TIMES[trip.frame] * 1000,
    );
    expect(offenders.slice(0, 10)).toEqual([]);
  });

  it("a published millisecond handed straight back stays on its frame", () => {
    const offenders = trips.filter((trip) => trip.viaMs !== trip.frame);
    expect(offenders.slice(0, 10)).toEqual([]);
  });

  it("a published millisecond that went through seconds stays on its frame", () => {
    const offenders = trips.filter((trip) => trip.viaSeconds !== trip.frame);
    expect(offenders.slice(0, 10)).toEqual([]);
  });

  it("commit and seekToKey restore the same frame scrub does", () => {
    const offenders = trips.filter(
      (trip) => trip.viaCommit !== trip.frame || trip.viaKey !== trip.frame,
    );
    expect(offenders.slice(0, 10)).toEqual([]);
  });

  it("handing the frame itself back converts nothing", () => {
    const offenders = trips.filter((trip) => trip.viaFrame !== trip.frame);
    expect(offenders.slice(0, 10)).toEqual([]);
  });

  it("a restored position publishes the millisecond it was restored from", () => {
    const offenders = trips.filter(
      (trip) => trip.restoredMs !== trip.publishedMs,
    );
    expect(offenders.slice(0, 10)).toEqual([]);
  });
});

function nearestTick(ticks: number): number {
  let best = TRUTH.ticks[0];
  for (const candidate of TRUTH.ticks) {
    if (Math.abs(candidate - ticks) < Math.abs(best - ticks)) best = candidate;
  }
  return best;
}
