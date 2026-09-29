import { afterEach, describe, expect, it, vi } from "vitest";
import {
  annotationRenderers,
  type BufferedDetectionTimeline,
  type DetectionFrame,
} from "supervision-js-core";
import { createPixiHeatmapLayer } from "./pixi-heatmap-layer";

afterEach(() => vi.unstubAllGlobals());

describe("pixi heatmap layer", () => {
  it("draws overlapping maps in detection z order", () => {
    vi.stubGlobal("document", {
      createElement: () => ({
        getContext: () => ({
          createImageData: () => ({ data: new Uint8ClampedArray(4) }),
          putImageData: vi.fn(),
        }),
        height: 0,
        width: 0,
      }),
    });
    const map = {
      bounds: { x: 1, y: 1, width: 2, height: 2 },
      width: 1,
      height: 1,
      values: [0.8],
    };
    const frame: DetectionFrame = {
      mediaTime: 0,
      detections: [
        {
          id: "high",
          className: "high",
          heatmap: { ...map, bounds: { ...map.bounds, x: 2 } },
          zIndex: 10,
        },
        { id: "low", className: "low", heatmap: map, zIndex: 0 },
      ],
    };
    const layer = createPixiHeatmapLayer({
      CanvasSource: FakeCanvasSource as never,
      Container: FakeContainer as never,
      Sprite: FakeSprite as never,
      Texture: FakeTexture as never,
      detectionTimeline: {
        selectFrame: () => frame,
        getBufferedFrames: () => [frame],
      } as unknown as BufferedDetectionTimeline,
      isVisible: () => true,
      renderers: [annotationRenderers.heatmap()],
    });
    const container = layer.createContainer() as unknown as FakeContainer;

    layer.drawFrame(0);

    expect(container.children.map((child) => child.x)).toEqual([0, 1]);
    expect(layer.translateDetection("high", 5, -2)).toBe(true);
    expect(container.children.map((child) => [child.x, child.y])).toEqual([
      [0, 0],
      [6, -2],
    ]);
    layer.translateDetection("high", 0, 0);
    expect(container.children[1]?.x).toBe(1);
    layer.destroy();
  });

  it("skips a malformed map before canvas allocation and draws the next one", () => {
    const createImageData = vi.fn((width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
    }));
    const createElement = vi.fn(() => ({
      getContext: () => ({ createImageData, putImageData: vi.fn() }),
      height: 0,
      width: 0,
    }));
    vi.stubGlobal("document", { createElement });
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const frame: DetectionFrame = {
      mediaTime: 0,
      detections: [
        {
          heatmap: {
            bounds: { x: 0, y: 0, width: 16_000, height: 16_000 },
            width: 16_000,
            height: 16_000,
            values: [0.5],
          },
        },
        {
          heatmap: {
            bounds: { x: 1, y: 1, width: 2, height: 2 },
            width: 2,
            height: 2,
            values: [0.2, 0.3, 0.4, 0.5],
          },
        },
      ],
    };
    const layer = createPixiHeatmapLayer({
      CanvasSource: FakeCanvasSource as never,
      Container: FakeContainer as never,
      Sprite: FakeSprite as never,
      Texture: FakeTexture as never,
      detectionTimeline: {
        selectFrame: () => frame,
        getBufferedFrames: () => [frame],
      } as unknown as BufferedDetectionTimeline,
      isVisible: () => true,
      renderers: [annotationRenderers.heatmap()],
    });
    const container = layer.createContainer() as unknown as FakeContainer;

    layer.drawFrame(0);

    expect(warning).toHaveBeenCalledOnce();
    expect(createElement).toHaveBeenCalledOnce();
    expect(createImageData).toHaveBeenCalledWith(2, 2);
    expect(container.children).toHaveLength(1);
    warning.mockRestore();
    layer.destroy();
  });

  it("prepares large maps before drawing and reuses their texture", async () => {
    class FakeImageBitmap {
      close = vi.fn();
    }
    vi.stubGlobal("ImageBitmap", FakeImageBitmap);
    const resource = new FakeImageBitmap();
    let finishPreparation!: (value: {
      resource: FakeImageBitmap;
      close(): void;
    }) => void;
    const prepare = vi.fn(
      () =>
        new Promise<{
          resource: FakeImageBitmap;
          close(): void;
        }>((resolve) => {
          finishPreparation = resolve;
        }),
    );
    const onPreparedWindowChange = vi.fn();
    const map = {
      bounds: { x: 128, y: 128, width: 256, height: 256 },
      width: 256,
      height: 256,
      values: new Float32Array(256 * 256),
    };
    const frame: DetectionFrame = {
      mediaTime: 0,
      detections: [{ id: "large", heatmap: map }],
    };
    const layer = createPixiHeatmapLayer({
      CanvasSource: FakeCanvasSource as never,
      Container: FakeContainer as never,
      ImageSource: FakeImageSource as never,
      Sprite: FakeSprite as never,
      Texture: FakeTexture as never,
      detectionTimeline: {
        selectFrame: () => frame,
        getBufferedFrames: () => [frame],
      } as unknown as BufferedDetectionTimeline,
      isVisible: () => true,
      onPreparedWindowChange,
      preparer: { prepare, destroy: vi.fn() } as never,
      renderers: [annotationRenderers.heatmap()],
    });
    const container = layer.createContainer() as unknown as FakeContainer;

    layer.drawFrame(0);
    expect(container.children).toHaveLength(0);
    expect(layer.isArtifactPrepared(0)).toBe(false);
    expect(prepare).toHaveBeenCalledOnce();

    finishPreparation({ resource, close: resource.close });
    await vi.waitFor(() =>
      expect(onPreparedWindowChange).toHaveBeenCalledOnce(),
    );
    expect(layer.isArtifactPrepared(0)).toBe(true);
    layer.drawFrame(0);
    expect(container.children).toHaveLength(1);
    layer.invalidate();
    layer.drawFrame(0);
    expect(prepare).toHaveBeenCalledOnce();
    layer.destroy();
    expect(resource.close).toHaveBeenCalledOnce();
  });

  it("prepares multiple small maps when their total raster is large", () => {
    const prepare = vi.fn(() => new Promise<never>(() => undefined));
    const frame: DetectionFrame = {
      mediaTime: 0,
      detections: Array.from({ length: 5 }, (_, index) => ({
        id: index,
        heatmap: {
          bounds: { x: 0, y: 0, width: 128, height: 128 },
          width: 128,
          height: 128,
          values: new Float32Array(128 * 128),
        },
      })),
    };
    const layer = createPixiHeatmapLayer({
      CanvasSource: FakeCanvasSource as never,
      Container: FakeContainer as never,
      Sprite: FakeSprite as never,
      Texture: FakeTexture as never,
      detectionTimeline: {
        selectFrame: () => frame,
        getBufferedFrames: () => [frame],
      } as unknown as BufferedDetectionTimeline,
      isVisible: () => true,
      preparer: { prepare, destroy: vi.fn() } as never,
      renderers: [annotationRenderers.heatmap()],
    });

    layer.drawFrame(0);

    expect(
      (layer.createContainer() as unknown as FakeContainer).children,
    ).toHaveLength(0);
    expect(layer.isArtifactPrepared(0)).toBe(false);
    expect(prepare).toHaveBeenCalledOnce();
    layer.destroy();
  });

  it("discards a prepared raster after moving to another frame", async () => {
    let finishPreparation!: (image: {
      resource: ImageData;
      close(): void;
    }) => void;
    const prepare = vi.fn(
      () =>
        new Promise<{ resource: ImageData; close(): void }>((resolve) => {
          finishPreparation = resolve;
        }),
    );
    const first: DetectionFrame = {
      mediaTime: 0,
      detections: [
        {
          heatmap: {
            bounds: { x: 0, y: 0, width: 256, height: 256 },
            width: 256,
            height: 256,
            values: new Float32Array(256 * 256),
          },
        },
      ],
    };
    const second: DetectionFrame = { mediaTime: 1, detections: [] };
    let selected = first;
    const onPreparedWindowChange = vi.fn();
    const layer = createPixiHeatmapLayer({
      CanvasSource: FakeCanvasSource as never,
      Container: FakeContainer as never,
      Sprite: FakeSprite as never,
      Texture: FakeTexture as never,
      detectionTimeline: {
        selectFrame: () => selected,
        getBufferedFrames: () => [first, second],
      } as unknown as BufferedDetectionTimeline,
      isVisible: () => true,
      onPreparedWindowChange,
      preparer: { prepare, destroy: vi.fn() } as never,
      renderers: [annotationRenderers.heatmap()],
    });

    layer.drawFrame(0);
    selected = second;
    layer.drawFrame(1);
    const close = vi.fn();
    finishPreparation({ resource: {} as ImageData, close });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(onPreparedWindowChange).not.toHaveBeenCalled();
    layer.destroy();
  });

  it("notifies after each map, even before the frame is fully prepared", async () => {
    class FakeImageBitmap {
      close = vi.fn();
    }
    vi.stubGlobal("ImageBitmap", FakeImageBitmap);
    const complete: Array<
      (value: { resource: FakeImageBitmap; close(): void }) => void
    > = [];
    const prepare = vi.fn(
      () =>
        new Promise<{ resource: FakeImageBitmap; close(): void }>((resolve) => {
          complete.push(resolve);
        }),
    );
    const frame: DetectionFrame = {
      mediaTime: 0,
      detections: [0, 1].map((id) => ({
        id,
        heatmap: {
          bounds: { x: 0, y: 0, width: 256, height: 256 },
          width: 256,
          height: 256,
          values: new Float32Array(256 * 256),
        },
      })),
    };
    const onPreparedWindowChange = vi.fn();
    const layer = createPixiHeatmapLayer({
      CanvasSource: FakeCanvasSource as never,
      Container: FakeContainer as never,
      ImageSource: FakeImageSource as never,
      Sprite: FakeSprite as never,
      Texture: FakeTexture as never,
      detectionTimeline: {
        selectFrame: () => frame,
        getBufferedFrames: () => [frame],
      } as unknown as BufferedDetectionTimeline,
      isVisible: () => true,
      onPreparedWindowChange,
      preparer: { prepare, destroy: vi.fn() } as never,
      renderers: [annotationRenderers.heatmap()],
    });

    layer.drawFrame(0);
    complete[0]({ resource: new FakeImageBitmap(), close: vi.fn() });
    await vi.waitFor(() =>
      expect(onPreparedWindowChange).toHaveBeenCalledOnce(),
    );
    expect(layer.isArtifactPrepared(0)).toBe(false);
    layer.drawFrame(0);
    expect(
      (layer.createContainer() as unknown as FakeContainer).children,
    ).toHaveLength(1);
    layer.destroy();
  });

  it.each([1, 2, 3])(
    "supersedes obsolete work when selecting frame %i",
    (selectedFrame) => {
      const frames: DetectionFrame[] = [0, 1, 2, 3].map((mediaTime) => ({
        mediaTime,
        detections: [
          {
            heatmap: {
              bounds: { x: 0, y: 0, width: 256, height: 256 },
              width: 256,
              height: 256,
              values: new Float32Array(256 * 256),
            },
          },
        ],
      }));
      const preparers = [0, 1].map(() => ({
        prepare: vi.fn(() => new Promise<never>(() => undefined)),
        destroy: vi.fn(),
      }));
      const preparerFactory = vi
        .fn()
        .mockReturnValueOnce(preparers[0])
        .mockReturnValueOnce(preparers[1]);
      const layer = createPixiHeatmapLayer({
        CanvasSource: FakeCanvasSource as never,
        Container: FakeContainer as never,
        Sprite: FakeSprite as never,
        Texture: FakeTexture as never,
        detectionTimeline: {
          selectFrame: (time: number) => frames[time],
          getBufferedFrames: () => frames.slice(0, 3),
        } as unknown as BufferedDetectionTimeline,
        isVisible: () => true,
        preparerFactory,
        renderers: [annotationRenderers.heatmap()],
      });

      layer.drawFrame(0);
      layer.drawFrame(selectedFrame);

      expect(preparers[0].destroy).toHaveBeenCalledOnce();
      expect(preparers[1].prepare).toHaveBeenCalledOnce();
      layer.destroy();
    },
  );
});

class FakeContainer {
  children: FakeSprite[] = [];
  addChild(sprite: FakeSprite) {
    this.children.push(sprite);
    sprite.parent = this;
  }
  destroy() {}
}

class FakeCanvasSource {
  constructor(_options: unknown) {}
}

class FakeImageSource {
  constructor(_options: unknown) {}
}

class FakeTexture {
  constructor(_options: unknown) {}
  destroy(_destroySource?: boolean) {}
}

class FakeSprite {
  parent?: FakeContainer;
  x = 0;
  y = 0;
  width = 0;
  height = 0;
  constructor(readonly options: { texture: FakeTexture }) {}
  get texture() {
    return this.options.texture;
  }
  removeFromParent() {
    if (this.parent) {
      this.parent.children = this.parent.children.filter(
        (child) => child !== this,
      );
    }
  }
  destroy() {}
}
