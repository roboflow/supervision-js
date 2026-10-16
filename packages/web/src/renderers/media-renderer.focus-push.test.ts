import { beforeEach, describe, expect, it, vi } from "vitest";
import { BaseFocusStyle, FocusTargetMode } from "supervision-js-core";
import type { MediaRendererSource } from "#types/media-renderer";

import {
  createRenderer,
  domMock,
  flushPixiTicker,
  pixiMock,
  resetMocks,
} from "../../../../test/media-renderer-harness";
import type {
  PresentedFrameChannel,
  PresentedFrameChannelSignal,
  PresentedFrameChannelStatus,
  PresentedVideoFrame,
} from "./presented-frame-channel";

beforeEach(resetMocks);

describe("focus transitions on pushed video through the public renderer", () => {
  it.each([0, Infinity])(
    "applies a %sms duration immediately during a present",
    async (duration) => {
      const producer = createPushSource();
      const renderer = await createRenderer(false, false, {
        src: undefined,
        source: producer.source,
        detectionFrames: [detectionFrame],
        focusStyle: new BaseFocusStyle({
          targetMode: FocusTargetMode.Ambient,
          fill: { alpha: 0.5, color: 0x000000 },
          shouldRender: ({ mediaTime }) => mediaTime === 0,
          transitionDurationMs: duration,
        }),
      });
      try {
        await vi.waitFor(() => expect(findFocus().alpha).toBe(1));
        const renders = renderer.getRenderCount() ?? 0;
        domMock.performanceNow.mockClear();
        producer.present(0.04);
        await vi.waitFor(() =>
          expect(renderer.getRenderCount()).toBe(renders + 1),
        );
        expect(findFocus().alpha).toBe(0);
        expect(domMock.performanceNow).not.toHaveBeenCalled();
        expect(pixiMock.tickerStart).not.toHaveBeenCalled();
      } finally {
        renderer.destroy();
      }
    },
  );

  it("preserves default media-time fades across redraws and settles presentation changes", async () => {
    const producer = createPushSource();
    const shouldRender = vi.fn(
      ({ mediaTime }: { mediaTime: number }) =>
        mediaTime >= 0.04 && mediaTime < 0.12,
    );
    const renderer = await createRenderer(false, false, {
      src: undefined,
      source: producer.source,
      detectionFrames: [detectionFrame],
      focusStyle: new BaseFocusStyle({
        targetMode: FocusTargetMode.Ambient,
        fill: { alpha: 0.5, color: 0x000000 },
        shouldRender,
      }),
    });
    try {
      await vi.waitFor(() => expect(shouldRender).toHaveBeenCalled());
      const restoreVisibility = vi
        .mocked(document.addEventListener)
        .mock.calls.filter(([name]) => name === "visibilitychange")
        .at(-1)?.[1];
      if (typeof restoreVisibility !== "function") {
        throw new Error("Expected the renderer's visibility listener");
      }
      for (const time of [0.04, 0.08, 0.12]) {
        const renders = renderer.getRenderCount() ?? 0;
        domMock.performanceNow.mockClear();
        producer.present(time);
        await vi.waitFor(() =>
          expect(renderer.getRenderCount()).toBe(renders + 1),
        );
        expect(domMock.performanceNow).not.toHaveBeenCalled();
        expect(findFocus().alpha).toBeGreaterThan(0);
        expect(findFocus().alpha).toBeLessThan(1);
        const alpha = findFocus().alpha;
        restoreVisibility.call(document, new Event("visibilitychange"));
        expect(findFocus().alpha).toBe(alpha);
        expect(renderer.getRenderCount()).toBe(renders + 2);
      }
      renderer.setPresentation({
        focusStyle: new BaseFocusStyle({
          targetMode: FocusTargetMode.Ambient,
          shouldRender: () => false,
        }),
      });
      expect(findFocus().alpha).toBe(0);
      expect(pixiMock.tickerStart).not.toHaveBeenCalled();
      expect(pixiMock.render).toHaveBeenCalledTimes(
        renderer.getRenderCount() ?? -1,
      );
    } finally {
      renderer.destroy();
    }
  });

  it("paints each bounded fade tick once through the scheduler outside atomic presents", async () => {
    const producer = createPushSource();
    const renderer = await createRenderer(false, false, {
      src: undefined,
      source: producer.source,
      detectionFrames: [detectionFrame],
      focusStyle: new BaseFocusStyle({
        targetMode: FocusTargetMode.Ambient,
        fill: { alpha: 0.5, color: 0x000000 },
        shouldRender: ({ mediaTime }) => mediaTime === 0,
        transitionDurationMs: 150,
      }),
    });
    try {
      await vi.waitFor(() => expect(findFocus()).toBeDefined());
      const focus = findFocus();
      expect(focus.alpha).toBe(1);
      expect(pixiMock.tickerStart).not.toHaveBeenCalled();
      await renderer.play();
      let clockReadsDuringPresent = 0;
      domMock.performanceNow.mockImplementation(() => {
        if (producer.hasOpenFrame()) clockReadsDuringPresent += 1;
        return 0;
      });
      producer.present(0.04);
      await vi.waitFor(() =>
        expect(pixiMock.tickerStart).toHaveBeenCalledOnce(),
      );
      expect(clockReadsDuringPresent).toBe(0);
      expect(focus.alpha).toBe(1);
      for (const time of [0, 75, 150]) {
        const renders = renderer.getRenderCount() ?? 0;
        flushPixiTicker(time);
        expect(renderer.getRenderCount()).toBe(renders + 1);
        expect(pixiMock.render).toHaveBeenCalledTimes(renders + 1);
        if (time === 75) {
          expect(focus.alpha).toBeGreaterThan(0);
          expect(focus.alpha).toBeLessThan(1);
        }
      }
      expect(focus.alpha).toBe(0);
      expect(focus.visible).toBe(false);
      expect(pixiMock.tickerStop).toHaveBeenCalledOnce();
      const settled = renderer.getRenderCount();
      flushPixiTicker(500);
      expect(renderer.getRenderCount()).toBe(settled);
    } finally {
      renderer.destroy();
    }
  });
});

