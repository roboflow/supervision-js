import type { DepthPreviewLevels } from "supervision-js-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fakeProbeClip,
  openFakeDepthPreviewTrack,
  type FakeDecoderBehaviour,
} from "../../../../../test/fake-video-decoder";
import type { DepthPreviewDecoding } from "#media/depth-preview-probe";
import type {
  DepthPreviewDecodeOptions,
  DepthPreviewLumaFrame,
  DepthPreviewTrackOptions,
  DepthPreviewTrackReader,
} from "#media/depth-preview-track";
import type { DepthFramePreparer } from "#render-preparation/depth/frame-preparer";
import {
  assertDepthPreviewTimeline,
  describePreviewDecoding,
} from "#render-preparation/depth/clip-preview";
import { resolveDepthClipOptions } from "#render-preparation/depth/options";
import {
  openDepthSource,
  type DepthFrameProvider,
} from "#render-preparation/depth/source";
import {
  RenderPreparationArtifactKind,
  RenderPreparationExecutionMode,
  RenderPreparationWorkerStatus,
  type DepthPlaybackSource,
  type RenderPreparationDiagnostics,
} from "#types/render-preparation";

const MEDIA = { height: 720, width: 1280 };
const WIDTH = 16;
const HEIGHT = 9;
const COUNT = 10;
/** Ten one-second frames on the media's timeline, starting at 0.5 s. */
const CLOCK = {
  duration: 10,
  durationAt: () => 1,
  endTimestamp: 10.5,
  firstTimestamp: 0.5,
  frameCount: COUNT,
  indexAtOrBefore: (time: number) =>
    Math.min(COUNT - 1, Math.max(0, Math.floor(time - 0.5))),
  timeAt: (index: number) => index + 0.5,
};
const OPEN = { resumeAtSeconds: 2, stopBelowSeconds: 1 };

