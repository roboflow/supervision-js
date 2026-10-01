import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { annotationRenderers, type DepthMap } from "supervision-js-core";

import type {
  DepthFrameEntry,
  DepthFrameProvider,
} from "#render-preparation/depth/source";
import {
  createMockSample,
  createRenderer,
  flushAnimationFrame,
  mediaMock,
  resetMocks,
} from "../../../../test/media-renderer-harness";

const depth = vi.hoisted(() => ({
  contexts: [] as unknown[],
  provider: null as unknown,
}));

vi.mock("#render-preparation/depth/source", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("#render-preparation/depth/source")
  >()),
  openDepthSource: vi.fn(async (_input: unknown, context: unknown) => {
    depth.contexts.push(context);
    return depth.provider;
  }),
}));

const FRAME_TIMES = [0, 0.04, 0.08, 0.12, 0.16];

function previewMap(): DepthMap {
  return {
    height: 18,
    kind: "disparity_px",
    samples: { encoding: "scaled16", scale: 256, values: new Uint16Array(576) },
    width: 32,
  };
}

/**
 * A clip of one preview frame per video frame, paired by the times above.
 * `decodedThrough` is the last frame the preview has decoded; frames past it
 * draw no depth and hold the gate until `release` is called.
 */
function createPreviewProvider() {
  const maps = FRAME_TIMES.map(() => previewMap());
  const indexAt = (mediaTime: number) => {
    let index = 0;

    while (
      index + 1 < FRAME_TIMES.length &&
      FRAME_TIMES[index + 1] <= mediaTime + 5e-4
    ) {
      index += 1;
    }
    return index;
  };
  const state = {
    decodedThrough: FRAME_TIMES.length - 1,
    drawn: [] as Array<{ mediaTime: number; frameIndex: number | null }>,
    prefetched: [] as number[],
    release: () => {},
    upcomingAsked: [] as number[],
    waits: [] as number[],
  };
  const entry = (index: number): DepthFrameEntry | null =>
    index <= state.decodedThrough
      ? { frameIndex: index, map: maps[index], precision: "preview" }
      : null;
  const provider: DepthFrameProvider = {
    destroy: vi.fn(),
    getEntry(mediaTime) {
      const found = entry(indexAt(mediaTime));

      state.drawn.push({ frameIndex: found?.frameIndex ?? null, mediaTime });
      return found;
    },
    getUpcomingEntries(mediaTime) {
      state.upcomingAsked.push(mediaTime);
      return [];
    },
    needsPlaybackGateWait: (mediaTime) =>
      indexAt(mediaTime) > state.decodedThrough,
    prefetch(mediaTime) {
      state.prefetched.push(mediaTime);
    },
    setPlaybackActive: vi.fn(),
    setScrubbing: vi.fn(),
    waitForReady(mediaTime) {
      if (indexAt(mediaTime) <= state.decodedThrough) return Promise.resolve();
      state.waits.push(mediaTime);
      return new Promise<void>((resolve) => {
        state.release = () => {
          state.decodedThrough = FRAME_TIMES.length - 1;
          resolve();
        };
      });
    },
  };

  return { maps, provider, state };
}

