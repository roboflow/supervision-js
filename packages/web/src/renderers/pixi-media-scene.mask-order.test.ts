import { describe, expect, it, vi } from "vitest";
import {
  BaseBoxStyle,
  BasePolygonStyle,
  encodeBinaryMask,
  StrokeAlignment,
  type DetectionFrame,
  type MaskStyle,
} from "supervision-js-core";
import {
  createRenderer,
  pixiMock,
  resetMocks,
} from "../../../../test/media-renderer-harness";
import { RenderPreparationMode } from "#types/render-preparation";

const mask = encodeBinaryMask(new Uint8Array(64 * 64).fill(1), 64, 64);
const initialFrame: DetectionFrame = {
  mediaTime: 0,
  detections: [
    { id: "red", zIndex: 0, mask },
    { id: "box", zIndex: 1, rect: { x: 32, y: 32, width: 64, height: 64 } },
    {
      id: "polygon",
      zIndex: 2,
      polygon: {
        points: [
          { x: 0, y: 0 },
          { x: 64, y: 0 },
          { x: 64, y: 64 },
          { x: 0, y: 64 },
        ],
      },
    },
    { id: "green", zIndex: 3, mask },
  ],
};
function style(opacity: number): MaskStyle {
  return {
    artifactKey: "independent-paint",
    opacity,
    resolve: (detection, context) =>
      detection.mask
        ? {
            mask: detection.mask,
            alpha: context.selected ? 0.75 : 0.5,
            color: detection.id === "red" ? 0xff0000 : 0x00ff00,
            stroke: {
              alpha: 1,
              color: 0,
              width: 4,
              widthUnit: "screen",
              alignment: StrokeAlignment.Outside,
            },
          }
        : undefined,
  };
}