describe("depth source from a clip with a preview", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("draws the preview of the frame on screen while playing, and only that frame's", async () => {
    const clip = await openPreviewClip();

    clip.source.setPlaybackActive?.(true);
    clip.source.prefetch?.(CLOCK.timeAt(0));
    await settle();

    const drawn = clip.source.getEntry(CLOCK.timeAt(3) + 0.25);

    expect(drawn).toMatchObject({ frameIndex: 3, precision: "preview" });
    expect(previewCode(drawn)).toBe(code(3));
    // Never a neighbour's depth for a frame not decoded yet.
    expect(clip.source.getEntry(CLOCK.timeAt(9))).toBeNull();
    expect(clip.fetchedExact()).toEqual([]);
    clip.source.destroy();
    expect(clip.disposed()).toBe(true);
  });

  it("swaps the preview for the exact frame once playback rests, and back when it plays", async () => {
    const clip = await openPreviewClip();
    const changed = vi.fn();

    clip.source.subscribe?.(changed);
    clip.source.setPlaybackActive?.(true);
    clip.source.prefetch?.(CLOCK.timeAt(2));
    await settle();
    expect(clip.source.getEntry(CLOCK.timeAt(2))?.precision).toBe("preview");

    clip.source.setPlaybackActive?.(false);
    // Until the exact frame lands, the frame's own preview stays.
    expect(clip.source.getEntry(CLOCK.timeAt(2))).toMatchObject({
      frameIndex: 2,
      precision: "preview",
    });
    await vi.waitFor(() =>
      expect(clip.source.getEntry(CLOCK.timeAt(2))).toMatchObject({
        frameIndex: 2,
        precision: "exact",
      }),
    );
    expect(changed).toHaveBeenCalled();

    clip.source.setPlaybackActive?.(true);
    expect(clip.source.getEntry(CLOCK.timeAt(2))?.precision).toBe("preview");
    clip.source.destroy();
  });

  it("holds for a frame whose preview is not decoded, and lets go at the resume lead", async () => {
    const clip = await openPreviewClip({ gated: true });

    clip.source.setPlaybackActive?.(true);
    expect(clip.source.needsPlaybackGateWait?.(CLOCK.timeAt(0), OPEN)).toBe(
      true,
    );

    let ready = false;
    const wait = clip.source.waitForReady!(CLOCK.timeAt(0), OPEN).then(
      () => (ready = true),
    );

    await clip.release(1);
    expect(ready).toBe(false);
    await clip.release(2);
    await wait;
    expect(ready).toBe(true);
    expect(clip.source.getPreparationProgress?.()).toBe(3);
    clip.source.destroy();
  });

  it("ends a wait at rest on whichever depth lands first", async () => {
    const clip = await openPreviewClip({ gated: true });

    clip.source.setPlaybackActive?.(false);

    let ready = false;
    const wait = clip.source.waitForReady!(CLOCK.timeAt(6), OPEN).then(
      () => (ready = true),
    );

    // The exact frame loads once the frame is on screen; the preview never
    // releases a frame here.
    clip.source.getEntry(CLOCK.timeAt(6));
    await wait;
    expect(ready).toBe(true);
    expect(clip.fetchedExact()[0]).toBe(6);
    // The exact frame is all a step at rest needs; playing, the preview is
    // owed again.
    expect(clip.source.needsPlaybackGateWait?.(CLOCK.timeAt(6), OPEN)).toBe(
      false,
    );
    expect(clip.source.getFrameStatus?.(CLOCK.timeAt(6))?.prepared).toBe(true);
    clip.source.setPlaybackActive?.(true);
    expect(clip.source.getFrameStatus?.(CLOCK.timeAt(6))?.prepared).toBe(false);
    clip.source.destroy();
  });

  it("decodes no preview while the page is hidden", async () => {
    const page = new EventTarget() as EventTarget & {
      visibilityState: DocumentVisibilityState;
    };

    page.visibilityState = "hidden";
    vi.stubGlobal("document", page);

    const clip = await openPreviewClip();

    clip.source.setPlaybackActive?.(true);
    clip.source.prefetch?.(CLOCK.timeAt(0));
    await settle();
    expect(clip.source.getEntry(CLOCK.timeAt(0))).toBeNull();

    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(clip.source.getEntry(CLOCK.timeAt(0))?.precision).toBe("preview");
    clip.source.destroy();
    vi.unstubAllGlobals();
  });

  it("reports its preview window and its exact frames at rest", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onDiagnostics = vi.fn<(d: RenderPreparationDiagnostics) => void>();
    const clip = await openPreviewClip({ onDiagnostics });

    clip.source.prefetch?.(CLOCK.timeAt(0));
    clip.source.getEntry(CLOCK.timeAt(2));
    await vi.advanceTimersByTimeAsync(400);

    const last = onDiagnostics.mock.calls.at(-1)?.[0];

    expect(last?.artifacts).toEqual([
      expect.objectContaining({
        kind: RenderPreparationArtifactKind.DepthFrame,
        precision: "preview",
      }),
      expect.objectContaining({
        activeFrame: expect.objectContaining({
          key: "depth:2",
          status: "prepared",
        }),
        kind: RenderPreparationArtifactKind.ExactDepthFrame,
      }),
    ]);
    expect(last?.message).toBeNull();
    // Frames' codes are copied in the worker, so that is where the work runs.
    expect(last).toMatchObject({
      executionMode: RenderPreparationExecutionMode.Worker,
      workerStatus: RenderPreparationWorkerStatus.Ready,
    });
    clip.source.destroy();
  });

  it("opens the preview with the decoder the page probe chose, and says when codes change", async () => {
    const decoding: DepthPreviewDecoding = {
      correction: new Uint8Array(256),
      hardwareAcceleration: "prefer-hardware",
      probe: {
        decoded: new Uint8Array(256),
        exact: false,
        judgedCodes: 256,
        lumaPath: "plane",
        maxError: 20,
        mismatchedCodes: 249,
      },
      residualError: 1,
      verdicts: [],
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const opened: (DepthPreviewTrackOptions | undefined)[] = [];
    const clip = await openPreviewClip({
      choosePreviewDecoding: async () => decoding,
      onOpen: (options) => opened.push(options),
    });

    expect(opened).toEqual([
      expect.objectContaining({
        correction: decoding.correction,
        hardwareAcceleration: "prefer-hardware",
      }),
    ]);
    expect(opened[0]?.copier?.offMainThread).toBe(true);
    expect(warn.mock.calls[0]?.[0]).toContain("prefer-hardware");
    expect(describePreviewDecoding(decoding)).toContain(
      "249 of 256 come back different, by up to 20",
    );
    clip.source.destroy();
  });

  it("probes at a TV-range preview's levels, and maps its codes up to 235", async () => {
    const probed: DepthPreviewLevels[] = [];
    // An RGB path the probe's table undoes exactly: nothing to warn about.
    const decoding: DepthPreviewDecoding = {
      correction: new Uint8Array(256),
      hardwareAcceleration: "prefer-hardware",
      probe: {
        decoded: new Uint8Array(256),
        exact: false,
        judgedCodes: 220,
        lumaPath: "rgb",
        maxError: 20,
        mismatchedCodes: 218,
      },
      residualError: 0,
      verdicts: [],
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const clip = await openPreviewClip({
      choosePreviewDecoding: async (levels) => {
        probed.push(levels);
        return decoding;
      },
      tv: true,
    });

    clip.source.setPlaybackActive?.(true);
    clip.source.prefetch?.(CLOCK.timeAt(0));
    await settle();

    expect(probed).toEqual(["tv"]);
    expect(clip.source.getEntry(CLOCK.timeAt(0))?.map.samples).toMatchObject({
      encoding: "preview8",
      levels: "tv",
      reservedMax: 31,
    });
    expect(describePreviewDecoding(decoding)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    clip.source.destroy();
  });

  it("refuses a preview whose frames are not the video's, naming both times", async () => {
    await expect(
      openPreviewClip({ times: (index) => index * 1.04 }),
    ).rejects.toThrow(
      /Depth preview frame 1 is at 1\.04 s and its video frame at 1 s/,
    );
    await expect(openPreviewClip({ frameCount: COUNT - 1 })).rejects.toThrow(
      /9 frames and depth.json has 10/,
    );
    // Within half a millisecond is the same frame.
    expect(() =>
      assertDepthPreviewTimeline(
        { frameCount: 3, times: Float64Array.of(0, 0.0412, 0.0833) },
        3,
        (index) => [0, 0.04166, 0.08333][index],
      ),
    ).not.toThrow();
  });

  it("falls back to exact depth at rest when the preview cannot open", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const clip = await openPreviewClip({
      openError: new Error("no H.264 decoder"),
    });

    clip.source.setPlaybackActive?.(true);
    expect(clip.source.getEntry(CLOCK.timeAt(1))).toBeNull();
    expect(clip.source.needsPlaybackGateWait?.(CLOCK.timeAt(1), OPEN)).toBe(
      false,
    );
    expect(warn.mock.calls[0]?.[0]).toContain("did not open");
    clip.source.destroy();
  });

  describe("on decoders that misbehave", () => {
    const fakeTimers = () =>
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "performance"],
      });

    /** Draws no depth while playing, holds nothing, and the exact frame at rest. */
    async function expectExactAtRestOnly(
      clip: Awaited<ReturnType<typeof openPreviewClip>>,
      advance: (milliseconds: number) => Promise<unknown>,
    ) {
      clip.source.setPlaybackActive?.(true);
      expect(clip.source.getEntry(CLOCK.timeAt(1))).toBeNull();
      expect(clip.source.needsPlaybackGateWait?.(CLOCK.timeAt(1), OPEN)).toBe(
        false,
      );

      clip.source.setPlaybackActive?.(false);
      await advance(200);
      expect(clip.source.getEntry(CLOCK.timeAt(1))).toMatchObject({
        frameIndex: 1,
        precision: "exact",
      });
    }

    it("draws exact depth at rest when no decoder returns a frame of the probe", async () => {
      const choosePreviewDecoding = await probeThrough(() => "silent");

      fakeTimers();
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const onDiagnostics = vi.fn<(d: RenderPreparationDiagnostics) => void>();
      const onOpen = vi.fn();
      const opening = openPreviewClip({
        choosePreviewDecoding,
        decoder: () => "silent",
        onDiagnostics,
        onOpen,
      });

      const clip = await advanceUntilSettled(opening);
      const stall =
        "Error: The depth preview decoder returned no frame for 3 s of a flush.";

      expect(onOpen).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toBe(
        `The depth preview https://example.test/clip/preview.mp4 is off, so playback draws exact depth where it keeps up (playback auto or exact) and depth at rest otherwise: no decoder in this browser returned a frame of the probe clip (prefer-software: ${stall}; prefer-hardware: ${stall}).`,
      );
      await expectExactAtRestOnly(clip, vi.advanceTimersByTimeAsync);
      await vi.advanceTimersByTimeAsync(200);
      expect(onDiagnostics).toHaveBeenLastCalledWith(
        expect.objectContaining({
          artifacts: [
            expect.objectContaining({
              kind: RenderPreparationArtifactKind.ExactDepthFrame,
            }),
          ],
          message: warn.mock.calls[0]?.[0],
        }),
      );
      clip.source.destroy();
    });

    it("closes a preview decoder that stops returning frames, and stops holding playback for it", async () => {
      fakeTimers();
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const onDiagnostics = vi.fn<(d: RenderPreparationDiagnostics) => void>();
      const clip = await openPreviewClip({
        decoder: () => "silent",
        onDiagnostics,
      });

      clip.source.setPlaybackActive?.(true);
      clip.source.prefetch?.(CLOCK.timeAt(0));
      expect(clip.source.needsPlaybackGateWait?.(CLOCK.timeAt(0), OPEN)).toBe(
        true,
      );

      await vi.advanceTimersByTimeAsync(3500);

      expect(clip.disposed()).toBe(true);
      expect(clip.source.needsPlaybackGateWait?.(CLOCK.timeAt(0), OPEN)).toBe(
        false,
      );
      expect(warn).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(200);
      expect(onDiagnostics.mock.calls.at(-1)?.[0].message).toBe(
        "The depth preview stopped decoding, so playback draws exact depth where it keeps up (playback auto or exact) and depth at rest otherwise: Error: The depth preview decoder returned no frame for 3 s of a flush.",
      );
      await expectExactAtRestOnly(clip, vi.advanceTimersByTimeAsync);
      clip.source.destroy();
    });
  });
});

