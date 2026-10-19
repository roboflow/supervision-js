import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { HANG_RECOVERY } from "./constants";
import { EngineCore } from "./engine-core";
import { asSec, WebVideoEngineErrorCode } from "./types";
import {
  FakeClock,
  FakeOffscreenCanvas,
  installWorkerGlobals,
  LOAD_CONFIG,
  makeFakeCursor,
} from "../test/fake-engine-deps";
import * as factoryModule from "./create-scrub-cursor";

beforeAll(() => {
  installWorkerGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup() {
  const cursor = makeFakeCursor();
  vi.spyOn(factoryModule, "createScrubCursor").mockResolvedValue(cursor);
  const engine = new EngineCore({
    emit: () => undefined,
    clock: new FakeClock(),
  });

  return { cursor, engine };
}

function bindCanvas(engine: EngineCore) {
  engine.setCanvas(
    new FakeOffscreenCanvas(1280, 720) as unknown as OffscreenCanvas,
    { devicePixelRatio: 1, displayWidth: 1280 },
  );
}

const FRAME = (timeS: number) => Math.round(timeS * 30);

describe("EngineCore presentation latch visibility", () => {
  it("spends only visible time from a pending presentation latch", async () => {
    vi.useFakeTimers();
    const { engine } = setup();
    await engine.load(LOAD_CONFIG);
    bindCanvas(engine);

    const pending = engine.commit(FRAME(2));
    void pending.catch(() => undefined);
    const visibleSpentMs = 1_000;
    const remainingMs =
      HANG_RECOVERY.PRESENTATION_LATCH_TIMEOUT_MS - visibleSpentMs;
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    try {
      await vi.advanceTimersByTimeAsync(visibleSpentMs);
      engine.setPresentationVisibility(false);
      await vi.advanceTimersByTimeAsync(
        HANG_RECOVERY.PRESENTATION_LATCH_TIMEOUT_MS + 1_000,
      );
      expect(settled).toBe(false);

      engine.setPresentationVisibility(true);
      await vi.advanceTimersByTimeAsync(remainingMs - 1);
      expect(settled).toBe(false);
      await expect(
        vi.advanceTimersByTimeAsync(1).then(() => pending),
      ).rejects.toMatchObject({ code: WebVideoEngineErrorCode.DecoderStalled });
    } finally {
      await engine.dispose();
    }
  });

  it("supersedes a hidden latch without letting its old deadline affect the replacement", async () => {
    vi.useFakeTimers();
    const { cursor, engine } = setup();
    await engine.load(LOAD_CONFIG);
    bindCanvas(engine);

    const first = engine.commit(FRAME(2));
    void first.catch(() => undefined);
    try {
      engine.setPresentationVisibility(false);
      const second = engine.commit(FRAME(4));
      void second.catch(() => undefined);
      await expect(first).resolves.toBeNull();

      await vi.advanceTimersByTimeAsync(
        HANG_RECOVERY.PRESENTATION_LATCH_TIMEOUT_MS + 1,
      );
      let secondSettled = false;
      void second.then(
        () => {
          secondSettled = true;
        },
        () => {
          secondSettled = true;
        },
      );
      expect(secondSettled).toBe(false);

      engine.setPresentationVisibility(true);
      cursor.emit(asSec(4));
      await vi.advanceTimersByTimeAsync(20);
      await expect(second).resolves.toMatchObject({ mediaTimeS: 4 });
    } finally {
      await engine.dispose();
    }
  });

  it("rejects a hidden pending move on destroy and ignores later visibility signals", async () => {
    vi.useFakeTimers();
    const { engine } = setup();
    await engine.load(LOAD_CONFIG);
    bindCanvas(engine);

    const pending = engine.commit(FRAME(2));
    void pending.catch(() => undefined);
    try {
      engine.setPresentationVisibility(false);
      await engine.dispose();
      await expect(pending).rejects.toMatchObject({
        code: WebVideoEngineErrorCode.Aborted,
      });

      engine.setPresentationVisibility(true);
      await vi.advanceTimersByTimeAsync(
        HANG_RECOVERY.PRESENTATION_LATCH_TIMEOUT_MS + 1,
      );
    } finally {
      await engine.dispose();
    }
  });
});
