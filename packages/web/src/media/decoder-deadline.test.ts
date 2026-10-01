import { afterEach, describe, expect, it, vi } from "vitest";

import {
  withinDecoderDeadline,
  type DecoderDeadlinePage,
} from "./decoder-deadline";

function createPage(visibilityState: DocumentVisibilityState) {
  const target = new EventTarget();
  const page = {
    addEventListener: (type: string, listener: () => void) =>
      target.addEventListener(type, listener),
    removeEventListener: (type: string, listener: () => void) =>
      target.removeEventListener(type, listener),
    visibilityState,
  };

  return {
    page: page as DecoderDeadlinePage,
    show(state: DocumentVisibilityState) {
      page.visibilityState = state;
      target.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

describe("decoder deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a step that does not answer in time, naming it", async () => {
    vi.useFakeTimers();
    const { page } = createPage("visible");
    const waiting = withinDecoderDeadline(
      new Promise(() => undefined),
      3000,
      "VideoDecoder.flush",
      page,
    );
    const outcome = waiting.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(3000);
    expect(await outcome).toMatchObject({
      message: "VideoDecoder.flush did not answer within 3 s.",
      name: "TimeoutError",
    });
  });

  it("spends its budget only while the page is visible", async () => {
    vi.useFakeTimers();
    const { page, show } = createPage("visible");
    let settled = false;
    const waiting = withinDecoderDeadline(
      new Promise(() => undefined),
      3000,
      "VideoDecoder.flush",
      page,
    ).catch(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(1000);
    show("hidden");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);

    show("visible");
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(settled).toBe(true);
  });

  it("starts paused on a hidden page, and lets an answer through whenever it comes", async () => {
    vi.useFakeTimers();
    const { page } = createPage("hidden");
    let answer: (value: string) => void = () => undefined;
    const waiting = withinDecoderDeadline(
      new Promise<string>((resolve) => {
        answer = resolve;
      }),
      100,
      "VideoDecoder.isConfigSupported",
      page,
    );

    await vi.advanceTimersByTimeAsync(10_000);
    answer("supported");
    await expect(waiting).resolves.toBe("supported");
  });
});