const detectionFrame = {
  detections: [
    { id: "subject", rect: { x: 50, y: 50, width: 20, height: 20 } },
  ],
  mediaTime: 0,
};

function findFocus() {
  const focus = pixiMock.graphicsInstances.find((graphics) =>
    graphics.fill.mock.calls.some(
      ([fill]) => fill?.alpha === 0.5 && fill?.color === 0x000000,
    ),
  );
  if (!focus) throw new Error("Expected the drawn focus layer");
  return focus;
}

function createPushSource() {
  let handler: (frame: PresentedVideoFrame) => void = () => undefined;
  let time = 0;
  let paintSeq = 0;
  let openFrame = false;
  let status: PresentedFrameChannelStatus = "PAUSED";
  const listeners = new Map<PresentedFrameChannelSignal, Set<() => void>>();
  const setStatus = (next: PresentedFrameChannelStatus) => {
    status = next;
    for (const listener of listeners.get("state") ?? []) listener();
  };
  const present = (mediaTime: number) => {
    time = mediaTime;
    openFrame = true;
    handler({
      frame: {
        close: () => {
          openFrame = false;
        },
      } as VideoFrame,
      frameId: { index: Math.round(time * 25), ticks: Math.round(time * 1000) },
      mediaTimeS: time,
      paintSeq: ++paintSeq,
    });
  };
  const engine: PresentedFrameChannel = {
    beginInteractiveSeek: vi.fn(),
    commit: async (timeMs) => {
      present(timeMs / 1000);
    },
    endInteractiveSeek: vi.fn(async () => undefined),
    getDurationMs: () => 1000,
    getPlaybackRate: () => 1,
    getPlayhead: () => ({
      frame: { index: Math.round(time * 25), ticks: time * 1000 },
      mediaTimeS: time,
    }),
    getSeeking: () => false,
    getStatus: () => status,
    onPresentedFrame: (next) => {
      handler = next;
    },
    pause: () => setStatus("PAUSED"),
    play: async () => {
      setStatus("PLAYING");
    },
    scrub: vi.fn(),
    setPlaybackRate: vi.fn(),
    step: vi.fn(async () => undefined),
    subscribe: (signal, listener) => {
      const signalListeners = listeners.get(signal) ?? new Set<() => void>();
      signalListeners.add(listener);
      listeners.set(signal, signalListeners);
      return () => {
        signalListeners.delete(listener);
      };
    },
  };
  const source: MediaRendererSource = {
    open: async () => ({
      engine,
      input: { dispose: vi.fn() },
      metadata: {
        audioTrackCount: 0,
        canRead: true,
        duration: 1,
        firstTimestamp: 0,
        formatMimeType: null,
        formatName: "test-push-source",
        mimeType: null,
        primaryVideoHeight: 240,
        primaryVideoWidth: 320,
        trackCount: 1,
        videoTrackCount: 1,
      },
      sampleSink: {
        getSample: vi.fn(async () => null),
        samples: vi.fn(async function* () {}),
      },
    }),
  };
  return { source, present, hasOpenFrame: () => openFrame };
}