describe("exact depth while playing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('plays exact frames loaded ahead in "exact", and holds playback for them', async () => {
    const clip = await openPreviewClip({ gatedExact: true, playback: "exact" });

    clip.source.setPlaybackActive?.(true);
    clip.source.prefetch?.(CLOCK.timeAt(0));
    expect(clip.source.needsPlaybackGateWait?.(CLOCK.timeAt(0), OPEN)).toBe(
      true,
    );

    let ready = false;
    const wait = clip.source.waitForReady!(CLOCK.timeAt(0), OPEN).then(
      () => (ready = true),
    );

    // Two load at once, one per decode worker, nearest first.
    await vi.waitFor(() => expect(clip.fetchedExact()).toEqual([0, 1]));
    await clip.releaseExact(1);
    expect(ready).toBe(false);
    // Two seconds ahead is the resume lead.
    await clip.releaseExact(1);
    await wait;

    expect(clip.source.getEntry(CLOCK.timeAt(0))).toMatchObject({
      frameIndex: 0,
      precision: "exact",
    });
    expect(clip.source.getEntry(CLOCK.timeAt(1))).toMatchObject({
      frameIndex: 1,
      precision: "exact",
    });
    // Never a neighbour's depth for a frame not loaded yet: its preview,
    // which "exact" does not decode while playing, or nothing.
    expect(clip.source.getEntry(CLOCK.timeAt(8))).toBeNull();
    clip.source.destroy();
  });

  it('starts on the preview in "auto", takes exact once its lead builds, and hands back when it runs short', async () => {
    const clip = await openPreviewClip({ gatedExact: true, playback: "auto" });

    clip.source.setPlaybackActive?.(true);
    clip.source.prefetch?.(CLOCK.timeAt(0));
    await settle();
    expect(clip.source.getEntry(CLOCK.timeAt(0))?.precision).toBe("preview");

    // Five seconds ahead is wanted; four in a row is past three quarters.
    await clip.releaseExact(4);
    expect(clip.source.getEntry(CLOCK.timeAt(0))).toMatchObject({
      frameIndex: 0,
      precision: "exact",
    });
    expect(
      clip.source
        .getUpcomingEntries?.(CLOCK.timeAt(0), 2)
        .map((entry) => entry.precision),
    ).toEqual(["exact", "exact"]);

    // At frame 3 only one second is loaded ahead, under a quarter of five.
    clip.source.prefetch?.(CLOCK.timeAt(3));
    expect(clip.source.getEntry(CLOCK.timeAt(3))).toMatchObject({
      frameIndex: 3,
      precision: "preview",
    });
    clip.source.destroy();
  });

  it('starts over on the preview after a seek in "auto", then takes exact again', async () => {
    const clip = await openPreviewClip({ playback: "auto" });

    clip.source.setPlaybackActive?.(true);
    clip.source.prefetch?.(CLOCK.timeAt(0));
    await vi.waitFor(() =>
      expect(clip.source.getEntry(CLOCK.timeAt(0))?.precision).toBe("exact"),
    );

    // Nine frames on is a seek, not a present.
    const landed = clip.source.getEntry(CLOCK.timeAt(9));

    expect(landed === null || landed.precision === "preview").toBe(true);
    expect(landed?.frameIndex ?? 9).toBe(9);
    clip.source.prefetch?.(CLOCK.timeAt(9));
    await vi.waitFor(() =>
      expect(clip.source.getEntry(CLOCK.timeAt(9))?.precision).toBe("exact"),
    );
    clip.source.destroy();
  });

  it('plays exact frames in "auto" when the clip has no preview', async () => {
    const server = previewlessServer();
    const source = await openDepthSource(
      { manifest: "https://example.test/clip/depth.json" },
      {
        fetch: server.fetch,
        frameClock: CLOCK,
        media: MEDIA,
        openPreviewTrack: null,
        preparer: server.preparer,
      },
    );

    source.setPlaybackActive?.(true);
    source.prefetch?.(CLOCK.timeAt(2));
    await vi.waitFor(() =>
      expect(source.getEntry(CLOCK.timeAt(2))).toMatchObject({
        frameIndex: 2,
        precision: "exact",
      }),
    );
    source.destroy();
  });
});

