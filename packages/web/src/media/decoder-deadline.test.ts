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

  it("spends its budget only while the page is visible, then rejects naming the step", async () => {
    vi.useFakeTimers();
    const { page, show } = createPage("hidden");
    let outcome: unknown;
    const waiting = withinDecoderDeadline(
      new Promise(() => undefined),
      3000,
      "VideoDecoder.flush",
      page,
    ).catch((error: unknown) => {
      outcome = error;
    });

    await vi.advanceTimersByTimeAsync(60_000);
    show("visible");
    await vi.advanceTimersByTimeAsync(1000);
    show("hidden");
    await vi.advanceTimersByTimeAsync(60_000);
    show("visible");
    await vi.advanceTimersByTimeAsync(1999);
    expect(outcome).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(outcome).toMatchObject({
      message: "VideoDecoder.flush did not answer within 3 s.",
      name: "TimeoutError",
    });
  });
});
