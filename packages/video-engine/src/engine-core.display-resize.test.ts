import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as factory from "./create-scrub-cursor";
import {
  displayBoxResolution,
  type DecodeResolutionStrategy,
} from "./decode-resolution";
import { EngineCore } from "./engine-core";
import { handleEngineCommand } from "./worker-dispatch";
import type { EngineEvent } from "./worker-protocol";
import type { PresentedFrameEvent } from "./worker-protocol";
import { asSec, WebVideoEngineErrorCode } from "./types";
import {
  FakeClock,
  installWorkerGlobals,
  LOAD_CONFIG,
  makeFakeCursor,
  makeScrubFrame,
  replaceProperty,
} from "../test/fake-engine-deps";

const small = { boxWidth: 320, boxHeight: 180, devicePixelRatio: 1 };
const large = { ...small, boxWidth: 640, boxHeight: 360 };
const tick = () => vi.advanceTimersByTimeAsync(20);

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

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((answer) => {
    resolve = answer;
  });
  return { promise, resolve };
}

async function setup(
  strategy: DecodeResolutionStrategy = displayBoxResolution(small),
  onPresented?: (engine: EngineCore) => void,
) {
  const cursor = makeFakeCursor();
  replaceProperty(cursor, "track", {
    ...cursor.track,
    decodeWidth: 320,
    decodeHeight: 180,
  });
  cursor.resizeOutput = vi.fn(async ({ width, height }) => {
    replaceProperty(cursor, "track", {
      ...cursor.track,
      decodeWidth: width,
      decodeHeight: height,
    });
    return true;
  });
  vi.spyOn(cursor, "seekToFrame").mockImplementation(async (id) => {
    const frame = makeScrubFrame(cursor.track.timeline.timeAt(id.index));
    cursor.emitFrame(frame);
    return frame;
  });
  vi.spyOn(cursor, "seekTo").mockImplementation((time) => cursor.emit(time));
  vi.spyOn(factory, "createScrubCursor").mockResolvedValue(cursor);
  const clock = new FakeClock();
  const frames: PresentedFrameEvent[] = [];
  const statuses: string[] = [];
  const engine = new EngineCore({
    clock,
    emit: (event) => {
      if (event.type === "status") statuses.push(event.status);
    },
    emitPresentedFrame: (frame) => {
      frames.push(frame);
      frame.frame.close();
      onPresented?.(engine);
    },
  });
  await engine.load({
    ...LOAD_CONFIG,
    presentation: "frames",
    decodeStrategy: strategy,
  });
  cursor.emit(asSec(2));
  await tick();
  const shown = frames.at(-1)!;
  engine.acknowledgePresentedFrame(
    shown.paintSeq,
    shown.frameId,
    shown.navigationGeneration,
  );
  return { engine, cursor, clock, frames, shown, statuses };
}

