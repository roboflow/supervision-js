import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  annotationRenderers,
  MediaRendererPlaybackState,
  readDepthAt,
  type DepthMap,
} from "supervision-js-core";

import { encodePng } from "../../../../test/depth-png";
import {
  createDeferred,
  createMockSample,
  createRenderer,
  mediaMock,
  pixiMock,
  resetMocks,
} from "../../../../test/media-renderer-harness";

/** The harness media is 1280x720; this map is a 16:9 quarter of it. */
function depthMap(width = 320, height = 180): DepthMap {
  const values = new Uint16Array(width * height);

  values[0] = 256 * 12;
  return {
    height,
    kind: "disparity_px",
    samples: { encoding: "scaled16", scale: 256, values },
    width,
  };
}

function depthShaders() {
  return pixiMock.shaderInstances.filter(
    (shader) => "depthUniforms" in shader.resources,
  );
}

/** A 16:9 image manifest with a confidence plane, served from example.test. */
async function stubDepthServer(
  delayManifest?: Promise<void>,
): Promise<{ confidence: Uint8Array; samples: Uint16Array }> {
  const samples = Uint16Array.from({ length: 32 * 18 }, (_, i) =>
    i % 5 === 0 ? 0 : 256 * (1 + (i % 100)),
  );
  const confidence = Uint8Array.from({ length: 32 * 18 }, (_, i) => i & 0xff);
  const routes: Record<string, unknown> = {
    "https://example.test/depth/confidence.png": await encodePng({
      bitDepth: 8,
      height: 18,
      samples: confidence,
      width: 32,
    }),
    "https://example.test/depth/depth.json": {
      height: 18,
      image: { confidence_file: "confidence.png", file: "depth.png" },
      kind: "disparity_px",
      schema: "supervision.depth-manifest",
      storage: { format: "png16", no_depth: 0, scale: 256 },
      version: 1,
      width: 32,
    },
    "https://example.test/depth/depth.png": await encodePng({
      height: 18,
      samples,
      width: 32,
    }),
  };

  // The harness stubs globals of its own, so only fetch is replaced here.
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: string | URL | Request) => {
      const url = String(input);

      if (url.endsWith("depth.json")) await delayManifest;
      const body = routes[url];

      return body === undefined
        ? new Response(null, { status: 404 })
        : new Response(
            body instanceof Uint8Array
              ? (body as BufferSource)
              : JSON.stringify(body),
          );
    },
  );

  return { confidence, samples };
}

/**
 * A clip manifest of `count` exact frames, 32x18, where frame i reads
 * i + 1 px of disparity everywhere: the map drawn says which frame it is.
 */
async function stubClipServer(count: number) {
  const routes = new Map<string, unknown>([
    [
      "https://example.test/clip/depth.json",
      {
        frames: { count, exact: "exact/{index:06}.png" },
        height: 18,
        kind: "disparity_px",
        schema: "supervision.depth-manifest",
        storage: { format: "png16", no_depth: 0, scale: 256 },
        version: 1,
        width: 32,
      },
    ],
  ]);

  for (let index = 0; index < count; index += 1) {
    routes.set(
      `https://example.test/clip/exact/${String(index).padStart(6, "0")}.png`,
      await encodePng({
        height: 18,
        samples: new Uint16Array(32 * 18).fill(256 * (index + 1)),
        width: 32,
      }),
    );
  }

  const fetched: string[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: string | URL | Request) => {
      const url = String(input);
      const body = routes.get(url);

      fetched.push(url);
      return body === undefined
        ? new Response(null, { status: 404 })
        : new Response(
            body instanceof Uint8Array
              ? (body as BufferSource)
              : JSON.stringify(body),
          );
    },
  );

  return { fetched };
}

