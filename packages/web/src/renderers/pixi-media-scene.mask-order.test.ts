import { describe, expect, it, vi } from "vitest";
import {
  BaseBoxStyle,
  BasePolygonStyle,
  encodeBinaryMask,
  createAnnotationEditingEngine,
  DetectionPickTarget,
  StrokeAlignment,
  type DetectionFrame,
  type MaskStyle,
} from "supervision-js-core";
import {
  createContainer,
  createRenderer,
  pixiMock,
  resetMocks,
} from "../../../../test/media-renderer-harness";
import { RenderPreparationMode } from "#types/render-preparation";
import { createStaticImageMediaSource } from "#media/static-image-media-source";

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
  it("keeps default masks below vectors with an editing engine", async () => {
    resetMocks();
    const renderer = await createRenderer(false, false, {
      editingEngine: createAnnotationEditingEngine(),
      labelStyle: null,
      maskStyle: style(1),
      boxStyle: new BaseBoxStyle({ fill: { color: 0x0000ff, alpha: 1 } }),
      detectionFrames: [
        {
          mediaTime: 0,
          detections: [
            {
              id: "box",
              zIndex: 0,
              rect: { x: 32, y: 32, width: 64, height: 64 },
            },
            { id: "red", zIndex: 1, mask },
          ],
        },
      ],
      renderPreparation: { mode: RenderPreparationMode.MainThread },
    });
    try {
      await vi.waitFor(() => expect(liveMaskPaints()).toHaveLength(1));
      expect(visiblePaints().at(-1)).toBe(0x0000ff);
    } finally {
      renderer.destroy();
    }
  });

  it.each([
    ["detection", "cancel"],
    [undefined, "cancel"],
    ["detection", "commit"],
    [undefined, "commit"],
  ] as const)(
    "moves attached geometry and resets translation (%s, %s)",
    async (maskOrder, finish) => {
      resetMocks();
      const pixels = new Uint8Array(64 * 64);
      pixels[10 * 64 + 10] = 1;
      const movingMask = encodeBinaryMask(pixels, 64, 64);
      const detection = {
        id: "red",
        mask: movingMask,
        rect: { x: 10.5, y: 10.5, width: 1, height: 1 },
        polygon: {
          points: [
            { x: 10, y: 10 },
            { x: 20, y: 10 },
            { x: 10, y: 20 },
          ],
        },
      };
      let frame: DetectionFrame = {
        mediaTime: 0,
        detections: [detection, { id: "green", mask: movingMask }],
      };
      let version = 0;
      const engine = createAnnotationEditingEngine({
        onCommit: (moved) => {
          frame = { ...frame, detections: [moved, frame.detections[1]!] };
          version++;
        },
      });
      const renderer = await createRenderer(false, false, {
        editingEngine: engine,
        maskOrder,
        labelStyle: null,
        maskStyle: style(1),
        boxStyle: new BaseBoxStyle({
          fill: { color: 0x123456, alpha: 1 },
          shouldRender: (entry) => entry.id === "red",
        }),
        polygonStyle: new BasePolygonStyle({
          fill: { color: 0xabcdef, alpha: 1 },
        }),
        detectionSource: {
          getVersion: () => version,
          loadFrames: async () => [frame],
        },
        renderPreparation: { mode: RenderPreparationMode.MainThread },
      });
      try {
        await vi.waitFor(() => expect(liveMaskPaints()).toHaveLength(2));
        type MovingMaskDisplay = Display & {
          position: { set: ReturnType<typeof vi.fn> };
        };
        const meshes = pixiMock.meshInstances
          .map((mesh) => mesh as unknown as MovingMaskDisplay)
          .filter(
            (mesh) => mesh.visible && mesh.shader?.resources.maskUniforms,
          );
        const initial = meshes.map(
          (mesh) => mesh.position.set.mock.lastCall as [number, number],
        );
        const box = pixiMock.graphicsInstances.find((graphics) =>
          graphics.fill.mock.calls.some(([fill]) => fill.color === 0x123456),
        )!;
        const polygon = pixiMock.graphicsInstances.find((graphics) =>
          graphics.fill.mock.calls.some(([fill]) => fill.color === 0xabcdef),
        )!;
        expect(polygon.visible).toBe(true);
        expect(box.visible).toBe(true);
        const point = { x: 10, y: 10 };
        engine.pointerDown(
          { point, timestamp: 0 },
          {
            detection,
            detectionIndex: 0,
            frame,
            mediaTime: 0,
            point,
            target: DetectionPickTarget.Mask,
          },
        );
        engine.pointerMove({ point: { x: 20, y: 25 }, timestamp: 16 });
        expect(meshes[0]!.position.set).toHaveBeenLastCalledWith(
          initial[0]![0] + 10,
          initial[0]![1] + 15,
        );
        expect(meshes[1]!.position.set).toHaveBeenLastCalledWith(
          ...initial[1]!,
        );
        expect(box.visible).toBe(true);
        expect([box.x, box.y]).toEqual([10, 15]);
        expect(polygon.visible).toBe(true);
        expect([polygon.x, polygon.y]).toEqual([10, 15]);
        if (finish === "cancel") {
          engine.cancel();
          expect(box.visible).toBe(true);
          expect([box.x, box.y]).toEqual([0, 0]);
          expect([polygon.x, polygon.y]).toEqual([0, 0]);
          expect(meshes[0]!.position.set).toHaveBeenLastCalledWith(
            ...initial[0]!,
          );
        } else {
          engine.pointerUp({ point: { x: 20, y: 25 }, timestamp: 32 });
          await renderer.refresh();
          await vi.waitFor(() =>
            expect(polygon.poly).toHaveBeenLastCalledWith(
              [20, 25, 30, 25, 20, 35],
              true,
            ),
          );
          expect([polygon.x, polygon.y]).toEqual([0, 0]);
          expect(frame.detections[0]!.polygon!.points).toEqual([
            { x: 20, y: 25 },
            { x: 30, y: 25 },
            { x: 20, y: 35 },
          ]);
        }
      } finally {
        renderer.destroy();
      }
    },
  );

  it("updates still-image outlines on display-density changes without another frame or zoom", async () => {
    resetMocks();
    const previousPixelRatio = window.devicePixelRatio;
    const previousResizeObserver = globalThis.ResizeObserver;
    let resize!: () => void;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    window.devicePixelRatio = 1;
    const container = createContainer();
    const maskStyle = style(1);
    const resolve = vi.fn(maskStyle.resolve);
    const renderer = await createRenderer(false, false, {
      container,
      source: createStaticImageMediaSource({
        width: 64,
        height: 64,
        draw() {},
      }),
      src: undefined,
      maskOrder: "detection",
      labelStyle: null,
      maskStyle: { ...maskStyle, resolve },
      detectionFrames: [{ mediaTime: 0, detections: [{ id: "red", mask }] }],
      renderPreparation: { mode: RenderPreparationMode.MainThread },
    });
    try {
      await vi.waitFor(() => expect(liveMaskPaints()).toHaveLength(1));
      const paint = liveMaskPaints()[0]!;
      const sources = pixiMock.bufferImageSourceOptions.length;
      const meshes = pixiMock.meshInstances.length;
      expect(paint.uStrokePixelRatio).toBe(1);

      const resolutions = resolve.mock.calls.length;
      renderer.setViewportTransform({ x: 200, y: 20 });
      expect(resolve.mock.calls.length - resolutions).toBeLessThanOrEqual(1);
      const afterPan = resolve.mock.calls.length;
      Object.defineProperty(container, "clientWidth", { value: 720 });
      resize();
      expect(resolve).toHaveBeenCalledTimes(afterPan);

      // A wider letterbox leaves the image scale unchanged while DPR doubles.
      Object.defineProperty(container, "clientWidth", { value: 800 });
      window.devicePixelRatio = 2;
      resize();
      expect(paint.uStrokePixelRatio).toBe(2);

      renderer.setRenderQuality({ maxDevicePixelRatio: 1 });
      expect(paint.uStrokePixelRatio).toBe(1);
      renderer.setRenderQuality({ maxDevicePixelRatio: 2 });
      expect(paint.uStrokePixelRatio).toBe(2);
      expect(liveMaskPaints()[0]).toBe(paint);
      expect(pixiMock.bufferImageSourceOptions).toHaveLength(sources);
      expect(pixiMock.meshInstances).toHaveLength(meshes);
    } finally {
      renderer.destroy();
      window.devicePixelRatio = previousPixelRatio;
      vi.stubGlobal("ResizeObserver", previousResizeObserver);
    }
  });

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

type Paint = {
  uFillPalette: Float32Array;
  uStrokePalette: Float32Array;
  uStrokePixelRatio: number;
};
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
