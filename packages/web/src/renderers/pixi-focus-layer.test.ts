import { afterEach, describe, expect, it, vi } from "vitest";

import { PreparedMaskFrameKind } from "#render-preparation/mask-frame-artifact";
import { createPixiFocusLayer } from "#renderers/pixi-focus-layer";
import { BaseFocusStyle } from "supervision-js-core";
import { BoxShape } from "supervision-js-core";
import { encodeCompressedRleCounts } from "supervision-js-core";
import { FocusTargetMode } from "supervision-js-core";
import {
  DetectionMaskEncoding,
  type DetectionFrame,
} from "supervision-js-core";
import { DetectionPickTarget } from "supervision-js-core";

const frame: DetectionFrame = {
  detections: [
    {
      className: "player",
      id: "player-1",
      rect: { height: 30, width: 20, x: 20, y: 30 },
    },
  ],
  frameIndex: 3,
  mediaTime: 0.1,
};

const maskFrame: DetectionFrame = {
  detections: [
    {
      className: "player",
      id: "player-1",
      mask: {
        counts: "04",
        encoding: DetectionMaskEncoding.CompressedRle,
        height: 80,
        width: 120,
      },
      rect: { height: 30, width: 20, x: 20, y: 30 },
    },
  ],
  frameIndex: 3,
  mediaTime: 0.1,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pixi focus layer", () => {
  it("draws a dim overlay with vector cutouts for selected detections", () => {
    const selectedPick = {
      detection: frame.detections[0]!,
      detectionIndex: 0,
      frame,
      mediaTime: frame.mediaTime,
      point: { x: 15, y: 20 },
      target: DetectionPickTarget.Box,
    };
    const layer = createPixiFocusLayer({
      Graphics: FakeGraphics as never,
      focusStyle: new BaseFocusStyle({
        cornerRadius: 6,
        fill: { alpha: 0.5, color: 0x000000 },
        shape: BoxShape.RoundedRect,
      }),
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeGraphics;

    layer.drawFrame({
      frame,
      hoveredPick: null,
      mediaTime: frame.mediaTime,
      selectedPick,
    });

    expect(display.rect).toHaveBeenCalledWith(0, 0, 120, 80);
    expect(display.fill).toHaveBeenCalledWith({
      alpha: 0.5,
      color: 0x000000,
    });
    expect(display.roundRect).toHaveBeenCalledWith(10, 15, 20, 30, 6);
    expect(display.cut).toHaveBeenCalledOnce();
  });

  it("uses an inverse stencil mask for overlapping ambient vector cutouts", () => {
    const overlappingFrame: DetectionFrame = {
      detections: [
        frame.detections[0]!,
        {
          className: "player",
          id: "player-2",
          rect: { height: 30, width: 20, x: 25, y: 35 },
        },
      ],
      frameIndex: frame.frameIndex,
      mediaTime: frame.mediaTime,
    };
    const layer = createPixiFocusLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      focusStyle: new BaseFocusStyle({
        cornerRadius: 6,
        fill: { alpha: 0.5, color: 0x000000 },
        shape: BoxShape.RoundedRect,
        targetMode: FocusTargetMode.Ambient,
      }),
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;
    const overlay = display.children[0] as FakeGraphics;
    const mask = display.children[1] as FakeGraphics;

    layer.drawFrame({
      frame: overlappingFrame,
      hoveredPick: null,
      mediaTime: overlappingFrame.mediaTime,
      selectedPick: null,
    });

    expect(overlay.setMask).toHaveBeenCalledWith({
      inverse: true,
      mask,
    });
    expect(mask.roundRect).toHaveBeenCalledTimes(2);
    expect(mask.roundRect).toHaveBeenNthCalledWith(1, 10, 15, 20, 30, 6);
    expect(mask.roundRect).toHaveBeenNthCalledWith(2, 15, 20, 20, 30, 6);
    expect(mask.fill).toHaveBeenCalledTimes(2);
    expect(overlay.cut).not.toHaveBeenCalled();
  });

  it("clears and stays hidden when there is no focus target", () => {
    const layer = createPixiFocusLayer({
      Graphics: FakeGraphics as never,
      focusStyle: new BaseFocusStyle(),
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeGraphics;

    layer.drawFrame({
      frame,
      hoveredPick: null,
      mediaTime: frame.mediaTime,
      selectedPick: null,
    });

    expect(display.clear).toHaveBeenCalledOnce();
    expect(display.visible).toBe(false);
    expect(display.fill).not.toHaveBeenCalled();
  });

  it("uses ID-mask focus for masked detections even when the pick target is a box", () => {
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({ height: 0, width: 0 })),
    });

    const selectedPick = {
      detection: maskFrame.detections[0]!,
      detectionIndex: 0,
      frame: maskFrame,
      mediaTime: maskFrame.mediaTime,
      point: { x: 15, y: 20 },
      target: DetectionPickTarget.Box,
    };
    const layer = createPixiFocusLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      ImageSource: FakeImageSource as never,
      Mesh: FakeMesh as never,
      MeshGeometry: FakeMeshGeometry as never,
      Shader: FakeShaderFactory as never,
      UniformGroup: FakeUniformGroup as never,
      focusStyle: new BaseFocusStyle({
        fill: { alpha: 0.5, color: 0x000000 },
      }),
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;
    const mesh = display.children[0] as FakeMesh;
    const graphics = display.children[1] as FakeGraphics;
    const textureSource = new FakeImageSource({
      dynamic: false,
      height: 80,
      resource: {},
      width: 120,
    });

    layer.drawFrame({
      frame: maskFrame,
      hoveredPick: null,
      idMaskArtifact: {
        frame: {
          close: vi.fn(),
          fillPalette: new Float32Array(),
          hasStroke: false,
          height: 80,
          key: "mask-frame",
          kind: PreparedMaskFrameKind.PngIdMask,
          maxStrokeWidth: 0,
          png: new Uint8Array(),
          source: {} as ImageBitmap,
          strokePalette: new Float32Array(),
          strokeWidths: new Float32Array(),
          width: 120,
        },
        texture: {
          source: textureSource,
        } as never,
      },
      mediaTime: maskFrame.mediaTime,
      selectedPick,
    });

    expect(mesh.visible).toBe(true);
    expect(mesh.shader.resources.uTexture).toBe(textureSource);
    expect(graphics.visible).toBe(false);
    expect(graphics.fill).not.toHaveBeenCalled();
  });

  it("uses a bounds cutout for an unreadable mask when an ID-mask artifact is unavailable", () => {
    const unreadableMaskFrame: DetectionFrame = {
      ...maskFrame,
      detections: [
        {
          ...maskFrame.detections[0]!,
          mask: {
            ...maskFrame.detections[0]!.mask!,
            width: 0,
          },
        },
      ],
    };
    const selectedPick = {
      detection: unreadableMaskFrame.detections[0]!,
      detectionIndex: 0,
      frame: unreadableMaskFrame,
      mediaTime: unreadableMaskFrame.mediaTime,
      point: { x: 15, y: 20 },
      target: DetectionPickTarget.Mask,
    };
    const layer = createPixiFocusLayer({
      Graphics: FakeGraphics as never,
      focusStyle: new BaseFocusStyle({
        cornerRadius: 6,
        fill: { alpha: 0.5, color: 0x000000 },
        shape: BoxShape.RoundedRect,
      }),
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeGraphics;

    layer.drawFrame({
      frame: unreadableMaskFrame,
      hoveredPick: null,
      mediaTime: unreadableMaskFrame.mediaTime,
      selectedPick,
    });

    expect(display.roundRect).toHaveBeenCalledOnce();
    expect(display.roundRect).toHaveBeenCalledWith(10, 15, 20, 30, 6);
    expect(display.cut).toHaveBeenCalledOnce();
  });

  it("uses the semantic mask shape when an ID-mask artifact is unavailable", () => {
    const semanticMaskFrame: DetectionFrame = {
      detections: [
        {
          className: "player",
          id: "player-1",
          mask: {
            counts: encodeCompressedRleCounts([4, 2, 3, 2, 5]),
            encoding: DetectionMaskEncoding.CompressedRle,
            height: 4,
            width: 4,
          },
          rect: { height: 30, width: 20, x: 20, y: 30 },
        },
      ],
      frameIndex: 3,
      mediaTime: 0.1,
    };
    const selectedPick = {
      detection: semanticMaskFrame.detections[0]!,
      detectionIndex: 0,
      frame: semanticMaskFrame,
      mediaTime: semanticMaskFrame.mediaTime,
      point: { x: 15, y: 20 },
      target: DetectionPickTarget.Mask,
    };
    const layer = createPixiFocusLayer({
      Graphics: FakeGraphics as never,
      focusStyle: new BaseFocusStyle({
        cornerRadius: 6,
        fill: { alpha: 0.5, color: 0x000000 },
        shape: BoxShape.RoundedRect,
      }),
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeGraphics;

    layer.drawFrame({
      frame: semanticMaskFrame,
      hoveredPick: null,
      mediaTime: semanticMaskFrame.mediaTime,
      selectedPick,
    });

    expect(display.roundRect).not.toHaveBeenCalled();
    expect(display.rect).toHaveBeenNthCalledWith(1, 0, 0, 120, 80);
    expect(display.rect).toHaveBeenCalledWith(30, 0, 30, 20);
    expect(display.rect).toHaveBeenCalledWith(30, 20, 60, 20);
    expect(display.rect).toHaveBeenCalledWith(60, 40, 30, 20);
    expect(display.cut).toHaveBeenCalledOnce();
  });

  it("does not fall back to bounds for a readable empty mask", () => {
    const emptyMaskFrame: DetectionFrame = {
      detections: [
        {
          className: "player",
          id: "player-1",
          mask: {
            counts: encodeCompressedRleCounts([16]),
            encoding: DetectionMaskEncoding.CompressedRle,
            height: 4,
            width: 4,
          },
          rect: { height: 30, width: 20, x: 20, y: 30 },
        },
      ],
      frameIndex: 3,
      mediaTime: 0.1,
    };
    const selectedPick = {
      detection: emptyMaskFrame.detections[0]!,
      detectionIndex: 0,
      frame: emptyMaskFrame,
      mediaTime: emptyMaskFrame.mediaTime,
      point: { x: 15, y: 20 },
      target: DetectionPickTarget.Mask,
    };
    const layer = createPixiFocusLayer({
      Graphics: FakeGraphics as never,
      focusStyle: new BaseFocusStyle({
        cornerRadius: 6,
        fill: { alpha: 0.5, color: 0x000000 },
        shape: BoxShape.RoundedRect,
      }),
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeGraphics;

    layer.drawFrame({
      frame: emptyMaskFrame,
      hoveredPick: null,
      mediaTime: emptyMaskFrame.mediaTime,
      selectedPick,
    });

    expect(display.roundRect).not.toHaveBeenCalled();
    expect(display.rect).toHaveBeenCalledOnce();
    expect(display.rect).toHaveBeenCalledWith(0, 0, 120, 80);
    expect(display.cut).not.toHaveBeenCalled();
  });
});

class FakeGraphics {
  alpha = 1;
  visible = true;
  readonly clear = vi.fn(() => this);
  readonly cut = vi.fn(() => this);
  readonly fill = vi.fn(() => this);
  readonly poly = vi.fn(() => this);
  readonly rect = vi.fn(() => this);
  readonly roundRect = vi.fn(() => this);
  readonly setMask = vi.fn(() => this);
}

class FakeContainer {
  readonly children: unknown[] = [];

  addChild(...children: unknown[]) {
    this.children.push(...children);
  }
}

class FakeImageSource {
  readonly style = {};

  constructor(readonly _options: unknown) {}

  readonly destroy = vi.fn();
}

class FakeMeshGeometry {
  constructor(readonly _options: unknown) {}

  readonly destroy = vi.fn();
}

class FakeShader {
  constructor(readonly resources: Record<string, unknown>) {}

  readonly destroy = vi.fn();
}

class FakeShaderFactory {
  static from(options: { readonly resources: Record<string, unknown> }) {
    return new FakeShader(options.resources);
  }
}

class FakeUniformGroup {
  constructor(readonly uniforms: Record<string, unknown>) {}

  readonly update = vi.fn();
}

class FakeMesh {
  visible = true;

  constructor(
    readonly options: {
      readonly geometry: FakeMeshGeometry;
      readonly shader: FakeShader;
    },
  ) {}

  get shader() {
    return this.options.shader;
  }

  set shader(_shader: FakeShader) {}

  readonly destroy = vi.fn();
}