/** The exact frame a clip drew, read back from its disparity. */
function drawnExactFrame(renderer: Awaited<ReturnType<typeof createRenderer>>) {
  const active = renderer.getActiveDepth?.();

  if (!active || active.precision !== "exact") return null;
  return {
    frameIndex: active.frameIndex,
    measured: active.map.samples.values[0] / 256 - 1,
  };
}

describe("media renderer depth", () => {
  beforeEach(() => {
    resetMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads an image manifest and draws its map, confidence included", async () => {
    const { confidence, samples } = await stubDepthServer();
    const renderer = await createRenderer(false, false, {
      depth: { manifest: "https://example.test/depth/depth.json" },
      renderers: [annotationRenderers.depth()],
    });

    await vi.waitFor(() => expect(renderer.getActiveDepth?.()).not.toBeNull());

    const active = renderer.getActiveDepth?.();

    expect(active?.map.samples.values).toEqual(samples);
    expect(active?.map.confidence).toEqual(confidence);
    expect(
      readDepthAt(
        active!.map,
        { x: 80, y: 0 },
        { height: active!.mediaHeight, width: active!.mediaWidth },
      ),
    ).toMatchObject({ confidence: 2 / 255, disparityPx: 3, x: 2, y: 0 });

    renderer.destroy();
  });

  it("shows the media without waiting for a manifest given at creation, and draws depth when it lands", async () => {
    const manifestGate = createDeferred<void>();
    const { samples } = await stubDepthServer(manifestGate.promise);
    const renderer = await createRenderer(false, false, {
      depth: { manifest: "https://example.test/depth/depth.json" },
      renderers: [annotationRenderers.depth()],
    });

    // Ready over the media's first frame while depth.json is still in flight.
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Ready,
    );
    expect(renderer.getActiveDepth?.()).toBeNull();

    manifestGate.resolve();
    await vi.waitFor(() =>
      expect(renderer.getActiveDepth?.()?.map.samples.values).toEqual(samples),
    );

    renderer.destroy();
  });

  it("keeps the media up when a manifest given at creation fails, and says why", async () => {
    await stubDepthServer();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onDiagnostics = vi.fn();
    const renderer = await createRenderer(false, false, {
      depth: { manifest: "https://example.test/missing.json" },
      renderPreparation: { onDiagnostics },
      renderers: [annotationRenderers.depth()],
    });

    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());

    const message =
      "Depth did not load, so the media plays without it: Error: Unable to load depth manifest https://example.test/missing.json: 404";

    expect(warn.mock.calls[0]?.[0]).toBe(message);
    expect(onDiagnostics).toHaveBeenLastCalledWith(
      expect.objectContaining({ artifacts: [], message }),
    );
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Ready,
    );
    expect(renderer.getActiveDepth?.()).toBeNull();

    renderer.destroy();
  });

  it("lets a later setDepth win over a manifest still loading", async () => {
    const manifestGate = createDeferred<void>();
    await stubDepthServer(manifestGate.promise);
    const renderer = await createRenderer(false, false, {
      renderers: [annotationRenderers.depth()],
    });
    const map = depthMap(640, 360);

    const loading = renderer.setDepth?.({
      manifest: "https://example.test/depth/depth.json",
    });
    await renderer.setDepth?.({ map });
    manifestGate.resolve();
    await loading;

    expect(renderer.getActiveDepth?.()?.map).toBe(map);

    renderer.destroy();
  });

  it("rejects setDepth with the manifest's own error", async () => {
    await stubDepthServer();
    const renderer = await createRenderer(false, false, {
      renderers: [annotationRenderers.depth()],
    });

    await expect(
      renderer.setDepth?.({ manifest: "https://example.test/missing.json" }),
    ).rejects.toThrow(
      "Unable to load depth manifest https://example.test/missing.json: 404",
    );
    expect(renderer.getActiveDepth?.()).toBeNull();

    renderer.destroy();
  });

  it("reads a Mediabunny clip's frame index from its packets only when a clip asks", async () => {
    await stubClipServer(2);
    const renderer = await createRenderer(false, false, {
      depth: { map: depthMap() },
      renderers: [annotationRenderers.depth()],
    });

    expect(mediaMock.encodedPacketSinkConstructor).not.toHaveBeenCalled();

    await renderer.setDepth?.({
      manifest: "https://example.test/clip/depth.json",
    });
    expect(mediaMock.encodedPacketSinkConstructor).toHaveBeenCalledTimes(1);

    // A second clip on the same media reads the index it already has.
    await renderer.setDepth?.({
      manifest: "https://example.test/clip/depth.json",
    });
    expect(mediaMock.encodedPacketSinkConstructor).toHaveBeenCalledTimes(1);

    renderer.destroy();
  });

  it("pairs a Mediabunny clip's depth with frames by packet timestamps, not by a frame rate", async () => {
    // Variable frame rate: gaps of 40, 60, 30 and 70 ms.
    mediaMock.samples = [0, 0.04, 0.1, 0.13, 0.2].map((time, index, all) =>
      createMockSample(time, (all[index + 1] ?? 0.25) - time),
    );
    mediaMock.getDurationFromMetadata.mockResolvedValue(0.25);
    await stubClipServer(5);
    const renderer = await createRenderer(false, false, {
      renderPreparation: {
        depth: { exactNeighborFrameCount: 0, exactSettleSeconds: 0 },
      },
      renderers: [annotationRenderers.depth()],
    });

    await renderer.setDepth?.({
      manifest: "https://example.test/clip/depth.json",
    });
    await vi.waitFor(() =>
      expect(drawnExactFrame(renderer)).toEqual({ frameIndex: 0, measured: 0 }),
    );

    for (const [time, frame] of [
      [0.13, 3],
      [0.1, 2],
      [0.2, 4],
      [0.04, 1],
      // Inside frame 2's 60 ms, past where a 25 fps grid would put frame 3.
      [0.125, 2],
    ] as const) {
      await renderer.seek(time);
      await vi.waitFor(() =>
        expect(drawnExactFrame(renderer)).toEqual({
          frameIndex: frame,
          measured: frame,
        }),
      );
    }

    await renderer.stepBackward();
    await vi.waitFor(() =>
      expect(drawnExactFrame(renderer)).toEqual({ frameIndex: 1, measured: 1 }),
    );
    await renderer.stepForward();
    await vi.waitFor(() =>
      expect(drawnExactFrame(renderer)).toEqual({ frameIndex: 2, measured: 2 }),
    );

    renderer.destroy();
  });

  it("pairs a Mediabunny clip whose first frame straddles zero as the pull path presents it", async () => {
    // An edit list trims 20 ms of B-frame pre-roll: the first packet starts
    // before zero and is shown from zero; one before it is never shown.
    mediaMock.getFirstTimestamp.mockResolvedValue(-0.06);
    mediaMock.samples = [-0.06, -0.02, 0.02, 0.06].map((time) =>
      createMockSample(time, 0.04),
    );
    mediaMock.getDurationFromMetadata.mockResolvedValue(0.1);
    await stubClipServer(3);
    const renderer = await createRenderer(false, false, {
      renderPreparation: {
        depth: { exactNeighborFrameCount: 0, exactSettleSeconds: 0 },
      },
      renderers: [annotationRenderers.depth()],
    });

    await renderer.setDepth?.({
      manifest: "https://example.test/clip/depth.json",
    });
    await renderer.seek(0);
    await vi.waitFor(() =>
      expect(drawnExactFrame(renderer)).toEqual({ frameIndex: 0, measured: 0 }),
    );
    await renderer.seek(0.02);
    await vi.waitFor(() =>
      expect(drawnExactFrame(renderer)).toEqual({ frameIndex: 1, measured: 1 }),
    );

    renderer.destroy();
  });

  it("refuses a Mediabunny clip whose frame count is not the video's", async () => {
    await stubClipServer(3);
    const renderer = await createRenderer(false, false, {
      renderers: [annotationRenderers.depth()],
    });

    await expect(
      renderer.setDepth?.({ manifest: "https://example.test/clip/depth.json" }),
    ).rejects.toThrow(
      "depth.json has 3 frames and the media has 2; give frames.times_s when depth covers only some of the video's frames.",
    );

    renderer.destroy();
  });

  it("refuses a clip on media that has no frame index, and says why", async () => {
    await stubClipServer(1);
    const { createStaticImageMediaSource } =
      await import("#media/static-image-media-source");
    const renderer = await createRenderer(false, false, {
      renderers: [annotationRenderers.depth()],
      source: createStaticImageMediaSource({
        draw: vi.fn(),
        height: 720,
        width: 1280,
      }),
      src: undefined,
    });

    await expect(
      renderer.setDepth?.({ manifest: "https://example.test/clip/depth.json" }),
    ).rejects.toThrow(
      new RangeError(
        "depth.json describes a clip (frames), and the media has no frame index to pair them with: a still image has no time axis. Give it a still map: a map or an image manifest.",
      ),
    );
    expect(renderer.getActiveDepth?.()).toBeNull();

    renderer.destroy();
  });

  it("draws a still map under the first presented frame", async () => {
    const map = depthMap();
    const renderer = await createRenderer(false, false, {
      depth: { map },
      renderers: [annotationRenderers.depth()],
    });

    const active = renderer.getActiveDepth?.();

    expect(active).toMatchObject({
      frameIndex: null,
      map,
      mediaHeight: 720,
      mediaWidth: 1280,
      precision: "exact",
    });
    expect(depthShaders()).toHaveLength(1);
    expect(
      readDepthAt(
        active!.map,
        { x: 1, y: 1 },
        {
          height: active!.mediaHeight,
          width: active!.mediaWidth,
        },
      ),
    ).toMatchObject({ disparityPx: 12, x: 0, y: 0 });

    renderer.destroy();
  });

  it("replaces and removes depth without reopening the media", async () => {
    const renderer = await createRenderer(false, false, {
      renderers: [annotationRenderers.depth()],
    });
    const map = depthMap(640, 360);

    expect(renderer.getActiveDepth?.()).toBeNull();

    await renderer.setDepth?.({ map });
    expect(renderer.getActiveDepth?.()?.map).toBe(map);

    await renderer.setDepth?.(null);
    expect(renderer.getActiveDepth?.()).toBeNull();

    renderer.destroy();
  });

  it("refuses a map whose aspect ratio differs from the media's", async () => {
    const renderer = await createRenderer(false, false, {
      renderers: [annotationRenderers.depth()],
    });

    await expect(
      renderer.setDepth?.({ map: depthMap(320, 240) }),
    ).rejects.toThrow(
      "Depth map 320x240 does not have the aspect ratio of the 1280x720 media.",
    );
    expect(renderer.getActiveDepth?.()).toBeNull();

    renderer.destroy();
  });

  it("rejects a malformed map before opening the media", async () => {
    await expect(
      createRenderer(false, false, {
        depth: { map: { ...depthMap(), width: 7 } },
      }),
    ).rejects.toThrow(RangeError);
  });

  it("stops drawing when the presentation drops its depth renderers", async () => {
    const renderer = await createRenderer(false, false, {
      depth: { map: depthMap() },
      renderers: [annotationRenderers.depth()],
    });

    renderer.setPresentation({ renderers: [annotationRenderers.box()] });

    expect(renderer.getActiveDepth?.()).toBeNull();

    renderer.setPresentation({
      renderers: [
        annotationRenderers.depth({ id: "left", wipe: 0.5 }),
        annotationRenderers.depth({ colormap: "magma", id: "right" }),
      ],
    });

    expect(renderer.getActiveDepth?.()).not.toBeNull();
    expect(depthShaders()).toHaveLength(3);

    renderer.destroy();
  });
});