/** A clip without a preview whose exact frames say which file they are. */
function previewlessServer() {
  const manifest = {
    display_range_px: [2, 60],
    frames: { count: COUNT, exact: "exact/{index:06}.png" },
    height: HEIGHT,
    kind: "disparity_px",
    schema: "supervision.depth-manifest",
    storage: { format: "png16", no_depth: 0, scale: 256 },
    version: 1,
    width: WIDTH,
  };
  const fetch = vi.fn(async (url: string | URL | Request) => {
    const text = String(url);

    if (text.endsWith("depth.json")) {
      return new Response(JSON.stringify(manifest));
    }

    return new Response(
      Uint8Array.of(Number(/exact\/(\d+)\.png$/.exec(text)?.[1])),
    );
  }) as unknown as typeof globalThis.fetch;
  const preparer = {
    concurrency: 2,
    decodeConfidence: vi.fn(),
    decodeDepth: vi.fn(async (bytes: ArrayBuffer) => ({
      height: HEIGHT,
      values: new Uint16Array(WIDTH * HEIGHT).fill(
        new Uint8Array(bytes)[0] * 256 + 1,
      ),
      width: WIDTH,
    })),
    destroy: vi.fn(),
  } as unknown as DepthFramePreparer;

  return { fetch, preparer: () => preparer };
}

