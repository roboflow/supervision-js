import { describe, expect, it } from "vitest";

import { resolvePresentedFrameChannel } from "./presented-frame-channel";

describe("presented frame channel", () => {
  it("finds the plane a push-based source publishes", () => {
    const engine = { onPresentedFrame: () => undefined };

    expect(resolvePresentedFrameChannel({ engine })).toBe(engine);
  });

  it.each([
    ["a pull-only source", { sampleSink: {} }],
    ["an engine without the plane", { engine: {} }],
    ["nothing", null],
  ])("has no channel for %s", (_label, source) => {
    expect(resolvePresentedFrameChannel(source)).toBeNull();
  });
});
