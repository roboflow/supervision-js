import { afterEach, describe, expect, it, vi } from "vitest";

import { parseDepthManifest, type DepthMap } from "supervision-js-core";
import { encodePng } from "../../../../../test/depth-png";
import { createDepthMapUpload } from "#renderers/depth-textures";
import {
  createDepthFramePreparer,
  type DepthFramePreparer,
} from "#render-preparation/depth/frame-preparer";
import { resolveUrl } from "#render-preparation/depth/files";
import {
  openDepthSource,
  type DepthFrameProvider,
  validateDepthInput,
} from "#render-preparation/depth/source";
import {
  RenderPreparationMode,
  type RenderPreparationDepthOptions,
} from "#types/render-preparation";

const MEDIA = { height: 720, width: 1280 };

function depthMap(width: number, height: number): DepthMap {
  return {
    height,
    kind: "disparity_px",
    samples: {
      encoding: "scaled16",
      scale: 256,
      values: new Uint16Array(width * height),
    },
    width,
  };
}

function wireManifest(overrides: Record<string, unknown> = {}) {
  return {
    camera: { baseline_m: 0.12, fx_px: 1000 },
    display_range_px: [2, 60],
    height: 9,
    image: { confidence_file: "confidence.png", file: "depth.png" },
    kind: "disparity_px",
    schema: "supervision.depth-manifest",
    storage: { format: "png16", no_depth: 0, scale: 256 },
    version: 1,
    view: "left",
    width: 16,
    ...overrides,
  };
}

/** Samples 0..143 x 257 and confidences 0..143, one per pixel of a 16x9 map. */
async function files() {
  const depth = Uint16Array.from({ length: 16 * 9 }, (_, i) => i * 257);
  const confidence = Uint8Array.from({ length: 16 * 9 }, (_, i) => i);

  return {
    confidence,
    confidencePng: await encodePng({
      bitDepth: 8,
      height: 9,
      samples: confidence,
      width: 16,
    }),
    depth,
    depthPng: await encodePng({ height: 9, samples: depth, width: 16 }),
  };
}

/** A fake server: URL to body, 404 for anything else. */
function fakeFetch(routes: Record<string, unknown>) {
  return vi.fn(async (url: string | URL | Request) => {
    const body = routes[String(url)];

    if (body === undefined) {
      return new Response(null, { status: 404, statusText: "Not Found" });
    }

    return new Response(
      body instanceof Uint8Array
        ? (body as BufferSource)
        : JSON.stringify(body),
    );
  }) as unknown as typeof globalThis.fetch & ReturnType<typeof vi.fn>;
}

function mainThreadPreparer() {
  const preparer = createDepthFramePreparer({
    mode: RenderPreparationMode.MainThread,
  });

  return () => preparer;
}

describe("depth source", () => {
  it("answers every media time with a still map", async () => {
    const map = depthMap(64, 36);
    const source = await openDepthSource({ map }, { media: MEDIA });

    expect(source.getEntry(0)).toEqual({
      frameIndex: null,
      map,
      precision: "exact",
    });
    expect(source.getEntry(12.5)?.map).toBe(map);
  });

  it("accepts a map within 1 % of the media's aspect ratio", async () => {
    await expect(
      openDepthSource({ map: depthMap(640, 362) }, { media: MEDIA }),
    ).resolves.toBeDefined();
  });

  it("rejects a map of another shape than the media", async () => {
    await expect(
      openDepthSource({ map: depthMap(640, 480) }, { media: MEDIA }),
    ).rejects.toThrow(
      new RangeError(
        "Depth map 640x480 does not have the aspect ratio of the 1280x720 media.",
      ),
    );
  });

  it("rejects input without exactly one of a map or a manifest", () => {
    expect(() => validateDepthInput({} as never)).toThrow(
      "Depth input needs either a map or a manifest.",
    );
    expect(() =>
      validateDepthInput({
        manifest: "depth.json",
        map: depthMap(4, 4),
      } as never),
    ).toThrow("Depth input needs either a map or a manifest.");
    expect(() => validateDepthInput({ manifest: 12 } as never)).toThrow(
      "Depth manifest must be a URL or a parsed depth manifest.",
    );
    expect(() =>
      validateDepthInput({ map: { ...depthMap(4, 4), width: 3 } }),
    ).toThrow("DepthMap samples.values has 16 values for 3x4 pixels.");
  });
});