describe("resolveDepthClipOptions", () => {
  const MIB = 1024 * 1024;
  const at = (width: number, height: number) =>
    resolveDepthClipOptions({
      exactFrameBytes: width * height * 2,
      frameRate: 30,
      previewFrameBytes: width * height,
    });

  it("scales its budgets with the frame size, and takes the host's", () => {
    expect(at(1280, 720).preview.maxCacheBytes / MIB).toBe(96);
    expect(at(1920, 1080).preview.maxCacheBytes / MIB).toBeCloseTo(
      (1920 * 1080 * 68) / MIB,
    );
    expect(at(3840, 2160).preview.maxCacheBytes / MIB).toBe(512);
    expect(at(3840, 2160).playback.maxExactCacheBytes / MIB).toBe(512);
    // The frame at rest and its two neighbours each side, twice over.
    expect(at(3840, 2160).exact.maxCacheBytes).toBe(3840 * 2160 * 2 * 10);
    expect(
      resolveDepthClipOptions(
        { exactFrameBytes: 10, frameRate: 30, previewFrameBytes: 10 },
        {
          maxExactPlaybackCacheBytes: 1,
          maxPreviewCacheBytes: 2,
          playback: "exact",
          previewPrefetchSeconds: 3,
        },
      ),
    ).toMatchObject({
      playback: { maxExactCacheBytes: 1, source: "exact" },
      preview: { maxCacheBytes: 2, prefetchSeconds: 3 },
    });
  });

  it("keeps at rest what the mask window keeps, one schedule batch past the frame", () => {
    const clip = { exactFrameBytes: 10, frameRate: 30, previewFrameBytes: 10 };

    expect(resolveDepthClipOptions(clip).preview.pausedFrameCount).toBe(3);
    // A session schedules sixteen at a time, so both keep seventeen frames.
    expect(
      resolveDepthClipOptions(clip, {}, { scheduleBatchSize: 16 }).preview
        .pausedFrameCount,
    ).toBe(17);
  });
});