describe("mask order through the media renderer", () => {
  it("keeps duplicate and mixed-type IDs as distinct frame detections", async () => {
    resetMocks();
    const polygon = initialFrame.detections[2]!.polygon!;
    const detections = [
      { id: 7, mask },
      { id: 7, mask },
      ...[1, "1", 3, 3].map((id) => ({
        id,
        rect: { x: 32, y: 32, width: 64, height: 64 },
      })),
      ...[2, "2", 4, 4].map((id) => ({ id, polygon })),
    ];
    const renderer = await createRenderer(false, false, {
      maskOrder: "detection",
      labelStyle: null,
      maskStyle: {
        resolve: (detection, context) =>
          detection.mask
            ? {
                mask: detection.mask,
                color: context.detectionIndex === 0 ? 0xff0000 : 0x00ff00,
                alpha: 1,
              }
            : undefined,
      } satisfies MaskStyle,
      boxStyle: new BaseBoxStyle({
        fill: { alpha: 1, color: 0x0000ff },
        shouldRender: (detection) => Boolean(detection.rect),
      }),
      polygonStyle: new BasePolygonStyle({
        fill: { alpha: 1, color: 0xffff00 },
      }),
      detectionFrames: [{ mediaTime: 0, detections }],
      renderPreparation: { mode: RenderPreparationMode.MainThread },
    });
    try {
      await vi.waitFor(() =>
        expect(visiblePaints()).toEqual([
          0xff0000,
          0x00ff00,
          ...Array<number>(4).fill(0x0000ff),
          ...Array<number>(4).fill(0xffff00),
        ]),
      );
    } finally {
      renderer.destroy();
    }
  });

  it("keeps 100 fully overlapping masks and alternating boxes in one active display set", async () => {
    resetMocks();
    const detections = Array.from({ length: 100 }, (_, index) => [
      { id: `mask-${index}`, mask },
      { id: `box-${index}`, rect: { x: 32, y: 32, width: 64, height: 64 } },
    ]).flat();
    const renderer = await createRenderer(false, false, {
      maskOrder: "detection",
      labelStyle: null,
      polygonStyle: null,
      maskStyle: style(0.5),
      boxStyle: new BaseBoxStyle({
        fill: { alpha: 1, color: 0x0000ff },
        shouldRender: (detection) =>
          detection.id?.toString().startsWith("box-") === true,
      }),
      detectionFrames: [{ mediaTime: 0, detections }],
      renderPreparation: { mode: RenderPreparationMode.MainThread },
    });
    try {
      await vi.waitFor(() =>
        expect(visiblePaints()).toEqual(
          Array.from({ length: 100 }, () => [0x00ff00, 0x0000ff]).flat(),
        ),
      );
      const sources = pixiMock.bufferImageSourceOptions.length;
      const meshes = pixiMock.meshInstances.length;
      const palettes = liveMaskPaints().map((paint) => paint.uFillPalette);
      expect(palettes).toHaveLength(100);
      for (let i = 0; i < 10; i += 1)
        renderer.setViewportTransform({ scale: 0.25 + i / 10 });
      expect(pixiMock.bufferImageSourceOptions).toHaveLength(sources);
      expect(pixiMock.meshInstances).toHaveLength(meshes);
      expect(liveMaskPaints().map((paint) => paint.uFillPalette)).toEqual(
        palettes,
      );
      const packedSources = pixiMock.bufferImageSourceOptions.filter(
        (value) => {
          const source = value as {
            width: number;
            height: number;
            resource: Uint8Array;
          };
          return source.width === 8 && source.height === 64;
        },
      ) as { resource: Uint8Array }[];
      expect(packedSources).toHaveLength(100);
      expect(
        packedSources.reduce(
          (total, source) => total + source.resource.byteLength,
          0,
        ),
      ).toBe(51200);
    } finally {
      renderer.destroy();
    }
    expect(
      pixiMock.meshInstances.every(
        (mesh) => mesh.destroy.mock.calls.length === 1,
      ),
    ).toBe(true);
  });

  it("interleaves masks, boxes and polygons and updates live paint without uploading coverage", async () => {
    resetMocks();
    let frame = initialFrame;
    let version = 0;
    const boxStyle = new BaseBoxStyle({
      fill: { alpha: 1, color: 0x0000ff },
      shouldRender: (detection) => detection.id === "box",
    });
    const polygonStyle = new BasePolygonStyle({
      fill: { alpha: 1, color: 0xffff00 },
    });
    const renderer = await createRenderer(false, false, {
      maskOrder: "detection",
      labelStyle: null,
      maskStyle: style(0.5),
      boxStyle: new BaseBoxStyle({
        fill: { alpha: 1, color: 0x0000ff },
        shouldRender: (detection) => detection.id === "box",
      }),
      polygonStyle: new BasePolygonStyle({
        fill: { alpha: 1, color: 0xffff00 },
      }),
      detectionSource: {
        getVersion: () => version,
        loadFrames: async () => [frame],
      },
      renderPreparation: { mode: RenderPreparationMode.MainThread },
    });
    try {
      await vi.waitFor(() =>
        expect(visiblePaints()).toEqual([
          0xff0000, 0x0000ff, 0xffff00, 0x00ff00,
        ]),
      );
      const sources = pixiMock.bufferImageSourceOptions.length;
      const shaders = pixiMock.shaderInstances.length;
      const paints = liveMaskPaints();
      expect(paints).toHaveLength(2);
      expect(paints[0]!.uFillPalette[7]).toBe(0.25);
      expect(paints[0]!.uStrokePalette[7]).toBe(0.5);
      const palette = paints[0]!.uFillPalette;
      renderer.setPresentation({
        maskStyle: style(0.25),
        boxStyle,
        polygonStyle,
        labelStyle: null,
      });
      renderer.setViewportTransform({ scale: 0.25 });
      expect(pixiMock.bufferImageSourceOptions).toHaveLength(sources);
      expect(pixiMock.shaderInstances).toHaveLength(shaders);
      expect(liveMaskPaints()[0]!.uFillPalette).toBe(palette);
      expect(palette[7]).toBe(0.125);
      expect(liveMaskPaints()[0]!.uStrokePalette[7]).toBe(0.25);
      frame = {
        ...initialFrame,
        detections: initialFrame.detections.map((detection) => ({
          ...detection,
          zIndex: 3 - detection.zIndex!,
        })),
      };
      version += 1;
      await renderer.refresh();
      await vi.waitFor(() =>
        expect(visiblePaints()).toEqual([
          0x00ff00, 0xffff00, 0x0000ff, 0xff0000,
        ]),
      );
    } finally {
      renderer.destroy();
    }
    expect(
      pixiMock.meshInstances.every(
        (mesh) => mesh.destroy.mock.calls.length > 0,
      ),
    ).toBe(true);
  });
});

type Paint = { uFillPalette: Float32Array; uStrokePalette: Float32Array };
type Display = {
  children?: Display[];
  sortableChildren?: boolean;
  zIndex?: number;
  visible?: boolean;
  fill?: ReturnType<typeof vi.fn>;
  shader?: { resources: { maskUniforms?: { uniforms: Paint } } };
};
function liveMaskPaints(): Paint[] {
  return pixiMock.meshInstances.flatMap((mesh) => {
    const display = mesh as Display;
    const paint = display.shader?.resources.maskUniforms?.uniforms;
    return display.visible && paint?.uFillPalette[7] ? [paint] : [];
  });
}
function visiblePaints() {
  const colors: number[] = [];
  function collect(display: Display) {
    if (display.visible === false) return;
    const paint = display.shader?.resources.maskUniforms?.uniforms;
    if (paint?.uFillPalette[7])
      colors.push(
        Math.round(paint.uFillPalette[4]! * 255) * 65536 +
          Math.round(paint.uFillPalette[5]! * 255) * 256 +
          Math.round(paint.uFillPalette[6]! * 255),
      );
    const fill = display.fill?.mock.calls.at(-1)?.[0];
    if (fill?.alpha === 1) colors.push(fill.color);
    const children = [...(display.children ?? [])];
    if (display.sortableChildren)
      children.sort((left, right) => (left.zIndex ?? 0) - (right.zIndex ?? 0));
    children.forEach(collect);
  }
  const root = pixiMock.stageAddChild.mock.calls.at(-1)?.[0];
  if (root) collect(root);
  return colors;
}
