import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import * as factoryModule from "./create-scrub-cursor";
import { EngineCore } from "./engine-core";
import { type FrameId, FrameTimeline } from "./frame-timeline";
import { setDiagnosticsEnabled } from "./scrub-controller";
import {
  ScrubCursorState,
  type FrameQuality,
  type ScrubCursor,
  type ScrubFrame,
  type ScrubFrameListener,
} from "./scrub-cursor";
import { asSec, type Sec } from "./types";
import type { MirrorEvent } from "./worker-protocol";
import {
  FakeClock,
  FakeOffscreenCanvas,
  installWorkerGlobals,
  LOAD_CONFIG,
} from "../test/fake-engine-deps";

beforeAll(() => {
  installWorkerGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
  setDiagnosticsEnabled(false);
});

const FPS = 30;
const FRAME_COUNT = 1000;
const EXACT_TOLERANCE_MS = 50;
const DECODE_FRAMES = 3;
const FRAME = (timeS: number): number => Math.round(timeS * FPS);

function flushRaf(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/** A cold seek costs several animation frames of decode, which is the room the
 *  render loop has to paint whatever it was already holding. */
async function decodeLatency(): Promise<void> {
  for (let i = 0; i < DECODE_FRAMES; i++) await flushRaf();
}

/**
 * A cursor that keeps the parts of the real scheduler this race is made of,
 * which the shared fake drops: open() emits the seed frame before anything is
 * listening, subscribe() replays it, an exact seek onto a cached frame answers
 * from the cache without decoding, and the drain emits its frame one turn
 * before seekSettled() resolves.
 */
interface SessionCursor extends Omit<ScrubCursor, "state"> {
  state: ScrubCursorState;
  emitted: number[];
}

function makeSessionCursor(): SessionCursor {
  const listeners = new Set<ScrubFrameListener>();
  const cachedMs: number[] = [];
  const settleResolvers: Array<() => void> = [];
  let lastEmitted: ScrubFrame | null = null;
  let pendingTargetS: number | null = null;
  let draining = false;

  const frameAt = (timestampS: number, quality: FrameQuality): ScrubFrame => ({
    kind: "canvas",
    timestampS: asSec(timestampS),
    source: {} as OffscreenCanvas,
    width: 1280,
    height: 720,
    isKeyFrame: false,
    quality,
  });

  const emit = (timestampS: number): void => {
    const ms = Math.round(timestampS * 1000);
    if (!cachedMs.includes(ms)) cachedMs.push(ms);
    const frame = frameAt(timestampS, "exact");
    lastEmitted = frame;
    cursor.emitted.push(ms);
    listeners.forEach((listener) => listener(frame));
  };

  /** The exact tier answers at or before the target and within one frame of
   *  it, which is what makes a seed at the origin the answer to a seek there. */
  const cachedAtOrBefore = (timeMs: number): number | null => {
    let best: number | null = null;
    for (const ms of cachedMs) {
      if (ms > timeMs) continue;
      if (timeMs - ms > EXACT_TOLERANCE_MS) continue;
      if (best === null || ms > best) best = ms;
    }
    return best;
  };

  const flushSettle = (): void => {
    const waiting = settleResolvers.splice(0);
    waiting.forEach((resolve) => resolve());
  };

  const drain = async (): Promise<void> => {
    draining = true;
    await Promise.resolve();
    while (pendingTargetS !== null) {
      const target = pendingTargetS;
      pendingTargetS = null;
      const hit = cachedAtOrBefore(Math.round(target * 1000));
      if (hit === null) {
        await decodeLatency();
        emit(target);
      } else {
        emit(hit / 1000);
      }
      flushSettle();
    }
    draining = false;
    flushSettle();
  };

  const cursor: SessionCursor = {
    state: ScrubCursorState.Idle,
    emitted: [],
    track: {
      width: 1280,
      height: 720,
      decodeWidth: 1280,
      decodeHeight: 720,
      rotation: 0,
      nativeFps: FPS,
      durationS: asSec(FRAME_COUNT / FPS),
      firstTimestampS: asSec(0),
      timeline: FrameTimeline.uniform(FPS, FRAME_COUNT),
    },
    isIdle: true,
    async open(): Promise<void> {
      emit(0);
    },
    seekTo(timestamp: Sec): void {
      pendingTargetS = timestamp;
      if (!draining) void drain();
    },
    seekToKey(timestamp: Sec): void {
      pendingTargetS = timestamp;
      if (!draining) void drain();
    },
    next(): void {},
    attachPlay(): void {},
    detachPlay(): void {},
    async seekToFrame(frame: FrameId): Promise<ScrubFrame | null> {
      return frameAt(cursor.track.timeline.timeAt(frame.index), "exact");
    },
    async idle(): Promise<void> {},
    seekSettled(): Promise<void> {
      if (pendingTargetS === null && !draining) return Promise.resolve();
      return new Promise<void>((resolve) => settleResolvers.push(resolve));
    },
    subscribe(listener: ScrubFrameListener): () => void {
      listeners.add(listener);
      if (lastEmitted) listener(lastEmitted);
      return (): void => {
        listeners.delete(listener);
      };
    },
    peekCached(timeMs: number): ScrubFrame | null {
      const hit = cachedAtOrBefore(timeMs);
      return hit === null ? null : frameAt(hit / 1000, "exact");
    },
    async close(): Promise<void> {},
  };
  return cursor;
}

interface SessionShape {
  /** Animation frames between binding the canvas and the first seek. The
   *  renderer attaches asynchronously and the loop paints nothing until it
   *  does, so a cold start spends several of these with the seed still
   *  stashed. */
  readonly warmFrames: number;
  /** Whether the host puts the playhead back where it was before the viewer
   *  touches anything, which lands a second copy of the seed in the stash. */
  readonly openingCommit: boolean;
  /** Animation frames between that opening commit and the first seek. */
  readonly gapFrames: number;
}

interface Session {
  readonly playheads: number[];
  readonly landing: number | null;
}

/** One session start, up to and including the first seek anyone makes. */
async function runSession(
  seekTo: number,
  shape: SessionShape,
): Promise<Session> {
  const cursor = makeSessionCursor();
  // The real factory opens the cursor before it hands it back, which is what
  // puts the seed frame on the wire with nothing subscribed yet.
  vi.spyOn(factoryModule, "createScrubCursor").mockImplementation(async () => {
    await cursor.open();
    return cursor as unknown as ScrubCursor;
  });
  const events: MirrorEvent[] = [];
  const engine = new EngineCore({
    emit: (event) => events.push(event),
    clock: new FakeClock(),
  });
  await engine.load(LOAD_CONFIG);
  engine.setCanvas(
    new FakeOffscreenCanvas(1280, 720) as unknown as OffscreenCanvas,
    { displayWidth: 1280, devicePixelRatio: 1 },
  );
  for (let i = 0; i < shape.warmFrames; i++) await flushRaf();
  if (shape.openingCommit) await engine.commit(0);
  for (let i = 0; i < shape.gapFrames; i++) await flushRaf();

  const before = events.length;
  const landing = await engine.commit(seekTo);
  await flushRaf();
  await flushRaf();
  await flushRaf();

  const playheads = events
    .slice(before)
    .flatMap((event) =>
      event.type === "playhead" ? [event.frameId.index] : [],
    );
  await engine.dispose();
  return { playheads, landing: landing?.frame.index ?? null };
}

const SEED_STILL_STASHED: SessionShape = {
  gapFrames: 0,
  openingCommit: false,
  warmFrames: 0,
};

const OPENING_COMMIT_RESTASHED_THE_SEED: SessionShape = {
  gapFrames: 0,
  openingCommit: true,
  warmFrames: 2,
};

describe("the first seek of a session", () => {
  const SESSIONS = 5;
  const TARGET = FRAME(5);

  async function revertedSessions(shape: SessionShape): Promise<number[]> {
    const reverted: number[] = [];
    for (let session = 0; session < SESSIONS; session++) {
      const { playheads, landing } = await runSession(TARGET, shape);
      if (playheads.includes(0) || landing === 0) reverted.push(session);
    }
    return reverted;
  }

  it("is not reverted by the seed frame the renderer has yet to paint", async () => {
    expect(await revertedSessions(SEED_STILL_STASHED)).toEqual([]);
  });

  it("is not reverted by the seed the opening commit stashed again", async () => {
    expect(await revertedSessions(OPENING_COMMIT_RESTASHED_THE_SEED)).toEqual(
      [],
    );
  });

  it("acknowledges the frame it asked for, never an earlier one", async () => {
    const { landing } = await runSession(
      TARGET,
      OPENING_COMMIT_RESTASHED_THE_SEED,
    );
    expect(landing === null || landing === TARGET).toBe(true);
  });

  it("holds when an animation frame separates the opening commit from the seek", async () => {
    const { playheads, landing } = await runSession(TARGET, {
      ...OPENING_COMMIT_RESTASHED_THE_SEED,
      gapFrames: 2,
    });
    expect(playheads).not.toContain(0);
    expect(landing === null || landing === TARGET).toBe(true);
  });
});