/** Preview code a frame's luma is filled with: says which frame it is. */
function code(index: number) {
  return 16 + index * 10;
}

function previewCode(entry: ReturnType<DepthFrameProvider["getEntry"]>) {
  return entry?.map.samples.encoding === "preview8"
    ? entry.map.samples.values[0]
    : null;
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

async function advanceUntilSettled<T>(work: Promise<T>): Promise<T> {
  let settled = false;

  void work.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let step = 0; step < 100 && !settled; step += 1) {
    await vi.advanceTimersByTimeAsync(250);
  }

  return work;
}

interface PreviewClipOptions {
  readonly gated?: boolean;
  readonly frameCount?: number;
  readonly width?: number;
  readonly times?: (index: number) => number;
  readonly openError?: Error;
  readonly onOpen?: (options: DepthPreviewTrackOptions | undefined) => void;
  readonly choosePreviewDecoding?: (
    levels: DepthPreviewLevels,
  ) => Promise<DepthPreviewDecoding>;
  /** Writes the preview's manifest in TV range, codes 32 to 235. */
  readonly tv?: boolean;
  readonly onDiagnostics?: (diagnostics: RenderPreparationDiagnostics) => void;
  readonly decoder?: FakeDecoders;
  /** Which depth plays; these tests are about the preview unless they say. */
  readonly playback?: DepthPlaybackSource;
  /** Holds every exact frame's decode until released. */
  readonly gatedExact?: boolean;
}

type FakeDecoders = (
  preference: HardwareAcceleration | undefined,
) => FakeDecoderBehaviour;

/**
 * The page's probe, run through fake decoders. Its module is loaded fresh,
 * since the probe answers once per page, and before any fake timers start:
 * loading a module takes real time.
 */
async function probeThrough(decoder: FakeDecoders) {
  vi.resetModules();

  const { chooseDepthPreviewDecoding } =
    await import("#media/depth-preview-probe");

  return () =>
    chooseDepthPreviewDecoding(
      "full",
      async (_input, trackOptions) =>
        openFakeDepthPreviewTrack(
          ({ hardwareAcceleration }) => decoder(hardwareAcceleration),
          fakeProbeClip(),
          trackOptions,
        ),
      async () => true,
    );
}

