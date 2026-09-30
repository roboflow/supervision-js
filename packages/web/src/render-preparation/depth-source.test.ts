import { describe, expect, it, vi } from "vitest";

import { parseDepthManifest, type DepthMap } from "supervision-js-core";
import { encodePng } from "../../../../test/depth-png";
import { createDepthMapUpload } from "#renderers/depth-textures";
import { createDepthFramePreparer } from "#render-preparation/depth-frame-preparer";
import {
  openDepthSource,
  resolveUrl,
  validateDepthInput,
} from "#render-preparation/depth-source";
import { RenderPreparationMode } from "#types/render-preparation";

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

  it("refuses a clip manifest for now", async () => {
    const fetch = fakeFetch({
      "https://example.test/depth.json": wireManifest({
        frames: { count: 3, exact: "exact/{index:06}.png" },
        image: undefined,
      }),
    });

    await expect(
      openDepthSource(
        { manifest: "https://example.test/depth.json" },
        { fetch, media: MEDIA, preparer: mainThreadPreparer() },
      ),
    ).rejects.toThrow(
      "depth.json describes a clip; the session draws still depth images only for now.",
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
