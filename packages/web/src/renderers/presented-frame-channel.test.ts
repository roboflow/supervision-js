import { describe, expect, it, vi } from "vitest";

import {
  createProtectedPresentedFrameSource,
  resolvePresentedFrameChannel,
  type PresentedFrameChannel,
  type PresentedFrameSource,
  type PresentedVideoFrame,
} from "./presented-frame-channel";

describe("presented frame channel", () => {
  it("keeps a gated frame during resize without mistaking it for the replacement", async () => {
    let emit!: (frame: PresentedVideoFrame) => void;
    const source = createProtectedPresentedFrameSource({
      onPresentedFrame: (handler) => {
        emit = handler;
      },
    });
    const drawn: number[] = [];
    source.source.onPresentedFrame((frame) => {
      drawn.push(frame.paintSeq);
      frame.acknowledgePresentation?.();
      frame.frame.close();
    });
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => {
      ready = resolve;
    });
    source.activate(() => gate);
    const frame = {
      frame: { close: vi.fn() } as unknown as VideoFrame,
      frameId: { index: 1, ticks: 1000 },
      mediaTimeS: 1,
      paintSeq: 1,
    };
    const navigation = source.beginNavigation();
    let landed = false;
    void navigation.waitFor(frame.frameId).then(() => {
      landed = true;
    });
    emit(frame);
    const replacement = source.beginNavigation(true);
    let resized = false;
    void replacement.waitFor(frame.frameId).then(() => {
      resized = true;
    });
    expect(frame.frame.close).not.toHaveBeenCalled();
    expect(drawn).toEqual([]);
    expect(landed).toBe(false);
    ready();
    await vi.waitFor(() => expect(drawn).toEqual([1]));
    expect(landed).toBe(true);
    expect(resized).toBe(false);
    emit({
      ...frame,
      frame: { close: vi.fn() } as unknown as VideoFrame,
      paintSeq: 2,
    });
    await replacement.waitFor(frame.frameId);
    expect(drawn).toEqual([1, 2]);
    expect(resized).toBe(true);
    source.destroy();
  });

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
    protectedSource.source.onPresentedFrame((owned) => {
      owned.acknowledgePresentation?.();
      owned.frame.close();
    });
    protectedSource.activate(() => null);
    const navigation = protectedSource.beginNavigation();

    emit(presented);

    await expect(
      navigation.waitFor(presented.frameId),
    ).resolves.toBeUndefined();
    protectedSource.destroy();
  });

  it("waits for the scene acknowledgment before accepting a navigation or first pixels", async () => {
    let emit!: (presented: PresentedVideoFrame) => void;
    const upstream: PresentedFrameSource = {
      onPresentedFrame(handler) {
        emit = handler;
      },
    };
    const protectedSource = createProtectedPresentedFrameSource(upstream);
    let acknowledge!: () => void;
    protectedSource.source.onPresentedFrame((owned) => {
      acknowledge = owned.acknowledgePresentation!;
    });
    protectedSource.activate(() => null);
    const navigation = protectedSource.beginNavigation();
    const presented = {
      frame: { close: vi.fn() } as unknown as VideoFrame,
      frameId: { index: 11, ticks: 11000 },
      mediaTimeS: 11,
      paintSeq: 1,
    };
    let firstSettled = false;
    let navigationSettled = false;
    void protectedSource.waitForFirstPresentation().then(() => {
      firstSettled = true;
    });
    void navigation.waitFor(presented.frameId).then(() => {
      navigationSettled = true;
    });

    emit(presented);
    await Promise.resolve();

    expect({ firstSettled, navigationSettled }).toEqual({
      firstSettled: false,
      navigationSettled: false,
    });

    acknowledge();

    await expect(
      protectedSource.waitForFirstPresentation(),
    ).resolves.toBeUndefined();
    await expect(
      navigation.waitFor(presented.frameId),
    ).resolves.toBeUndefined();
    protectedSource.destroy();
  });

  it("reports accepted identity only after the scene returns successfully", async () => {
    let emit!: (frame: PresentedVideoFrame) => void;
    const accepted = vi.fn();
    const failed = vi.fn();
    const source = createProtectedPresentedFrameSource(
      {
        onPresentedFrame: (handler) => {
          emit = handler;
        },
      },
      failed,
      accepted,
    );
    let shouldFail = false;
    source.source.onPresentedFrame((frame) => {
      expect(accepted).toHaveBeenCalledTimes(shouldFail ? 1 : 0);
      if (!shouldFail) frame.acknowledgePresentation?.();
      frame.frame.close();
      if (shouldFail) throw new Error("upload failed");
    });
    source.activate(() => null);
    const frame = {
      frame: { close: vi.fn() } as unknown as VideoFrame,
      frameId: { index: 2, ticks: 2000 },
      mediaTimeS: 2,
      paintSeq: 1,
    };

    emit(frame);
    await source.waitForFirstPresentation();
    expect(accepted).toHaveBeenCalledExactlyOnceWith(frame.frameId, 2);

    shouldFail = true;
    emit({ ...frame, paintSeq: 2 });
    expect(failed).toHaveBeenCalledOnce();
    expect(accepted).toHaveBeenCalledOnce();
    source.destroy();
  });

  it("acknowledges an already accepted current frame only when explicitly allowed", async () => {
    let emit!: (presented: PresentedVideoFrame) => void;
    const protectedSource = createProtectedPresentedFrameSource({
      onPresentedFrame(handler) {
        emit = handler;
      },
    });
    const accepted = {
      frame: { close: vi.fn() } as unknown as VideoFrame,
      frameId: { index: 11, ticks: 11000 },
      mediaTimeS: 11,
      paintSeq: 1,
    };
    protectedSource.source.onPresentedFrame((frame) => {
      frame.acknowledgePresentation?.();
      frame.frame.close();
    });
    protectedSource.activate(() => null);
    emit(accepted);
    await protectedSource.waitForFirstPresentation();

    const strict = protectedSource.beginNavigation();
    let strictSettled = false;
    void strict.waitFor(accepted.frameId).then(() => {
      strictSettled = true;
    });
    await Promise.resolve();
    expect(strictSettled).toBe(false);
    strict.cancel();

    const navigation = protectedSource.beginNavigation();
    await expect(
      navigation.waitFor(accepted.frameId, true),
    ).resolves.toBeUndefined();

    const unaccepted = protectedSource.beginNavigation();
    let settled = false;
    void unaccepted.waitFor({ index: 12, ticks: 12000 }, true).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    unaccepted.cancel();
    protectedSource.destroy();
  });

  it("does not use an old accepted identity while its replacement is guarded", async () => {
    let emit!: (presented: PresentedVideoFrame) => void;
    const protectedSource = createProtectedPresentedFrameSource({
      onPresentedFrame(handler) {
        emit = handler;
      },
    });
    const frameId = { index: 11, ticks: 11000 };
    protectedSource.source.onPresentedFrame((frame) => {
      frame.acknowledgePresentation?.();
      frame.frame.close();
    });
    let release!: () => void;
    let guard: Promise<void> | null = null;
    protectedSource.activate(() => guard);
    emit({
      frame: { close: vi.fn() } as unknown as VideoFrame,
      frameId,
      mediaTimeS: 11,
      paintSeq: 1,
    });
    await protectedSource.waitForFirstPresentation();

    const navigation = protectedSource.beginNavigation();
    guard = new Promise<void>((resolve) => {
      release = resolve;
    });
    emit({
      frame: { close: vi.fn() } as unknown as VideoFrame,
      frameId,
      mediaTimeS: 11,
      paintSeq: 2,
    });
    let settled = false;
    void navigation.waitFor(frameId, true).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await expect(navigation.waitFor(frameId, true)).resolves.toBeUndefined();
    protectedSource.destroy();
  });

  it("acknowledges the producer before releasing the frontier and does both once", () => {
    let emit!: (presented: PresentedVideoFrame) => void;
    const upstream: PresentedFrameSource = {
      onPresentedFrame(handler) {
        emit = handler;
      },
    };
    const order: string[] = [];
    const protectedSource = createProtectedPresentedFrameSource(
      upstream,
      vi.fn(),
      undefined,
      () => {
        order.push("frontier");
      },
    );
    let acknowledge!: () => void;
    protectedSource.source.onPresentedFrame((owned) => {
      acknowledge = owned.acknowledgePresentation!;
    });
    protectedSource.activate(() => null);

    emit({
      acknowledgePresentation: () => order.push("producer"),
      frame: { close: vi.fn() } as unknown as VideoFrame,
      frameId: { index: 11, ticks: 11000 },
      mediaTimeS: 11,
      paintSeq: 1,
    });
    acknowledge();
    acknowledge();

    expect(order).toEqual(["producer", "frontier"]);
    protectedSource.destroy();
  });

  it("does not acknowledge a handed-off frame after navigation invalidates it", () => {
    let emit!: (presented: PresentedVideoFrame) => void;
    const upstream: PresentedFrameSource = {
      onPresentedFrame(handler) {
        emit = handler;
      },
    };
    const onPresented = vi.fn();
    const protectedSource = createProtectedPresentedFrameSource(
      upstream,
      vi.fn(),
      undefined,
      onPresented,
    );
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
    expect(onPresented).not.toHaveBeenCalled();
    protectedSource.destroy();
  });

  it("reports a producer acknowledgment failure without accepting the frame", async () => {
    let emit!: (presented: PresentedVideoFrame) => void;
    const upstream: PresentedFrameSource = {
      onPresentedFrame(handler) {
        emit = handler;
      },
    };
    const onPresentationError = vi.fn();
    const onPresented = vi.fn();
    const protectedSource = createProtectedPresentedFrameSource(
      upstream,
      onPresentationError,
      undefined,
      onPresented,
    );
    let acknowledge!: () => void;
    protectedSource.source.onPresentedFrame((owned) => {
      acknowledge = owned.acknowledgePresentation!;
    });
    protectedSource.activate(() => null);
    const navigation = protectedSource.beginNavigation();
    const presented = {
      acknowledgePresentation: () => {
        throw new Error("producer acknowledgment failed");
      },
      frame: { close: vi.fn() } as unknown as VideoFrame,
      frameId: { index: 11, ticks: 11000 },
      mediaTimeS: 11,
      paintSeq: 1,
    };

    emit(presented);
    acknowledge();

    await expect(protectedSource.waitForFirstPresentation()).rejects.toThrow(
      "producer acknowledgment failed",
    );
    await expect(navigation.waitFor(presented.frameId)).rejects.toThrow(
      "producer acknowledgment failed",
    );
    expect(onPresented).not.toHaveBeenCalled();
    protectedSource.destroy();
  });

  it("owns a rejected post-ack release and reports it", async () => {
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
      undefined,
      () => Promise.reject(new Error("frontier release failed")),
    );
    let acknowledge!: () => void;
    protectedSource.source.onPresentedFrame((owned) => {
      acknowledge = owned.acknowledgePresentation!;
    });
    protectedSource.activate(() => null);

    emit({
      frame: { close: vi.fn() } as unknown as VideoFrame,
      frameId: { index: 11, ticks: 11000 },
      mediaTimeS: 11,
      paintSeq: 1,
    });
    acknowledge();

    await expect(
      protectedSource.waitForFirstPresentation(),
    ).resolves.toBeUndefined();
    await vi.waitFor(() =>
      expect(onPresentationError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "frontier release failed" }),
      ),
    );
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
      owned.acknowledgePresentation?.();
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