describe("EngineCore display resize", () => {
  it.each(["before", "delivery"])(
    "preserves an interactive readiness hold installed %s resize delivery",
    async (when) => {
      let holdOnDelivery = false;
      const { engine, clock } = await setup(
        displayBoxResolution(small),
        (core) => {
          if (holdOnDelivery) core.beginInteractiveSeek();
        },
      );
      engine.play();
      if (when === "before") {
        engine.beginInteractiveSeek();
        await expect(engine.setDisplay(small)).resolves.toBe(false);
        expect(clock.playing).toBe(false);
      } else holdOnDelivery = true;
      const resize = engine.setDisplay(large);
      await tick();
      await expect(resize).resolves.toBe(true);
      expect(clock.playing).toBe(false);
      engine.endInteractiveSeek();
      expect(clock.playing).toBe(true);
      await engine.dispose();
    },
  );
  it("keeps an existing playback walk when same-tick resize requests cancel back to its size", async () => {
    const { engine, cursor, clock } = await setup();
    engine.play();
    const first = engine.setDisplay(large);
    const second = engine.setDisplay(small);
    await expect(first).rejects.toMatchObject({
      code: WebVideoEngineErrorCode.Aborted,
    });
    await expect(second).resolves.toBe(false);
    expect(clock.playing).toBe(true);
    expect(cursor.detachPlayCalls).toBe(0);
    expect(cursor.attachPlayCalls).toBe(1);
    await engine.dispose();
  });
  it("keeps the displayed frame while old queued output is held behind resize", async () => {
    const { engine, cursor, frames } = await setup();
    const gate = deferred();
    vi.mocked(cursor.resizeOutput!).mockImplementationOnce(async () => {
      await gate.promise;
      return true;
    });
    const count = frames.length;
    cursor.emit(asSec(3));
    const resize = engine.setDisplay(large);
    await tick();
    expect(frames).toHaveLength(count);
    gate.resolve();
    await tick();
    await resize;
    await engine.dispose();
  });

  it("honors play when same-tick resize requests cancel back to the existing size", async () => {
    const { engine, cursor, clock, statuses } = await setup();
    const first = engine.setDisplay(large);
    const second = engine.setDisplay(small);
    engine.play();
    await expect(first).rejects.toMatchObject({
      code: WebVideoEngineErrorCode.Aborted,
    });
    await expect(second).resolves.toBe(false);
    expect(clock.playing).toBe(true);
    expect(statuses.at(-1)).toBe("PLAYING");
    expect(cursor.attachPlayCalls).toBe(1);
    expect(cursor.resizeOutput).not.toHaveBeenCalled();
    await engine.dispose();
  });
  it("resumes the playback walk after a step deferred by resizing", async () => {
    const { engine, cursor, clock } = await setup();
    const gate = deferred();
    vi.mocked(cursor.resizeOutput!).mockImplementationOnce(async () => {
      await gate.promise;
      return true;
    });
    engine.play();
    const resize = engine.setDisplay(large);
    void resize.catch(() => undefined);
    await tick();
    const step = engine.step(1);
    gate.resolve();
    await tick();
    await expect(resize).rejects.toMatchObject({
      code: WebVideoEngineErrorCode.Aborted,
    });
    await step;
    expect(clock.playing).toBe(true);
    expect(cursor.attachPlayCalls).toBe(2);
    await engine.dispose();
  });
  it("answers the worker resize command only after its replacement frame is delivered", async () => {
    const { engine, frames } = await setup();
    const count = frames.length;
    const posts: EngineEvent[] = [];
    const request = handleEngineCommand(
      engine,
      { type: "setDisplay", requestId: 71, display: large },
      (event) => posts.push(event),
    );
    await Promise.resolve();
    expect(posts).toHaveLength(0);
    await tick();
    await request;
    expect(frames).toHaveLength(count + 1);
    expect(posts).toEqual([
      { type: "ack", requestId: 71, outputChanged: true },
    ]);
    await engine.dispose();
  });

  it.each(["drain", "decode"])(
    "coalesces rapid small-large-small during %s without painting the intermediate size",
    async (stage) => {
      const { engine, cursor, frames, shown } = await setup();
      const gate = deferred();
      const originalResize = vi
        .mocked(cursor.resizeOutput!)
        .getMockImplementation()!;
      if (stage === "drain")
        vi.mocked(cursor.resizeOutput!).mockImplementationOnce(
          async (dimensions) => {
            await gate.promise;
            return originalResize(dimensions);
          },
        );
      else
        vi.mocked(cursor.seekToFrame).mockImplementationOnce(async (id) => {
          await gate.promise;
          const frame = makeScrubFrame(cursor.track.timeline.timeAt(id.index));
          cursor.emitFrame(frame);
          return frame;
        });
      const count = frames.length;
      const first = engine.setDisplay(large);
      void first.catch(() => undefined);
      await tick();
      const second = engine.setDisplay(small);
      gate.resolve();
      await tick();
      await expect(first).rejects.toMatchObject({
        code: WebVideoEngineErrorCode.Aborted,
      });
      await expect(second).resolves.toBe(true);
      expect(cursor.track.decodeWidth).toBe(320);
      expect(frames.slice(count).map((frame) => frame.frameId)).toEqual([
        shown.frameId,
      ]);
      expect(factory.createScrubCursor).toHaveBeenCalledOnce();
      await engine.dispose();
    },
  );

  it("unchanged geometry does not interrupt playback or defer an immediate play", async () => {
    const { engine, cursor, clock } = await setup();
    const noOp = engine.setDisplay(small);
    engine.play();
    expect(clock.playing).toBe(true);
    await expect(noOp).resolves.toBe(false);
    expect(clock.playing).toBe(true);
    expect(cursor.attachPlayCalls).toBe(1);
    expect(cursor.resizeOutput).not.toHaveBeenCalled();
    await engine.dispose();
  });

  it.each<DecodeResolutionStrategy>([
    { kind: "native" },
    { kind: "capped", maxWidth: 320 },
    { kind: "viewport", maxDevicePixelRatio: 2 },
  ])(
    "refuses an explicit %j strategy without changing output",
    async (strategy) => {
      const { engine, cursor, frames } = await setup(strategy);
      const count = frames.length;
      await expect(engine.setDisplay(large)).rejects.toMatchObject({
        code: WebVideoEngineErrorCode.PresentationMismatch,
      });
      expect(cursor.resizeOutput).not.toHaveBeenCalled();
      expect(cursor.detachPlayCalls).toBe(0);
      expect(frames).toHaveLength(count);
      await engine.dispose();
    },
  );

  it.each(["drain", "decode"])(
    "releases a failed %s barrier so later navigation can proceed without reopening",
    async (stage) => {
      const { engine, cursor, frames, statuses } = await setup();
      if (stage === "drain")
        vi.mocked(cursor.resizeOutput!).mockRejectedValueOnce(
          new Error("resize failed"),
        );
      else
        vi.mocked(cursor.seekToFrame).mockRejectedValueOnce(
          new Error("resize failed"),
        );
      engine.play();
      await expect(engine.setDisplay(large)).rejects.toThrow("resize failed");
      expect(statuses.at(-1)).toBe("PAUSED");
      const seek = engine.commit(90);
      await tick();
      await seek;
      expect(frames.at(-1)?.frameId.index).toBe(90);
      expect(factory.createScrubCursor).toHaveBeenCalledOnce();
      await engine.dispose();
    },
  );

  it("re-presents the authoritative frame in place and does nothing for unchanged geometry", async () => {
    const { engine, cursor, frames, shown } = await setup();
    const resize = engine.setDisplay(large);
    await tick();
    await expect(resize).resolves.toBe(true);
    expect(frames.at(-1)?.frameId).toEqual(shown.frameId);
    expect(cursor.resizeOutput).toHaveBeenCalledWith({
      width: 640,
      height: 360,
    });
    expect(factory.createScrubCursor).toHaveBeenCalledOnce();
    const count = frames.length;
    await expect(engine.setDisplay(large)).resolves.toBe(false);
    await tick();
    expect(frames).toHaveLength(count);
    expect(cursor.resizeOutput).toHaveBeenCalledOnce();
    await engine.dispose();
  });

  it.each(["drain", "decode"])(
    "a pause during %s prevents resize from resuming playback",
    async (stage) => {
      const { engine, cursor, clock, frames, shown } = await setup();
      const gate = deferred();
      if (stage === "drain")
        vi.mocked(cursor.resizeOutput!).mockImplementationOnce(async () => {
          await gate.promise;
          return true;
        });
      else
        vi.mocked(cursor.seekToFrame).mockImplementationOnce(async (id) => {
          await gate.promise;
          const frame = makeScrubFrame(cursor.track.timeline.timeAt(id.index));
          cursor.emitFrame(frame);
          return frame;
        });
      engine.play();
      const resize = engine.setDisplay(large);
      let delivered = false;
      void resize.then(() => {
        delivered = true;
      });
      await tick();
      engine.pause();
      gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(delivered).toBe(false);
      await tick();
      await expect(resize).resolves.toBe(true);
      expect(clock.playing).toBe(false);
      expect(frames.at(-1)?.frameId).toEqual(shown.frameId);
      await engine.dispose();
    },
  );

  it.each(["drain", "decode"])(
    "a new seek during %s supersedes the resize's old-frame repaint",
    async (stage) => {
      const { engine, cursor, frames } = await setup();
      const gate = deferred();
      if (stage === "drain")
        vi.mocked(cursor.resizeOutput!).mockImplementationOnce(async () => {
          await gate.promise;
          return true;
        });
      else
        vi.mocked(cursor.seekToFrame).mockImplementationOnce(async (id) => {
          await gate.promise;
          const frame = makeScrubFrame(cursor.track.timeline.timeAt(id.index));
          cursor.emitFrame(frame);
          return frame;
        });
      const initialCount = frames.length;
      const resize = engine.setDisplay(large);
      void resize.catch(() => undefined);
      await tick();
      const seek = engine.commit(90);
      gate.resolve();
      await tick();
      await expect(resize).rejects.toMatchObject({
        code: WebVideoEngineErrorCode.Aborted,
      });
      await seek;
      if (stage === "drain") expect(cursor.seekToFrame).not.toHaveBeenCalled();
      expect(
        frames.slice(initialCount).map((frame) => frame.frameId.index),
      ).toEqual([90]);
      await engine.dispose();
    },
  );

  it.each(["drain", "decode"])(
    "disposal during %s aborts resize without reviving output",
    async (stage) => {
      const { engine, cursor, frames } = await setup();
      const gate = deferred();
      if (stage === "drain")
        vi.mocked(cursor.resizeOutput!).mockImplementationOnce(async () => {
          await gate.promise;
          return true;
        });
      else
        vi.mocked(cursor.seekToFrame).mockImplementationOnce(async (id) => {
          await gate.promise;
          const frame = makeScrubFrame(cursor.track.timeline.timeAt(id.index));
          cursor.emitFrame(frame);
          return frame;
        });
      const resize = engine.setDisplay(large);
      void resize.catch(() => undefined);
      await tick();
      await engine.dispose();
      await expect(resize).rejects.toMatchObject({
        code: WebVideoEngineErrorCode.Aborted,
      });
      const count = frames.length;
      gate.resolve();
      await tick();
      expect(frames).toHaveLength(count);
      expect(factory.createScrubCursor).toHaveBeenCalledOnce();
    },
  );
});
