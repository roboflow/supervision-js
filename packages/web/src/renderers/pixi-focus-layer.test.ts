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

const polygonFrame: DetectionFrame = {
  detections: [
    {
      className: "player",
      id: "player-1",
      polygon: {
        points: [
          { x: 10, y: 10 },
          { x: 40, y: 10 },
          { x: 40, y: 50 },
        ],
      },
      rect: { height: 30, width: 20, x: 20, y: 30 },
    },
  ],
  frameIndex: 3,
  mediaTime: 0.1,
};

afterEach(() => {
  vi.unstubAllGlobals();
  FakeShaderFactory.descriptors.length = 0;
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

  it("preserves original detection indices while omitting hidden ambient targets", () => {
    const ambientFrame: DetectionFrame = {
      detections: [
        frame.detections[0]!,
        {
          className: "official",
          id: "official-1",
          rect: { height: 10, width: 10, x: 80, y: 40 },
        },
      ],
      frameIndex: frame.frameIndex,
      mediaTime: frame.mediaTime,
    };
    const resolve = vi.fn(
      new BaseFocusStyle({ targetMode: FocusTargetMode.Ambient }).resolve.bind(
        new BaseFocusStyle({ targetMode: FocusTargetMode.Ambient }),
      ),
    );
    const layer = createPixiFocusLayer({
      Graphics: FakeGraphics as never,
      focusStyle: { resolve },
      isDetectionVisible: (detection) => detection.className !== "player",
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeGraphics;

    layer.drawFrame({
      frame: ambientFrame,
      hoveredPick: null,
      mediaTime: ambientFrame.mediaTime,
      selectedPick: null,
    });

    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ frame: ambientFrame }),
    );
    expect(display.roundRect).toHaveBeenCalledWith(75, 35, 10, 10, 8);
    expect(display.roundRect).not.toHaveBeenCalledWith(10, 15, 20, 30, 8);
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

  it("gives the placeholder texture canvas a rendering context", () => {
    const getContext = vi.fn();
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({ getContext, height: 0, width: 0 })),
    });

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

    layer.createDisplay({ height: 80, width: 120 });

    expect(getContext).toHaveBeenCalledWith("2d");
  });

  it("uses ID-mask focus for masked detections even when the pick target is a box", () => {
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        getContext: vi.fn(),
        height: 0,
        width: 0,
      })),
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
          kind: PreparedMaskFrameKind.IdMask,
          maxStrokeWidth: 0,
          raster: new Uint8Array(120 * 80),
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

  it("falls back to vector focus when the shader backend cannot build a program", () => {
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        getContext: vi.fn(),
        height: 0,
        width: 0,
      })),
    });

    const selectedPick = {
      detection: frame.detections[0]!,
      detectionIndex: 0,
      frame,
      mediaTime: frame.mediaTime,
      point: { x: 15, y: 20 },
      target: DetectionPickTarget.Box,
    };
    const layer = createPixiFocusLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      ImageSource: FakeImageSource as never,
      Mesh: FakeMesh as never,
      MeshGeometry: FakeMeshGeometry as never,
      Shader: FailingShaderFactory as never,
      UniformGroup: FakeUniformGroup as never,
      focusStyle: new BaseFocusStyle({
        cornerRadius: 6,
        fill: { alpha: 0.5, color: 0x000000 },
        shape: BoxShape.RoundedRect,
      }),
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;
    const overlay = display.children[0] as FakeGraphics;
    const cutout = display.children[1] as FakeGraphics;

    layer.drawFrame({
      frame,
      hoveredPick: null,
      mediaTime: frame.mediaTime,
      selectedPick,
    });

    expect(display.children).toHaveLength(2);
    expect(overlay.rect).toHaveBeenCalledWith(0, 0, 120, 80);
    expect(cutout.roundRect).toHaveBeenCalledWith(10, 15, 20, 30, 6);
  });

  it("declares a WebGL and a WebGPU program for the focus ID-mask shader", () => {
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        getContext: vi.fn(),
        height: 0,
        width: 0,
      })),
    });

    const layer = createPixiFocusLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      ImageSource: FakeImageSource as never,
      Mesh: FakeMesh as never,
      MeshGeometry: FakeMeshGeometry as never,
      Shader: FakeShaderFactory as never,
      UniformGroup: FakeUniformGroup as never,
    });

    layer.createDisplay({ height: 80, width: 120 });

    const descriptor = FakeShaderFactory.descriptors.at(-1)!;

    expect(descriptor.gl.vertex.length).toBeGreaterThan(0);
    expect(descriptor.gl.fragment.length).toBeGreaterThan(0);
    expect(descriptor.gpu.vertex.entryPoint).toBe("mainVertex");
    expect(descriptor.gpu.fragment.entryPoint).toBe("mainFragment");
    expect(descriptor.gpu.vertex.source).toContain("fn mainVertex(");
    expect(descriptor.gpu.fragment.source).toContain("fn mainFragment(");
  });

  it("samples the ID mask once per fragment and stops the ID scan at the selected count", () => {
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        getContext: vi.fn(),
        height: 0,
        width: 0,
      })),
    });

    const layer = createPixiFocusLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      ImageSource: FakeImageSource as never,
      Mesh: FakeMesh as never,
      MeshGeometry: FakeMeshGeometry as never,
      Shader: FakeShaderFactory as never,
      UniformGroup: FakeUniformGroup as never,
    });

    layer.createDisplay({ height: 80, width: 120 });

    const descriptor = FakeShaderFactory.descriptors.at(-1)!;

    for (const source of [
      descriptor.gl.fragment,
      descriptor.gpu.fragment.source,
    ]) {
      expect(source.match(/sampleMaskId\(vUV\)/g)).toHaveLength(1);
      expect(source).toContain("uSelectedCount");
      expect(source).toContain("break;");
    }
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

  it("keeps the dim overlay on a frame that arrives with nothing to cut", () => {
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
    layer.drawFrame({
      frame: undefined,
      hoveredPick: null,
      mediaTime: frame.mediaTime + 0.5,
      selectedPick: null,
    });

    expect(display.visible).toBe(true);
    expect(display.rect).toHaveBeenCalledTimes(2);
    expect(display.rect).toHaveBeenLastCalledWith(0, 0, 120, 80);
    expect(display.fill).toHaveBeenLastCalledWith({
      alpha: 0.5,
      color: 0x000000,
    });
    expect(display.roundRect).toHaveBeenCalledOnce();
  });

  it("holds a vector cutout across a frame the detections have not caught up with", () => {
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
      focusStyle: new BaseFocusStyle({ fill: { alpha: 0.5, color: 0 } }),
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
    layer.drawFrame({
      frame: undefined,
      hoveredPick: null,
      mediaTime: frame.mediaTime + 0.033,
      selectedPick: null,
    });

    expect(display.visible).toBe(true);
    expect(display.clear).toHaveBeenCalledOnce();
    expect(display.cut).toHaveBeenCalledOnce();
  });

  it("holds an ID-mask cutout across a frame the mask cook has not caught up with", () => {
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        getContext: vi.fn(),
        height: 0,
        width: 0,
      })),
    });

    const { artifact, layer, mesh, textureSource } = createIdMaskFocus();

    layer.drawFrame({
      frame: maskFrame,
      hoveredPick: null,
      idMaskArtifact: artifact,
      mediaTime: maskFrame.mediaTime,
      selectedPick: null,
    });

    const uniforms = mesh.shader.resources.focusUniforms as FakeUniformGroup;
    const updatesAfterDraw = uniforms.update.mock.calls.length;

    layer.drawFrame({
      frame: undefined,
      hoveredPick: null,
      mediaTime: maskFrame.mediaTime + 0.033,
      selectedPick: null,
    });

    expect(mesh.visible).toBe(true);
    expect(mesh.shader.resources.uTexture).toBe(textureSource);
    expect(uniforms.update).toHaveBeenCalledTimes(updatesAfterDraw);
  });

  it("drops a held cutout the media has moved away from, and dims the whole frame", () => {
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        getContext: vi.fn(),
        height: 0,
        width: 0,
      })),
    });

    const { artifact, layer, mesh, textureSource } = createIdMaskFocus();

    layer.drawFrame({
      frame: maskFrame,
      hoveredPick: null,
      idMaskArtifact: artifact,
      mediaTime: maskFrame.mediaTime,
      selectedPick: null,
    });
    layer.drawFrame({
      frame: undefined,
      hoveredPick: null,
      mediaTime: maskFrame.mediaTime + 12,
      selectedPick: null,
    });

    const uniforms = mesh.shader.resources.focusUniforms as FakeUniformGroup;

    expect(mesh.visible).toBe(true);
    expect(mesh.shader.resources.uTexture).not.toBe(textureSource);
    expect(uniforms.uniforms.uSelectedCount).toBe(0);
    expect(uniforms.uniforms.uAmbient).toBe(0);
  });

  it("drops a held cutout whose ID raster has been evicted", () => {
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        getContext: vi.fn(),
        height: 0,
        width: 0,
      })),
    });

    const { artifact, layer, mesh, textureSource } = createIdMaskFocus();

    layer.drawFrame({
      frame: maskFrame,
      hoveredPick: null,
      idMaskArtifact: artifact,
      mediaTime: maskFrame.mediaTime,
      selectedPick: null,
    });

    textureSource.destroyed = true;

    layer.drawFrame({
      frame: undefined,
      hoveredPick: null,
      mediaTime: maskFrame.mediaTime + 0.033,
      selectedPick: null,
    });

    expect(mesh.visible).toBe(true);
    expect(mesh.shader.resources.uTexture).not.toBe(textureSource);
  });

  it("fades a held overlay out instead of cutting it when nothing arrives", () => {
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
      focusStyle: new BaseFocusStyle({ fill: { alpha: 0.5, color: 0 } }),
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
    layer.tick(0);
    layer.tick(120);

    expect(display.alpha).toBe(1);

    const holdFrame = (timestamp: number) => {
      layer.drawFrame({
        frame: undefined,
        hoveredPick: null,
        mediaTime: frame.mediaTime,
        selectedPick: null,
      });
      layer.tick(timestamp);
    };

    for (let timestamp = 150; timestamp <= 1140; timestamp += 30) {
      holdFrame(timestamp);
    }

    expect(display.visible).toBe(true);
    expect(display.alpha).toBe(1);

    holdFrame(1170);

    expect(display.alpha).toBeLessThan(1);
    expect(display.alpha).toBeGreaterThan(0);
  });

  it("stays hidden when a frame without detections follows focus resolving to nothing", () => {
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
      selectedPick: {
        detection: frame.detections[0]!,
        detectionIndex: 0,
        frame,
        mediaTime: frame.mediaTime,
        point: { x: 15, y: 20 },
        target: DetectionPickTarget.Box,
      },
    });
    layer.drawFrame({
      frame,
      hoveredPick: null,
      mediaTime: frame.mediaTime,
      selectedPick: null,
    });
    layer.drawFrame({
      frame: undefined,
      hoveredPick: null,
      mediaTime: frame.mediaTime,
      selectedPick: null,
    });

    expect(display.visible).toBe(false);
  });

  it("rewrites ID-mask uniforms only when the focus they describe changes", () => {
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        getContext: vi.fn(),
        height: 0,
        width: 0,
      })),
    });

    const { artifact, layer, mesh } = createIdMaskFocus();
    const drawMaskFrame = (mediaTime: number, detectionCount: number) =>
      layer.drawFrame({
        frame: {
          detections: Array.from(
            { length: detectionCount },
            () => maskFrame.detections[0]!,
          ),
          frameIndex: 3,
          mediaTime,
        },
        hoveredPick: null,
        idMaskArtifact: artifact,
        mediaTime,
        selectedPick: null,
      });

    drawMaskFrame(maskFrame.mediaTime, 1);

    const uniforms = mesh.shader.resources.focusUniforms as FakeUniformGroup;

    expect(uniforms.update).toHaveBeenCalledOnce();

    drawMaskFrame(maskFrame.mediaTime + 0.033, 3);
    drawMaskFrame(maskFrame.mediaTime + 0.066, 2);

    expect(uniforms.update).toHaveBeenCalledOnce();
  });

  it("rebuilds vector cutouts only when their inputs change", () => {
    const layer = createPixiFocusLayer({
      Graphics: FakeGraphics as never,
      focusStyle: new BaseFocusStyle({
        fill: { alpha: 0.5, color: 0x000000 },
        targetMode: FocusTargetMode.Ambient,
      }),
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeGraphics;

    const drawPolygonFrame = (drawnFrame: DetectionFrame) =>
      layer.drawFrame({
        frame: drawnFrame,
        hoveredPick: null,
        mediaTime: drawnFrame.mediaTime,
        selectedPick: null,
      });

    drawPolygonFrame(polygonFrame);

    expect(display.clear).toHaveBeenCalledOnce();
    expect(display.poly).toHaveBeenCalledOnce();

    drawPolygonFrame(polygonFrame);
    drawPolygonFrame(polygonFrame);

    expect(display.clear).toHaveBeenCalledOnce();
    expect(display.poly).toHaveBeenCalledOnce();
    expect(display.visible).toBe(true);

    drawPolygonFrame({ ...polygonFrame, frameIndex: 4, mediaTime: 0.2 });

    expect(display.clear).toHaveBeenCalledTimes(2);
    expect(display.poly).toHaveBeenCalledTimes(2);
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
  destroyed = false;
  readonly style = {};

  constructor(readonly _options: unknown) {}

  readonly destroy = vi.fn();
}

function createIdMaskFocus() {
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
      targetMode: FocusTargetMode.Ambient,
    }),
  });
  const display = layer.createDisplay({
    height: 80,
    width: 120,
  }) as FakeContainer;
  const textureSource = new FakeImageSource({
    dynamic: false,
    height: 80,
    resource: {},
    width: 120,
  });

  return {
    artifact: {
      frame: {
        close: vi.fn(),
        fillPalette: new Float32Array(),
        hasStroke: false,
        height: 80,
        key: "mask-frame",
        kind: PreparedMaskFrameKind.IdMask as const,
        maxStrokeWidth: 0,
        raster: new Uint8Array(120 * 80),
        strokePalette: new Float32Array(),
        strokeWidths: new Float32Array(),
        width: 120,
      },
      texture: { source: textureSource } as never,
    },
    layer,
    mesh: display.children[0] as FakeMesh,
    textureSource,
  };
}

class FakeMeshGeometry {
  constructor(readonly _options: unknown) {}

  readonly destroy = vi.fn();
}

class FakeShader {
  constructor(readonly resources: Record<string, unknown>) {}

  readonly destroy = vi.fn();
}

type ShaderDescriptor = {
  readonly gl: { readonly fragment: string; readonly vertex: string };
  readonly gpu: {
    readonly fragment: { readonly entryPoint: string; readonly source: string };
    readonly vertex: { readonly entryPoint: string; readonly source: string };
  };
  readonly resources: Record<string, unknown>;
};

class FakeShaderFactory {
  static readonly descriptors: ShaderDescriptor[] = [];

  static from(options: ShaderDescriptor) {
    FakeShaderFactory.descriptors.push(options);

    return new FakeShader(options.resources);
  }
}

class FailingShaderFactory {
  static from(): never {
    throw new Error("Shader program compilation failed.");
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