describe("depth source from an image manifest", () => {
  it("loads the depth and confidence PNGs a depth.json names, relative to it", async () => {
    const { confidence, confidencePng, depth, depthPng } = await files();
    const fetch = fakeFetch({
      "https://example.test/clips/a/confidence.png": confidencePng,
      "https://example.test/clips/a/depth.json": wireManifest(),
      "https://example.test/clips/a/depth.png": depthPng,
    });

    const source = await openDepthSource(
      { manifest: "https://example.test/clips/a/depth.json" },
      {
        fetch,
        media: { height: 180, width: 320 },
        preparer: mainThreadPreparer(),
      },
    );
    const map = source.getEntry(3)!.map;

    expect(map).toMatchObject({
      camera: { baselineM: 0.12, fxPx: 1000 },
      displayRange: { max: 60, min: 2 },
      height: 9,
      kind: "disparity_px",
      samples: { encoding: "scaled16", scale: 256 },
      view: "left",
      width: 16,
    });
    expect(map.samples.values).toEqual(depth);
    expect(map.confidence).toEqual(confidence);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("resolves a parsed manifest's files against baseUrl", async () => {
    const { depthPng } = await files();
    const fetch = fakeFetch({
      "https://cdn.test/depth/depth.png": depthPng,
    });

    const source = await openDepthSource(
      {
        baseUrl: "https://cdn.test/depth/",
        manifest: parseDepthManifest(
          wireManifest({ image: { file: "depth.png" } }),
        ),
      },
      {
        fetch,
        media: { height: 9, width: 16 },
        preparer: mainThreadPreparer(),
      },
    );

    expect(source.getEntry(0)!.map.confidence).toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      "https://cdn.test/depth/depth.png",
      expect.anything(),
    );
  });

  it("keeps padded rows prepared while decoding for WebGL", async () => {
    const samples = Uint16Array.from({ length: 5 * 3 }, (_, i) => i + 1);
    const fetch = fakeFetch({
      "https://example.test/depth.json": wireManifest({
        height: 3,
        image: { file: "depth.png" },
        width: 5,
      }),
      "https://example.test/depth.png": await encodePng({
        height: 3,
        samples,
        width: 5,
      }),
    });

    const source = await openDepthSource(
      { manifest: "https://example.test/depth.json" },
      {
        fetch,
        media: { height: 3, width: 5 },
        padRowsForWebGl: true,
        preparer: mainThreadPreparer(),
      },
    );
    const map = source.getEntry(0)!.map;
    const upload = createDepthMapUpload(map, false);

    expect(upload.textureWidth).toBe(6);
    // The ring takes the decoder's padded rows instead of copying again.
    expect(upload.bytes.buffer).not.toBe(
      (map.samples.values as Uint16Array).buffer,
    );
    expect(Array.from(new Uint16Array(upload.bytes.buffer, 0, 6))).toEqual([
      1, 2, 3, 4, 5, 0,
    ]);
  });

  it("names the manifest field a bad depth.json gets wrong", async () => {
    const fetch = fakeFetch({
      "https://example.test/depth.json": wireManifest({
        storage: { format: "png16", no_depth: 0, scale: -1 },
      }),
    });

    await expect(
      openDepthSource(
        { manifest: "https://example.test/depth.json" },
        { fetch, media: MEDIA, preparer: mainThreadPreparer() },
      ),
    ).rejects.toThrow(
      new RangeError("depth.json: storage.scale must be a positive number"),
    );
  });

  it("reports a missing file with its URL", async () => {
    const fetch = fakeFetch({
      "https://example.test/depth.json": wireManifest(),
    });

    await expect(
      openDepthSource(
        { manifest: "https://example.test/depth.json" },
        { fetch, media: MEDIA, preparer: mainThreadPreparer() },
      ),
    ).rejects.toThrow(
      "Unable to load depth image https://example.test/depth.png: 404 Not Found",
    );
  });

  it("refuses a PNG whose size is not the manifest's", async () => {
    const fetch = fakeFetch({
      "https://example.test/depth.json": wireManifest({
        image: { file: "depth.png" },
      }),
      "https://example.test/depth.png": await encodePng({
        height: 2,
        samples: [1, 2, 3, 4],
        width: 2,
      }),
    });

    await expect(
      openDepthSource(
        { manifest: "https://example.test/depth.json" },
        { fetch, media: MEDIA, preparer: mainThreadPreparer() },
      ),
    ).rejects.toThrow("depth.png is 2x2, but depth.json says 16x9.");
  });

  it("refuses an object that is not a parsed manifest", async () => {
    await expect(
      openDepthSource(
        { manifest: wireManifest() as never },
        { media: MEDIA, preparer: mainThreadPreparer() },
      ),
    ).rejects.toThrow(
      "A depth manifest object must come from parseDepthManifest; pass the depth.json URL to have it parsed.",
    );
  });
});

/** Ten one-second frames on the media's timeline, like the engine's clock. */
const CLOCK = {
  duration: 10,
  durationAt: () => 1,
  endTimestamp: 10,
  firstTimestamp: 0,
  frameCount: 10,
  indexAtOrBefore: (time: number) => Math.min(9, Math.max(0, Math.floor(time))),
  timeAt: (index: number) => index,
};

const CLIP_WIDTH = 16;
const CLIP_HEIGHT = 9;
const CLIP_FRAME_BYTES = CLIP_WIDTH * CLIP_HEIGHT * 2;

/**
 * A clip server whose frame PNGs are two bytes, the frame index, and a
 * decoder that fills a map with that index times 256: every map says which
 * file it came from, and nothing waits on real inflate.
 */
function clipServer(
  frames: Record<string, unknown> = {},
  count = CLOCK.frameCount,
) {
  const routes: Record<string, unknown> = {
    "https://example.test/clip/depth.json": wireManifest({
      frames: { count, exact: "exact/{index:06}.png", ...frames },
      image: undefined,
    }),
  };

  for (let index = 0; index < count; index += 1) {
    routes[
      `https://example.test/clip/exact/${String(index).padStart(6, "0")}.png`
    ] = Uint8Array.of(index & 0xff, index >> 8);
  }

  const fetch = fakeFetch(routes);
  const decodeDepth = vi.fn(async (bytes: ArrayBuffer) => {
    const [low, high] = new Uint8Array(bytes);

    return {
      height: CLIP_HEIGHT,
      values: new Uint16Array(CLIP_WIDTH * CLIP_HEIGHT).fill(
        (low + 256 * high) * 256,
      ),
      width: CLIP_WIDTH,
    };
  });
  const preparer = {
    decodeConfidence: vi.fn(),
    decodeDepth,
    destroy: vi.fn(),
  } as unknown as DepthFramePreparer;
  const fetchedFrames = () =>
    fetch.mock.calls
      .map(([url]) => /exact\/(\d+)\.png$/.exec(String(url))?.[1])
      .filter((index): index is string => index !== undefined)
      .map(Number);

  return { fetch, fetchedFrames, preparer: () => preparer };
}

async function openClip(
  server: ReturnType<typeof clipServer>,
  depth: RenderPreparationDepthOptions = {},
) {
  return openDepthSource(
    { manifest: "https://example.test/clip/depth.json" },
    {
      depth: { exactSettleSeconds: 0, ...depth },
      fetch: server.fetch,
      frameClock: CLOCK,
      media: MEDIA,
      preparer: server.preparer,
    },
  );
}

/** The frame index a drawn map was decoded from. */
function drawnFrame(source: DepthFrameProvider, mediaTime: number) {
  const entry = source.getEntry(mediaTime);

  return entry === null
    ? null
    : { frameIndex: entry.frameIndex, file: entry.map.samples.values[0] / 256 };
}

describe("depth source from a clip manifest", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses a clip on media without a frame index, saying why", async () => {
    const server = clipServer();
    const open = (reason?: string) =>
      openDepthSource(
        { manifest: "https://example.test/clip/depth.json" },
        {
          fetch: server.fetch,
          frameClockUnavailableReason: reason,
          media: MEDIA,
          preparer: server.preparer,
        },
      );

    await expect(open()).rejects.toThrow(
      new RangeError(
        "depth.json describes a clip (frames), and the media has no frame index to pair them with: open the video by URL or Blob, or pass createWebVideoEngineMediaRendererSource() as the media.",
      ),
    );
    await expect(open("a live stream has no end.")).rejects.toThrow(
      new RangeError(
        "depth.json describes a clip (frames), and the media has no frame index to pair them with: a live stream has no end.",
      ),
    );
  });

  it("reads the media's frame index when a clip asks, for media that does not keep one", async () => {
    const server = clipServer();
    const readFrameClock = vi.fn(async () => CLOCK);
    const source = await openDepthSource(
      { manifest: "https://example.test/clip/depth.json" },
      {
        fetch: server.fetch,
        media: MEDIA,
        preparer: server.preparer,
        readFrameClock,
      },
    );

    expect(readFrameClock).toHaveBeenCalledOnce();
    expect(source.getFrameStatus?.(CLOCK.timeAt(4))?.frameIndex).toBe(4);
    source.destroy();
  });

  it("refuses a clip whose frame count is not the media's", async () => {
    await expect(openClip(clipServer({}, 9))).rejects.toThrow(
      "depth.json has 9 frames and the media has 10; give frames.times_s when depth covers only some of the video's frames.",
    );
  });

  it("fetches the frame on screen once playback has rested, then asks for one redraw", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const server = clipServer();
    const source = await openClip(server, { exactSettleSeconds: 0.15 });
    const redraw = vi.fn();

    source.subscribe?.(redraw);
    expect(source.getEntry(3.2)).toBeNull();
    await vi.advanceTimersByTimeAsync(149);
    expect(server.fetchedFrames()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(redraw).toHaveBeenCalledTimes(1));
    expect(drawnFrame(source, 3.2)).toEqual({ file: 3, frameIndex: 3 });
    expect(source.getEntry(3.2)).toMatchObject({ precision: "exact" });

    source.destroy();
  });

  it("fetches the neighbours after the frame on screen, nearest first", async () => {
    const server = clipServer();
    const source = await openClip(server);

    source.getEntry(5);
    await vi.waitFor(() => expect(server.fetchedFrames()).toHaveLength(5));
    expect(server.fetchedFrames()).toEqual([5, 6, 4, 7, 3]);

    // A step lands on a neighbour already decoded: its depth shows at once.
    expect(drawnFrame(source, 6)).toEqual({ file: 6, frameIndex: 6 });

    source.destroy();
  });

  it("loads as many frames at once as the decode pool has workers, nearest first", async () => {
    const server = clipServer();
    const gate = createGate();
    const preparer = server.preparer();
    let inFlight = 0;
    let most = 0;

    Object.assign(preparer, { concurrency: 3 });
    vi.mocked(preparer.decodeDepth).mockImplementation(async (bytes) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await gate.promise;
      inFlight -= 1;
      return {
        height: CLIP_HEIGHT,
        values: new Uint16Array(CLIP_WIDTH * CLIP_HEIGHT).fill(
          new Uint8Array(bytes)[0] * 256,
        ),
        width: CLIP_WIDTH,
      };
    });
    const source = await openClip(server);

    source.getEntry(5);
    await vi.waitFor(() => expect(server.fetchedFrames()).toEqual([5, 6, 4]));
    gate.resolve();
    await vi.waitFor(() => expect(server.fetchedFrames()).toHaveLength(5));
    expect(server.fetchedFrames()).toEqual([5, 6, 4, 7, 3]);
    expect(most).toBe(3);

    source.destroy();
  });

  it("asks the decoder for depth decimated to the box it is shown in", async () => {
    const server = clipServer();
    const source = await openDepthSource(
      { manifest: "https://example.test/clip/depth.json" },
      {
        display: {
          boxHeight: MEDIA.height / 4,
          boxWidth: MEDIA.width / 4,
          devicePixelRatio: 1,
        },
        depth: { exactSettleSeconds: 0 },
        fetch: server.fetch,
        frameClock: CLOCK,
        // A box that shows the picture larger than the 16x9 map asks for none.
        media: { height: 36, width: 64 },
        preparer: server.preparer,
      },
    );

    source.getEntry(2);
    await vi.waitFor(() =>
      expect(server.preparer().decodeDepth).toHaveBeenCalled(),
    );
    expect(
      vi.mocked(server.preparer().decodeDepth).mock.calls[0]?.[1],
    ).toMatchObject({ decimateBy: 1 });
    source.destroy();

    const halved = await openDepthSource(
      { manifest: "https://example.test/clip/depth.json" },
      {
        // At half a pixel a CSS pixel, a 16x9 box shows 8x4.5 of the map.
        display: { boxHeight: 9, boxWidth: 16, devicePixelRatio: 0.5 },
        depth: { exactSettleSeconds: 0 },
        fetch: server.fetch,
        frameClock: CLOCK,
        media: { height: 9, width: 16 },
        preparer: server.preparer,
      },
    );

    halved.getEntry(3);
    await vi.waitFor(() =>
      expect(
        vi.mocked(server.preparer().decodeDepth).mock.calls.at(-1)?.[1],
      ).toMatchObject({ decimateBy: 2 }),
    );
    halved.destroy();
  });

  it("stays within the clip at its ends", async () => {
    const server = clipServer();
    const source = await openClip(server);

    source.getEntry(0);
    await vi.waitFor(() => expect(server.fetchedFrames()).toHaveLength(3));
    expect(server.fetchedFrames()).toEqual([0, 1, 2]);

    source.destroy();
  });

  it("draws nothing while the preview plays and there is none, even a frame it holds", async () => {
    const server = clipServer();
    const source = await openClip(server, { playback: "preview" });
    const redraw = vi.fn();

    source.subscribe?.(redraw);
    source.getEntry(2);
    await vi.waitFor(() => expect(drawnFrame(source, 2)).not.toBeNull());

    source.setPlaybackActive?.(true);
    expect(redraw).toHaveBeenCalled();
    expect(source.getEntry(2)).toBeNull();
    expect(source.getEntry(3)).toBeNull();

    // Frame 3 was fetched as a neighbour; resting there shows it again.
    source.setPlaybackActive?.(false);
    expect(drawnFrame(source, 3)).toEqual({ file: 3, frameIndex: 3 });

    source.destroy();
  });

  it("fetches nothing while the preview plays", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const server = clipServer();
    const source = await openClip(server, {
      exactSettleSeconds: 0.15,
      playback: "preview",
    });

    source.setPlaybackActive?.(true);
    for (let time = 0; time < 5; time += 1) source.getEntry(time);
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.fetchedFrames()).toEqual([]);

    source.setPlaybackActive?.(false);
    await vi.advanceTimersByTimeAsync(150);
    await vi.waitFor(() => expect(server.fetchedFrames()[0]).toBe(4));

    source.destroy();
  });

  it("stops the neighbours not yet asked for when the frame on screen moves, and loads the way it moved first", async () => {
    const server = clipServer();
    const gate = createGate();
    const decode = server.preparer().decodeDepth;

    vi.mocked(decode).mockImplementationOnce(async (bytes) => {
      await gate.promise;
      return {
        height: CLIP_HEIGHT,
        values: new Uint16Array(CLIP_WIDTH * CLIP_HEIGHT).fill(
          new Uint8Array(bytes)[0] * 256,
        ),
        width: CLIP_WIDTH,
      };
    });
    const source = await openClip(server);

    source.getEntry(5);
    await vi.waitFor(() => expect(server.fetchedFrames()).toEqual([5]));
    source.getEntry(8);
    gate.resolve();

    await vi.waitFor(() =>
      expect(drawnFrame(source, 8)).toEqual({ file: 8, frameIndex: 8 }),
    );
    await vi.waitFor(() => expect(server.fetchedFrames()).toHaveLength(4));
    // Frame 5 was in flight and is kept; 6, 4 and 3 were never asked for.
    // The frame moved forward, so three of 8's four neighbours lie ahead of
    // it, and the two past the clip's last frame are skipped.
    expect(server.fetchedFrames()).toEqual([5, 8, 9, 7]);
    expect(drawnFrame(source, 5)).toEqual({ file: 5, frameIndex: 5 });

    source.destroy();
  });

  it("keeps frames up to its byte budget, dropping the farthest first", async () => {
    const server = clipServer();
    const source = await openClip(server, {
      exactNeighborFrameCount: 1,
      maxExactCacheBytes: 3 * CLIP_FRAME_BYTES,
    });

    source.getEntry(2);
    await vi.waitFor(() => expect(server.fetchedFrames()).toHaveLength(3));
    source.getEntry(3);
    await vi.waitFor(() => expect(server.fetchedFrames()).toHaveLength(5));

    // A step forward loads both neighbours ahead of 3. Of 1 to 5, the frames
    // two away from 3 were dropped as the others landed.
    expect(server.fetchedFrames()).toEqual([2, 3, 1, 4, 5]);
    expect(drawnFrame(source, 4)).not.toBeNull();
    source.getEntry(3);
    expect(drawnFrame(source, 2)).not.toBeNull();
    expect(source.getEntry(1)).toBeNull();

    source.destroy();
  });

  it("pairs depth frames with media times through times_s", async () => {
    const server = clipServer({ times_s: [0.5, 2, 6] }, 3);
    const source = await openClip(server, { exactNeighborFrameCount: 0 });

    expect(source.getEntry(0.25)).toBeNull();

    // Frame 1 covers [2, 6): the video frames in between keep it.
    source.getEntry(4.5);
    await vi.waitFor(() =>
      expect(drawnFrame(source, 4.5)).toEqual({ file: 1, frameIndex: 1 }),
    );
    expect(drawnFrame(source, 2 - 0.0004)).toEqual({ file: 1, frameIndex: 1 });

    source.destroy();
  });

  it("warns once and draws nothing over a frame that does not load", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const server = clipServer();

    vi.mocked(server.preparer().decodeDepth).mockRejectedValue(
      new Error("corrupt PNG"),
    );
    const source = await openClip(server);

    source.getEntry(4);
    await vi.waitFor(() => expect(server.fetchedFrames()).toHaveLength(5));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn.mock.calls[0][0]).toContain(
      "Depth frame 4 did not load, so no depth is drawn over it",
    );
    expect(source.getEntry(4)).toBeNull();

    warn.mockRestore();
    source.destroy();
  });
});

function createGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

describe("resolveUrl", () => {
  it("resolves files against an absolute base, and leaves blob URLs whole", () => {
    expect(resolveUrl("depth.png", "https://a.test/x/depth.json")).toBe(
      "https://a.test/x/depth.png",
    );
    expect(resolveUrl("../d.png", new URL("https://a.test/x/y/"))).toBe(
      "https://a.test/x/d.png",
    );
    expect(
      resolveUrl("blob:https://a.test/0a1b", "https://a.test/x/depth.json"),
    ).toBe("blob:https://a.test/0a1b");
  });

  it("joins by path when neither the base nor the page is absolute", () => {
    expect(resolveUrl("depth.png", "clips/a/depth.json")).toBe(
      "clips/a/depth.png",
    );
    expect(resolveUrl("/depth.png", "clips/a/depth.json")).toBe("/depth.png");
  });
});
