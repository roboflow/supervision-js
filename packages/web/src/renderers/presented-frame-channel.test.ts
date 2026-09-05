import { describe, expect, it, vi } from "vitest";

import {
  createProtectedPresentedFrameSource,
  resolvePresentedFrameChannel,
  type PresentedFrameChannel,
  type PresentedFrameSource,
  type PresentedVideoFrame,
} from "./presented-frame-channel";

describe("presented frame channel", () => {
  it("finds the plane a push-based source publishes", () => {
    const engine = createChannel();

    expect(resolvePresentedFrameChannel({ engine })).toBe(engine);
  });

  it.each([
    ["a pull-only source", { sampleSink: {} }],
    ["an engine without the plane", { engine: {} }],
    [
      "a producer that announces frames but drives none of the playhead",
      { engine: { onPresentedFrame: () => undefined } },
    ],
    [
      "a producer that cannot say which frame its playhead sits on",
      { engine: { ...createChannel(), getPlayhead: undefined } },
    ],
    ["nothing", null],
  ])("has no channel for %s", (_label, source) => {
    expect(resolvePresentedFrameChannel(source)).toBeNull();
  });

  it.each(["unguarded", "guarded"] as const)(
    "rejects first presentation when the %s scene handoff throws without double-closing",
    async (mode) => {
      let emit!: (presented: PresentedVideoFrame) => void;
      const upstream: PresentedFrameSource = {
        onPresentedFrame(handler) {
          emit = handler;
        },
      };
      const protectedSource = createProtectedPresentedFrameSource(upstream);
      const close = vi.fn();
      const presented = {
        frame: { close } as unknown as VideoFrame,
        frameId: { index: 7, ticks: 7000 },
        mediaTimeS: 7,
        paintSeq: 1,
      };
      protectedSource.source.onPresentedFrame((owned) => {
        owned.frame.close();
        throw new Error("scene upload failed");
      });
      protectedSource.activate(() =>
        mode === "guarded" ? Promise.resolve() : null,
      );
      const first = protectedSource.waitForFirstPresentation();
      const navigation = protectedSource.beginNavigation();

      emit(presented);

      await expect(first).rejects.toThrow("scene upload failed");
      await expect(navigation.waitFor(presented.frameId)).rejects.toThrow(
        "scene upload failed",
      );
      expect(close).toHaveBeenCalledOnce();
      protectedSource.destroy();
    },
  );

  it("remembers a navigation frame accepted before the producer command resumes", async () => {
    let emit!: (presented: PresentedVideoFrame) => void;
    const upstream: PresentedFrameSource = {
      onPresentedFrame(handler) {
        emit = handler;
      },
    };
    const protectedSource = createProtectedPresentedFrameSource(upstream);
    const presented = {
      frame: { close: vi.fn() } as unknown as VideoFrame,
      frameId: { index: 11, ticks: 11000 },
      mediaTimeS: 11,
      paintSeq: 1,
    };
    protectedSource.source.onPresentedFrame((owned) => owned.frame.close());
    protectedSource.activate(() => null);
    const navigation = protectedSource.beginNavigation();

    emit(presented);

    await expect(
      navigation.waitFor(presented.frameId),
    ).resolves.toBeUndefined();
    protectedSource.destroy();
  });

  it("does not acknowledge a handed-off frame after navigation invalidates it", () => {
    let emit!: (presented: PresentedVideoFrame) => void;
    const upstream: PresentedFrameSource = {
      onPresentedFrame(handler) {
        emit = handler;
      },
    };
    const protectedSource = createProtectedPresentedFrameSource(upstream);
    const acknowledgePresentation = vi.fn();
    let acknowledge!: () => void;
    protectedSource.source.onPresentedFrame((owned) => {
      acknowledge = owned.acknowledgePresentation!;
    });
    protectedSource.activate(() => null);

    emit({
      acknowledgePresentation,
      frame: { close: vi.fn() } as unknown as VideoFrame,
      frameId: { index: 11, ticks: 11000 },
      mediaTimeS: 11,
      paintSeq: 1,
    });
    protectedSource.beginNavigation();
    acknowledge();

    expect(acknowledgePresentation).not.toHaveBeenCalled();
    protectedSource.destroy();
  });

  it("reports a scene failure after the first presentation without reclaiming its frame", async () => {
    let emit!: (presented: PresentedVideoFrame) => void;
    const upstream: PresentedFrameSource = {
      onPresentedFrame(handler) {
        emit = handler;
      },
    };
    const onPresentationError = vi.fn();
    const protectedSource = createProtectedPresentedFrameSource(
      upstream,
      onPresentationError,
    );
    let presentations = 0;
    protectedSource.source.onPresentedFrame((owned) => {
      presentations += 1;
      owned.frame.close();
      if (presentations > 1) throw new Error("later upload failed");
    });
    protectedSource.activate(() => null);
    const first = {
      frame: { close: vi.fn() } as unknown as VideoFrame,
      frameId: { index: 0, ticks: 0 },
      mediaTimeS: 0,
      paintSeq: 1,
    };
    const later = {
      frame: { close: vi.fn() } as unknown as VideoFrame,
      frameId: { index: 1, ticks: 1000 },
      mediaTimeS: 1,
      paintSeq: 2,
    };

    emit(first);
    await protectedSource.waitForFirstPresentation();
    emit(later);

    expect(onPresentationError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "later upload failed" }),
    );
    expect(later.frame.close).toHaveBeenCalledOnce();
    protectedSource.destroy();
  });
});

function createChannel(): PresentedFrameChannel {
  return {
    beginInteractiveSeek: vi.fn(),
    commit: vi.fn(async () => undefined),
    endInteractiveSeek: vi.fn(async () => undefined),
    getDurationMs: vi.fn(() => 0),
    getPlaybackRate: vi.fn(() => 1),
    getSeeking: vi.fn(() => false),
    getStatus: vi.fn(() => "READY" as const),
    getPlayhead: vi.fn(() => ({
      frame: { index: 0, ticks: 0 },
      mediaTimeS: 0,
    })),
    onPresentedFrame: vi.fn(),
    pause: vi.fn(),
    play: vi.fn(async () => undefined),
    scrub: vi.fn(),
    setPlaybackRate: vi.fn(),
    step: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
  };
}
