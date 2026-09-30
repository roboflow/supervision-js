import { beforeEach, describe, expect, it } from "vitest";

import {
  annotationRenderers,
  readDepthAt,
  type DepthMap,
} from "supervision-js-core";

import {
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

describe("media renderer depth", () => {
  beforeEach(() => {
    resetMocks();
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