async function openPreviewClip(options: PreviewClipOptions = {}) {
  const frameCount = options.frameCount ?? COUNT;
  const width = options.width ?? WIDTH;
  let allowance = 0;
  let wake: (() => void) | null = null;
  let disposed = false;
  const fetched: number[] = [];
  const manifest = {
    camera: { baseline_m: 0.12, fx_px: 1000 },
    display_range_px: [2, 60],
    frames: { count: COUNT, exact: "exact/{index:06}.png" },
    height: HEIGHT,
    kind: "disparity_px",
    preview: options.tv
      ? {
          file: "preview.mp4",
          levels: "tv",
          range_px: [0, 100],
          reserved_max: 31,
        }
      : { file: "preview.mp4", range_px: [0, 100], reserved_max: 15 },
    schema: "supervision.depth-manifest",
    storage: { format: "png16", no_depth: 0, scale: 256 },
    version: 1,
    width: WIDTH,
  };
  const fetch = vi.fn(async (url: string | URL | Request) => {
    const text = String(url);

    if (text.endsWith("depth.json"))
      return new Response(JSON.stringify(manifest));

    const index = Number(/exact\/(\d+)\.png$/.exec(text)?.[1]);

    fetched.push(index);
    return new Response(Uint8Array.of(index));
  }) as unknown as typeof globalThis.fetch;
  let exactAllowance = 0;
  const exactWaiters = new Set<() => void>();
  const preparer = {
    concurrency: 2,
    decodeConfidence: vi.fn(),
    decodeDepth: vi.fn(async (bytes: ArrayBuffer) => {
      if (options.gatedExact) {
        while (exactAllowance === 0) {
          await new Promise<void>((resolve) => exactWaiters.add(resolve));
        }
        exactAllowance -= 1;
      }
      return {
        height: HEIGHT,
        values: new Uint16Array(WIDTH * HEIGHT).fill(
          new Uint8Array(bytes)[0] * 256 + 1,
        ),
        width: WIDTH,
      };
    }),
    destroy: vi.fn(),
  } as unknown as DepthFramePreparer;
  const reader: DepthPreviewTrackReader = {
    decode(fromIndex: number, { keep }: DepthPreviewDecodeOptions = {}) {
      let next = fromIndex;
      let cancelled = false;

      return {
        cancel: () => {
          cancelled = true;
          wake?.();
        },
        next: async (): Promise<DepthPreviewLumaFrame | null> => {
          while (!cancelled && next < frameCount) {
            const index = next;

            next += 1;
            if (keep && !keep(index)) continue;
            if (options.gated) {
              while (allowance === 0 && !cancelled) {
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
              }
              if (cancelled) return null;
              allowance -= 1;
            }
            await Promise.resolve();
            return {
              height: HEIGHT,
              index,
              luma: new Uint8Array(width * HEIGHT).fill(code(index)),
              width,
            };
          }
          return null;
        },
      };
    },
    dispose: () => {
      disposed = true;
    },
    frameCount,
    lumaPath: () => "plane",
    height: HEIGHT,
    keyIndexAtOrBefore: (index) => index,
    times: Float64Array.from(
      { length: frameCount },
      (_, index) => options.times?.(index) ?? index,
    ),
    width,
  };
  const decoder = options.decoder;
  const openFake = (trackOptions: DepthPreviewTrackOptions = {}) => {
    const fake = openFakeDepthPreviewTrack(
      ({ hardwareAcceleration }) => decoder!(hardwareAcceleration),
      {
        frameCount,
        frameRate: 1,
        height: HEIGHT,
        keyEvery: 5,
        luma: (index) => new Uint8Array(width * HEIGHT).fill(code(index)),
        width,
      },
      trackOptions,
    );

    return {
      ...fake,
      dispose() {
        disposed = true;
        fake.dispose();
      },
    };
  };
  const source = await openDepthSource(
    { manifest: "https://example.test/clip/depth.json" },
    {
      choosePreviewDecoding: options.choosePreviewDecoding ?? null,
      // One-second frames: five seconds ahead is five frames.
      depth: {
        playback: options.playback ?? "preview",
        previewPrefetchSeconds: 5,
      },
      fetch,
      frameClock: CLOCK,
      media: MEDIA,
      onDiagnostics: options.onDiagnostics,
      previewLumaCopier: () => ({
        copy: () => null,
        destroy: () => undefined,
        offMainThread: true,
      }),
      openPreviewTrack: async (url, trackOptions) => {
        expect(url).toBe("https://example.test/clip/preview.mp4");
        options.onOpen?.(trackOptions);
        if (options.openError) throw options.openError;
        return decoder ? openFake(trackOptions) : reader;
      },
      preparer: () => preparer,
    },
  );

  return {
    disposed: () => disposed,
    fetchedExact: () => [...fetched],
    /** Lets `count` more exact decodes finish, in the order they were asked. */
    async releaseExact(count: number) {
      for (let step = 0; step < count; step += 1) {
        exactAllowance += 1;
        for (const wake of [...exactWaiters]) {
          exactWaiters.delete(wake);
          wake();
        }
        await settle();
      }
    },
    async release(count: number) {
      allowance += count;
      wake?.();
      await settle();
    },
    source,
  };
}
