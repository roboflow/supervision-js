import { afterEach, describe, expect, it, vi } from "vitest";

import { parseDepthManifest, type DepthMap } from "supervision-js-core";
import { encodePng } from "../../../../../test/depth-png";
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

  it("refuses a manifest, a file or an object it cannot draw, saying why", async () => {
    const open = async (routes: Record<string, unknown>, manifest?: never) =>
      openDepthSource(
        { manifest: manifest ?? "https://example.test/depth.json" },
        {
          fetch: fakeFetch(routes),
          media: MEDIA,
          preparer: mainThreadPreparer(),
        },
      );

    await expect(
      open({
        "https://example.test/depth.json": wireManifest({
          storage: { format: "png16", no_depth: 0, scale: -1 },
        }),
      }),
    ).rejects.toThrow(
      new RangeError("depth.json: storage.scale must be a positive number"),
    );
    await expect(
      open({ "https://example.test/depth.json": wireManifest() }),
    ).rejects.toThrow(
      "Unable to load depth image https://example.test/depth.png: 404 Not Found",
    );
    await expect(
      open({
        "https://example.test/depth.json": wireManifest({
          image: { file: "depth.png" },
        }),
        "https://example.test/depth.png": await encodePng({
          height: 2,
          samples: [1, 2, 3, 4],
          width: 2,
        }),
      }),
    ).rejects.toThrow("depth.png is 2x2, but depth.json says 16x9.");
    await expect(open({}, wireManifest() as never)).rejects.toThrow(
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
      depth,
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

  it("fetches the frame on screen once playback has rested, asks for one redraw, then fetches its neighbours nearest first", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const server = clipServer();
    const source = await openClip(server);
    const redraw = vi.fn();

    source.subscribe?.(redraw);
    expect(source.getEntry(5.2)).toBeNull();
    await vi.advanceTimersByTimeAsync(149);
    expect(server.fetchedFrames()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(redraw).toHaveBeenCalledTimes(1));
    expect(drawnFrame(source, 5.2)).toEqual({ file: 5, frameIndex: 5 });
    expect(source.getEntry(5.2)?.map.samples.encoding).toBe("scaled16");

    await vi.waitFor(() => expect(server.fetchedFrames()).toHaveLength(5));
    expect(server.fetchedFrames()).toEqual([5, 6, 4, 7, 3]);
    // A step lands on a neighbour already decoded: its depth shows at once.
    expect(drawnFrame(source, 6)).toEqual({ file: 6, frameIndex: 6 });
    expect(redraw).toHaveBeenCalledTimes(1);

    source.destroy();
  });

  it("draws and fetches nothing while the preview plays and there is none, even a frame it holds", async () => {
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

    // Nothing more is fetched while it plays.
    const fetched = server.fetchedFrames().length;

    for (let time = 4; time < 9; time += 1) source.getEntry(time);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(server.fetchedFrames()).toHaveLength(fetched);
    source.getEntry(3);

    // Frame 3 was fetched as a neighbour; resting there shows it again.
    source.setPlaybackActive?.(false);
    expect(drawnFrame(source, 3)).toEqual({ file: 3, frameIndex: 3 });

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

  it("pairs depth frames with media times through times_s", async () => {
    const server = clipServer({ times_s: [0.5, 2, 6] }, 3);
    const source = await openClip(server);

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
  it("resolves against an absolute base, and joins by path without one", () => {
    expect(resolveUrl("depth.png", "https://a.test/x/depth.json")).toBe(
      "https://a.test/x/depth.png",
    );
    expect(resolveUrl("../d.png", new URL("https://a.test/x/y/"))).toBe(
      "https://a.test/x/d.png",
    );
    expect(
      resolveUrl("blob:https://a.test/0a1b", "https://a.test/x/depth.json"),
    ).toBe("blob:https://a.test/0a1b");
    expect(resolveUrl("depth.png", "clips/a/depth.json")).toBe(
      "clips/a/depth.png",
    );
    expect(resolveUrl("/depth.png", "clips/a/depth.json")).toBe("/depth.png");
  });
});
