import { afterEach, describe, expect, it, vi } from "vitest";
import {
  annotationRenderers,
  type BufferedDetectionTimeline,
  type DetectionFrame,
} from "supervision-js-core";
import { createPixiHeatmapLayer } from "./pixi-heatmap-layer";

afterEach(() => vi.unstubAllGlobals());

describe("pixi heatmap layer", () => {
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