describe("media renderer depth on the Mediabunny pull path", () => {
  beforeEach(() => {
    resetMocks();
    depth.contexts.length = 0;
    mediaMock.samples = FRAME_TIMES.map((time) => createMockSample(time));
    mediaMock.getDurationFromMetadata.mockResolvedValue(0.2);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hands a clip the media's frame index reader", async () => {
    const { provider } = createPreviewProvider();

    depth.provider = provider;
    const renderer = await createRenderer(false, false, {
      renderers: [annotationRenderers.depth()],
    });

    await renderer.setDepth?.({ manifest: "https://example.test/depth.json" });

    const context = depth.contexts[0] as {
      frameClock: unknown;
      readFrameClock: () => Promise<{
        frameCount: number;
        timeAt(index: number): number;
      }>;
    };
    // Nothing published up front: the index is read when a clip asks.
    expect(context.frameClock).toBeNull();
    expect(mediaMock.encodedPacketSinkConstructor).not.toHaveBeenCalled();

    const clock = await context.readFrameClock();

    expect(clock.frameCount).toBe(5);
    expect(FRAME_TIMES.map((_, index) => clock.timeAt(index))).toEqual(
      FRAME_TIMES,
    );

    renderer.destroy();
  });

  it("draws each frame's own preview while playing and decodes ahead of it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { maps, provider, state } = createPreviewProvider();

    depth.provider = provider;
    const renderer = await createRenderer(false, false, {
      renderers: [annotationRenderers.depth()],
    });

    await renderer.setDepth?.({ manifest: "https://example.test/depth.json" });
    await renderer.play();
    for (const now of [40, 80, 120]) {
      flushAnimationFrame(now);
      await vi.waitFor(() =>
        expect(renderer.getActiveDepth?.()?.mediaTime).toBeCloseTo(
          now / 1000,
          6,
        ),
      );
      const active = renderer.getActiveDepth?.();
      const index = FRAME_TIMES.indexOf(active!.mediaTime);

      expect(active).toMatchObject({ frameIndex: index, precision: "preview" });
      expect(active?.map).toBe(maps[index]);
    }

    // Decoding follows each frame drawn, and the next textures go up in a
    // task of their own after the present.
    expect(state.prefetched).toEqual(
      expect.arrayContaining([0.04, 0.08, 0.12]),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(state.upcomingAsked.at(-1)).toBe(0.12);

    renderer.destroy();
    vi.useRealTimers();
  });

  it("holds the next frame until its depth is decoded, then shows it with its own depth", async () => {
    const { provider, state } = createPreviewProvider();

    state.decodedThrough = 1;
    depth.provider = provider;
    const renderer = await createRenderer(false, false, {
      renderPreparation: {
        playbackGate: { enabled: true, requiredAheadSeconds: 0 },
      },
      renderers: [annotationRenderers.depth()],
    });

    await renderer.setDepth?.({ manifest: "https://example.test/depth.json" });
    await renderer.play();
    flushAnimationFrame(40);
    await vi.waitFor(() =>
      expect(renderer.getActiveDepth?.()?.mediaTime).toBe(0.04),
    );
    flushAnimationFrame(80);
    await vi.waitFor(() => expect(state.waits).toContain(0.08));
    // Held: the picture stays on frame 1, with frame 1's depth.
    expect(renderer.getActiveDepth?.()).toMatchObject({
      frameIndex: 1,
      mediaTime: 0.04,
    });
    expect(state.drawn.some((drawn) => drawn.mediaTime === 0.08)).toBe(false);

    state.release();
    await vi.waitFor(() =>
      expect(renderer.getActiveDepth?.()).toMatchObject({
        frameIndex: 2,
        mediaTime: 0.08,
      }),
    );
    expect(state.drawn.filter((drawn) => drawn.frameIndex === null)).toEqual(
      [],
    );

    renderer.destroy();
  });

  it("points depth at the hand during a drag, and at the frame a seek lands on", async () => {
    const { provider, state } = createPreviewProvider();

    depth.provider = provider;
    const renderer = await createRenderer(false, false, {
      renderers: [annotationRenderers.depth()],
    });

    await renderer.setDepth?.({ manifest: "https://example.test/depth.json" });
    state.prefetched.length = 0;
    renderer.scrub(0.15);
    expect(state.prefetched).toEqual([0.15]);
    expect(provider.setScrubbing).toHaveBeenLastCalledWith(true);

    await renderer.seek(0.08);
    expect(provider.setScrubbing).toHaveBeenLastCalledWith(false);
    expect(state.prefetched.at(-1)).toBe(0.08);
    expect(renderer.getActiveDepth?.()).toMatchObject({
      frameIndex: 2,
      mediaTime: 0.08,
    });

    renderer.destroy();
  });
});
