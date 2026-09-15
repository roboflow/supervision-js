import { afterEach, beforeEach, expect, it, vi } from "vitest";

import * as factory from "./create-scrub-cursor";
import { EngineCore } from "./engine-core";
import { displayBoxResolution } from "./decode-resolution";
import { asSec } from "./types";
import type { PresentedFrameEvent } from "./worker-protocol";
import {
  FakeClock,
  installWorkerGlobals,
  LOAD_CONFIG,
  makeFakeCursor,
  makeScrubFrame,
  replaceProperty,
} from "../test/fake-engine-deps";

beforeEach(() => {
  installWorkerGlobals();
  vi.useFakeTimers();
  vi.stubGlobal(
    "VideoFrame",
    class {
      close() {}
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const tick = () => vi.advanceTimersByTimeAsync(20);

async function setup() {
  const cursor = makeFakeCursor();
  vi.spyOn(factory, "createScrubCursor").mockResolvedValue(cursor);
  const clock = new FakeClock();
  const frames: PresentedFrameEvent[] = [];
  const hostPlayheads: number[] = [];
  const engine = new EngineCore({
    clock,
    emit: (event) => {
      if (event.type === "playhead") hostPlayheads.push(event.frameId.index);
    },
    emitPresentedFrame: (frame) => {
      frames.push(frame);
      frame.frame.close();
    },
  });
  await engine.load({
    ...LOAD_CONFIG,
    presentation: "frames",
    decodeStrategy: displayBoxResolution({
      boxWidth: 1280,
      boxHeight: 720,
      devicePixelRatio: 1,
    }),
  });
  engine.play();
  engine.beginInteractiveSeek();
  engine.scrub(60);
  cursor.emit(asSec(2));
  await tick();
  const shown = frames.at(-1)!;
  engine.acknowledgePresentedFrame(
    shown.paintSeq,
    shown.frameId,
    shown.navigationGeneration,
  );
  return { cursor, clock, frames, engine, hostPlayheads };
}

it("reuses the opening playback walk when release commits the same frame", async () => {
  const { cursor, frames, engine } = await setup();
  try {
    engine.endInteractiveSeek();
    const opening = cursor.attachPlayCalls;
    const pending = engine.commit(60);
    void pending.catch(() => undefined);
    expect(cursor.attachPlayCalls).toBe(opening);
    cursor.emit(asSec(2));
    await tick();
    await expect(pending).resolves.toMatchObject({ frame: { index: 60 } });
    expect(frames.at(-1)?.frameId.index).toBe(60);
  } finally {
    await engine.dispose();
  }
});

it("re-presents an already shown exact commit under a fresh presentation generation", async () => {
  const { cursor, frames, engine, hostPlayheads } = await setup();
  try {
    cursor.peekCached = () => makeScrubFrame(2);
    const before = frames.at(-1)!;
    engine.endInteractiveSeek();
    const acknowledgedBefore = hostPlayheads.length;
    let settled = false;
    const pending = engine.commit(60).then((frame) => {
      settled = true;
      return frame;
    });
    void pending.catch(() => undefined);
    await Promise.resolve();
    expect(frames).toHaveLength(2);
    const fresh = frames.at(-1)!;
    expect(fresh.paintSeq).toBeGreaterThan(before.paintSeq);
    expect(fresh.navigationGeneration).toBeGreaterThan(
      before.navigationGeneration,
    );
    expect(fresh.frameId).toEqual(before.frameId);
    expect(fresh.quality).toBe("exact");
    await expect(pending).resolves.toMatchObject({ frame: { index: 60 } });
    expect(settled).toBe(true);
    engine.acknowledgePresentedFrame(
      before.paintSeq,
      before.frameId,
      before.navigationGeneration,
    );
    expect(hostPlayheads).toHaveLength(acknowledgedBefore);
    engine.acknowledgePresentedFrame(
      fresh.paintSeq,
      fresh.frameId,
      fresh.navigationGeneration,
    );
    expect(hostPlayheads.slice(acknowledgedBefore)).toEqual([60]);
    const count = frames.length;
    await tick();
    expect(frames).toHaveLength(count);
  } finally {
    await engine.dispose();
  }
});

it.each(["different target", "already advanced"] as const)(
  "starts a new playback walk for a commit that is %s",
  async (mode) => {
    const { cursor, clock, engine } = await setup();
    try {
      engine.endInteractiveSeek();
      if (mode === "already advanced") {
        cursor.emit(asSec(2));
        await tick();
        clock.seek(2.1);
      }
      const opening = cursor.attachPlayCalls;
      const index = mode === "different target" ? 61 : 60;
      const pending = engine.commit(index);
      void pending.catch(() => undefined);
      expect(cursor.attachPlayCalls).toBe(opening + 1);
      cursor.emit(cursor.track.timeline.timeAt(index));
      await tick();
      await pending;
    } finally {
      await engine.dispose();
    }
  },
);

it.each(["preview", "neighbor"] as const)(
  "does not acknowledge a commit using a cached %s",
  async (kind) => {
    const { cursor, frames, engine } = await setup();
    try {
      cursor.peekCached = () =>
        makeScrubFrame(
          kind === "neighbor" ? 2 + 1 / 30 : 2,
          kind === "preview" ? "preview" : "exact",
        );
      engine.endInteractiveSeek();
      let settled = false;
      const pending = engine.commit(60).then(() => {
        settled = true;
      });
      void pending.catch(() => undefined);
      await tick();
      expect(settled).toBe(false);
      expect(frames).toHaveLength(1);
      cursor.emit(asSec(2));
      await tick();
      await pending;
    } finally {
      await engine.dispose();
    }
  },
);

it("resumes the opening playback walk after display resize detached it", async () => {
  const { cursor, engine } = await setup();
  try {
    cursor.resizeOutput = vi.fn(async ({ width, height }) => {
      replaceProperty(cursor, "track", {
        ...cursor.track,
        decodeWidth: width,
        decodeHeight: height,
      });
      return true;
    });
    vi.spyOn(cursor, "seekToFrame").mockImplementation(async (frame) => {
      const decoded = makeScrubFrame(cursor.track.timeline.timeAt(frame.index));
      cursor.emitFrame(decoded);
      return decoded;
    });
    engine.endInteractiveSeek();
    const opening = cursor.attachPlayCalls;
    const resized = engine.setDisplay({
      boxWidth: 640,
      boxHeight: 360,
      devicePixelRatio: 1,
    });
    await tick();
    await expect(resized).resolves.toBe(true);
    expect(cursor.attachPlayCalls).toBe(opening + 1);
  } finally {
    await engine.dispose();
  }
});
