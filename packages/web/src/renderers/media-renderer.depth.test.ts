import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  annotationRenderers,
  readDepthAt,
  type DepthMap,
} from "supervision-js-core";

import { encodePng } from "../../../../test/depth-png";
import {
  createDeferred,
  createRenderer,
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

  it("refuses a clip manifest on media without a frame index", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            frames: { count: 3, exact: "exact/{index:06}.png" },
            height: 18,
            kind: "disparity_px",
            schema: "supervision.depth-manifest",
            storage: { format: "png16", no_depth: 0, scale: 256 },
            version: 1,
            width: 32,
          }),
        ),
    );
    const renderer = await createRenderer(false, false, {
      renderers: [annotationRenderers.depth()],
    });

    await expect(
      renderer.setDepth?.({ manifest: "https://example.test/clip/depth.json" }),
    ).rejects.toThrow(
      new RangeError(
        "depth.json describes a clip (frames), which needs a media source with a frame index: pass createWebVideoEngineMediaRendererSource() as the media.",
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
