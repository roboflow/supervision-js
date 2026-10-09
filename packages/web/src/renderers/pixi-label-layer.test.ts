import { describe, expect, it, vi } from "vitest";
import type { Filter } from "pixi.js";

import { createPixiLabelLayer } from "#renderers/pixi-label-layer";
import { createPixiBoxLayer } from "#renderers/pixi-box-layer";
import type { BufferedDetectionTimeline } from "supervision-js-core";
import type { DetectionFrame } from "supervision-js-core";
import {
  BaseBoxStyle,
  createDefaultAnnotationPresentation,
  DetectionMaskEncoding,
  LabelPlacement,
  type BoxStyle,
  type Detection,
} from "supervision-js-core";
import { DetectionPickTarget } from "supervision-js-core";
import type { LabelStyle } from "supervision-js-core";

const firstFrame: DetectionFrame = {
  detections: [
    {
      className: "player",
      confidence: 0.93,
      id: "player-1",
      rect: { height: 20, width: 10, x: 15, y: 40 },
    },
  ],
  frameIndex: 1,
  mediaTime: 1,
};

const secondFrame: DetectionFrame = {
  detections: [
    {
      className: "player",
      confidence: 0.93,
      rect: { height: 20, width: 10, x: 21, y: 44 },
    },
  ],
  frameIndex: 2,
  mediaTime: 2,
};

describe("pixi label layer", () => {
  it("shares background captures between separated labels and splits before overlapping chips", () => {
    const frame: DetectionFrame = {
      ...firstFrame,
      detections: [10, 110, 110].map((x, index) => ({
        id: `label-${index}`,
        rect: { height: 20, width: 10, x: x + 5, y: 40 },
      })),
    };
    const style = createStableLabelStyle();
    const layer = createPixiLabelLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      Text: FakeText as never,
      detectionTimeline: createTimeline([frame]),
      labelStyle: {
        resolve: (detection, context) => ({
          ...style.resolve(detection, context)!,
          text: String(detection.id),
          textStyle: { alpha: 0.6, color: 0xffffff },
        }),
      },
    });
    const container = layer.createContainer() as FakeContainer;
    layer.drawFrame(1);
    const flat = [...container.children];
    const filter = { padding: 2 } as Filter;

    layer.setBackgroundAntialiasFilter(filter);

    const [before, firstText, secondText, after, lastText] = container.children;
    expect((before as FakeContainer).children).toEqual([flat[0], flat[2]]);
    expect((after as FakeContainer).children).toEqual([flat[4]]);
    expect((before as FakeContainer).filters).toEqual([filter]);
    expect((after as FakeContainer).filters).toBe(
      (before as FakeContainer).filters,
    );
    expect([firstText, secondText, lastText]).toEqual([
      flat[1],
      flat[3],
      flat[5],
    ]);
    for (const text of [firstText, secondText, lastText] as FakeText[]) {
      expect(text.alpha).toBe(0.6);
      expect(text.parent).toBe(container);
      expect(text.styleAssignments).toBe(1);
      expect(text.textAssignments).toBe(1);
    }
    expect((flat[0] as FakeGraphics).fill).toHaveBeenLastCalledWith({
      alpha: 0.8,
      color: 0x111111,
    });
    layer.setBackgroundAntialiasFilter(null);
    expect(container.children).toEqual(flat);
    expect((before as FakeContainer).filters).toBeNull();
    expect((after as FakeContainer).filters).toBeNull();
    layer.setBackgroundAntialiasFilter(filter);
    expect(container.children[0]).toBe(before);
    expect(container.children[3]).toBe(after);
    layer.destroy();
    expect((before as FakeContainer).filters).toBeNull();
    expect((after as FakeContainer).filters).toBeNull();
  });

  it.each([
    { padding: 2, gap: 1, paddingX: 7 },
    { padding: 0, gap: 4, paddingX: -6 },
  ])(
    "keeps AA fringes and text outside chip padding in separate captures ($paddingX)",
    ({ padding, gap, paddingX }) => {
      const style = createStableLabelStyle();
      const width = 20 + paddingX * 2;
      const frame: DetectionFrame = {
        ...firstFrame,
        detections: [10, 10 + width + gap].map((left, index) => ({
          id: index,
          rect: { height: 20, width: 10, x: left + 5, y: 40 },
        })),
      };
      const { layer, container } = createBoxAwareLabelLayer(
        {
          resolve: (detection, context) => {
            const instruction = style.resolve(detection, context)!;
            return {
              ...instruction,
              background: { ...instruction.background!, paddingX },
            };
          },
        },
        [frame],
      );
      layer.setBackgroundAntialiasFilter({ padding } as Filter);
      layer.drawFrame(1);
      expect(
        container.children.filter((child) => child instanceof FakeContainer),
      ).toHaveLength(2);
    },
  );

  it("repartitions fast-translated labels without rerasterizing their text", () => {
    const frame: DetectionFrame = {
      ...firstFrame,
      detections: [15, 115].map((x, index) => ({
        id: `label-${index}`,
        rect: { height: 20, width: 10, x, y: 40 },
      })),
    };
    const { layer, container } = createBoxAwareLabelLayer(
      createStableLabelStyle(),
      [frame],
    );
    layer.setBackgroundAntialiasFilter({ padding: 2 } as Filter);
    layer.drawFrame(1);
    const texts = container.children.filter(
      (child) => child instanceof FakeText,
    ) as FakeText[];
    expect(
      container.children.filter((child) => child instanceof FakeContainer),
    ).toHaveLength(1);
    expect(layer.translateDetection("label-0", 100, 0)).toBe(true);
    expect(
      container.children.filter((child) => child instanceof FakeContainer),
    ).toHaveLength(2);
    for (const text of texts) {
      expect(text.textAssignments).toBe(1);
      expect(text.styleAssignments).toBe(1);
    }
  });

  it.each([LabelPlacement.Top, LabelPlacement.Bottom])(
    "preserves displayed-box attachment at %s during FXAA background capture",
    (placement) => {
      const defaultStyle = createDefaultAnnotationPresentation().labelStyle!;
      const frame: DetectionFrame = {
        ...firstFrame,
        detections: [
          {
            ...firstFrame.detections[0]!,
            mask: {
              counts: "04",
              encoding: DetectionMaskEncoding.CompressedRle,
              height: 2,
              width: 2,
            },
          },
        ],
      };
      const { boxLayer, layer, container } = createBoxAwareLabelLayer(
        {
          resolve: (detection, context) => ({
            ...defaultStyle.resolve(detection, context)!,
            placement,
          }),
        },
        [frame],
        null,
      );
      layer.setBackgroundAntialiasFilter({ padding: 2 } as Filter);
      boxLayer.drawFrame(1);
      layer.drawFrame(1);
      const group = container.children[0] as FakeContainer;
      const background = group.children[0] as FakeGraphics;
      expect(background.roundRect).toHaveBeenCalledOnce();
      boxLayer.setBoxStyle(new BaseBoxStyle());
      boxLayer.drawFrame(1);
      layer.drawFrame(1);
      expect(background.moveTo).toHaveBeenLastCalledWith(
        0,
        placement === LabelPlacement.Top ? 16 : 0,
      );
      boxLayer.setBoxStyle(null);
      boxLayer.drawFrame(1);
      layer.drawFrame(1);
      expect(background.roundRect).toHaveBeenCalledTimes(2);
      expect(container.children[0]).toBe(group);
      const text = container.children[1] as FakeText;
      expect(text.parent).toBe(container);
      expect(text.textAssignments).toBe(1);
    },
  );

  it("retains creation-preview order when later frames allocate more labels", () => {
    const frames = [firstFrame];
    const style = createStableLabelStyle();
    const { layer, container } = createBoxAwareLabelLayer(
      {
        resolve: (detection, context) => ({
          ...style.resolve(detection, context)!,
          text: String(detection.id),
        }),
      },
      frames,
    );
    layer.setBackgroundAntialiasFilter({ padding: 2 } as Filter);
    layer.drawFrame(1);
    layer.drawCreationPreview(
      { ...firstFrame.detections[0]!, id: "preview" },
      1,
    );
    frames[0] = {
      ...firstFrame,
      detections: [
        ...firstFrame.detections,
        { ...firstFrame.detections[0]!, id: "player-2" },
      ],
    };
    layer.drawFrame(1);
    const texts = container.children.filter(
      (child) => child instanceof FakeText,
    ) as FakeText[];
    expect(texts.map((text) => text.text)).toEqual([
      "player-1",
      "preview",
      "player-2",
    ]);
    expect(
      container.children.filter((child) => child instanceof FakeContainer),
    ).toHaveLength(3);
    layer.drawCreationPreview(null, 1);
    expect(texts[1]!.visible).toBe(false);
    expect(
      container.children.filter((child) => child instanceof FakeContainer),
    ).toHaveLength(2);
  });

  it.each([
    {
      name: "mask",
      geometry: {
        mask: {
          counts: "04",
          encoding: DetectionMaskEncoding.CompressedRle,
          height: 2,
          width: 2,
        },
      },
    },
    {
      name: "heatmap",
      geometry: {
        heatmap: {
          bounds: firstFrame.detections[0]!.rect!,
          height: 1,
          width: 1,
          values: [1],
        },
      },
    },
  ])(
    "only attaches a $name label to a box that is displayed",
    ({ geometry }) => {
      const frame: DetectionFrame = {
        ...firstFrame,
        detections: [
          { ...firstFrame.detections[0]!, ...geometry } as Detection,
        ],
      };
      const { boxLayer, layer, container } = createBoxAwareLabelLayer(
        createDefaultAnnotationPresentation().labelStyle!,
        [frame],
        null,
      );
      boxLayer.drawFrame(1);
      layer.drawFrame(1);
      const [background, label] = container.children as [
        FakeGraphics,
        FakeText,
      ];
      expect(background.roundRect).toHaveBeenCalledOnce();

      boxLayer.setBoxStyle(new BaseBoxStyle());
      boxLayer.drawFrame(1);
      layer.drawFrame(1);
      expect(background.moveTo).toHaveBeenLastCalledWith(0, 16);
      expect(background.roundRect).toHaveBeenCalledOnce();

      boxLayer.setBoxStyle(null);
      boxLayer.drawFrame(1);
      layer.drawFrame(1);
      expect(background.roundRect).toHaveBeenCalledTimes(2);
      expect(background.clear).toHaveBeenCalledTimes(3);
      expect(label.textAssignments).toBe(1);
      expect(label.styleAssignments).toBe(1);
      layer.drawFrame(1);
      expect(background.clear).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    [LabelPlacement.Top, "top"],
    [LabelPlacement.Bottom, "bottom"],
    [LabelPlacement.InsideTop, "bottom"],
    [LabelPlacement.InsideBottom, "top"],
    [LabelPlacement.Center, "all"],
  ] as const)(
    "rounds the unattached corner pair at %s",
    (placement, corners) => {
      const style = createStableLabelStyle();
      const { boxLayer, layer, container } = createBoxAwareLabelLayer({
        resolve: (detection, context) => ({
          ...style.resolve(detection, context)!,
          placement,
        }),
      });
      boxLayer.drawFrame(1);
      layer.drawFrame(1);
      const [background] = container.children as [FakeGraphics, FakeText];
      if (corners === "all") {
        expect(background.roundRect).toHaveBeenCalledOnce();
      } else {
        expect(background.moveTo).toHaveBeenCalledWith(
          0,
          corners === "top" ? 18 : 0,
        );
        expect(background.roundRect).not.toHaveBeenCalled();
      }
    },
  );

  it("reverses the corner pair when placement changes without changing chip size", () => {
    const style = createStableLabelStyle();
    const { boxLayer, layer, container } = createBoxAwareLabelLayer(style);
    boxLayer.drawFrame(1);
    layer.drawFrame(1);
    const [background] = container.children as [FakeGraphics, FakeText];
    expect(background.moveTo).toHaveBeenLastCalledWith(0, 18);

    layer.setLabelStyle({
      resolve: (detection, context) => ({
        ...style.resolve(detection, context)!,
        placement: LabelPlacement.Bottom,
      }),
    });
    layer.drawFrame(1);
    expect(background.moveTo).toHaveBeenLastCalledWith(0, 0);
    expect(background.quadraticCurveTo).toHaveBeenLastCalledWith(0, 18, 0, 14);
    expect(background.clear).toHaveBeenCalledTimes(2);
  });

  it.each([
    [LabelPlacement.Top, 0, 3],
    [LabelPlacement.Bottom, 0, 3],
    [LabelPlacement.InsideTop, 0, 3],
    [LabelPlacement.InsideBottom, 0, 3],
    [LabelPlacement.Top, 100, 0],
  ] as const)(
    "rounds %s labels detached by offset (%s, %s)",
    (placement, offsetX, offsetY) => {
      const style = createStableLabelStyle();
      const { boxLayer, layer, container } = createBoxAwareLabelLayer({
        resolve: (detection, context) => ({
          ...style.resolve(detection, context)!,
          placement,
          offsetX,
          offsetY,
        }),
      });
      boxLayer.drawFrame(1);
      layer.drawFrame(1);
      expect(
        (container.children[0] as FakeGraphics).roundRect,
      ).toHaveBeenCalledOnce();
    },
  );

  it.each([true, false])(
    "preserves explicit topCornersOnly:%s",
    (topCornersOnly) => {
      const style = createStableLabelStyle();
      const { boxLayer, layer, container } = createBoxAwareLabelLayer(
        {
          resolve(detection, context) {
            const instruction = style.resolve(detection, context)!;
            return {
              ...instruction,
              background: { ...instruction.background!, topCornersOnly },
              placement: LabelPlacement.Bottom,
            };
          },
        },
        [firstFrame],
        topCornersOnly ? null : new BaseBoxStyle(),
      );
      boxLayer.drawFrame(1);
      layer.drawFrame(1);
      const [background] = container.children as [FakeGraphics, FakeText];
      if (topCornersOnly) {
        expect(background.moveTo).toHaveBeenCalledWith(0, 18);
        expect(background.roundRect).not.toHaveBeenCalled();
      } else {
        expect(background.roundRect).toHaveBeenCalledOnce();
      }
    },
  );

  it("uses the drawn box rectangle and refuses a box from a replaced frame", () => {
    const frames = [firstFrame];
    const { boxLayer, layer, container } = createBoxAwareLabelLayer(
      createStableLabelStyle(),
      frames,
    );
    boxLayer.drawFrame(1);
    layer.drawFrame(1);
    const [background] = container.children as [FakeGraphics, FakeText];
    expect(background.roundRect).not.toHaveBeenCalled();
    frames[0] = { ...firstFrame };
    layer.drawFrame(1);
    expect(background.roundRect).toHaveBeenCalledOnce();

    const baseBox = new BaseBoxStyle();
    boxLayer.setBoxStyle({
      resolve(detection, context) {
        const instruction = baseBox.resolve(detection, context)!;
        return { ...instruction, rect: { ...instruction.rect, y: 100 } };
      },
    });
    boxLayer.drawFrame(1);
    layer.drawFrame(1);
    expect(background.roundRect).toHaveBeenCalledOnce();
    expect(background.clear).toHaveBeenCalledTimes(2);
  });

  it("moves stable labels without re-rasterizing text or redrawing backgrounds", () => {
    const timeline = createTimeline([firstFrame, secondFrame]);
    const layer = createPixiLabelLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      Text: FakeText as never,
      detectionTimeline: timeline,
      labelStyle: createStableLabelStyle(),
    });
    const container = layer.createContainer() as FakeContainer;

    layer.drawFrame(1);
    layer.drawFrame(2);

    const [background, label] = container.children as [FakeGraphics, FakeText];

    expect(label.textAssignments).toBe(1);
    expect(label.styleAssignments).toBe(1);
    expect(label.x).toBe(23);
    expect(label.y).toBe(20);
    expect(background.clear).toHaveBeenCalledTimes(1);
    expect(background.roundRect).toHaveBeenCalledTimes(1);
    expect(background.x).toBe(16);
    expect(background.y).toBe(16);
  });

  it("redraws a replacement frame at the same timeline position", () => {
    const frames = [firstFrame];
    const layer = createPixiLabelLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      Text: FakeText as never,
      detectionTimeline: createTimeline(frames),
      labelStyle: createStableLabelStyle(),
    });
    const container = layer.createContainer() as FakeContainer;

    layer.drawFrame(1);
    const [background] = container.children as [FakeGraphics, FakeText];
    expect(background.x).toBe(10);

    frames[0] = {
      ...firstFrame,
      detections: [
        {
          ...firstFrame.detections[0]!,
          rect: { height: 20, width: 10, x: 45, y: 40 },
        },
      ],
    };
    layer.drawFrame(1);

    expect(background.x).toBe(40);
  });

  it("places labels relative to detection rectangles", () => {
    const timeline = createTimeline([firstFrame]);
    const layer = createPixiLabelLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      Text: FakeText as never,
      detectionTimeline: timeline,
      labelStyle: {
        resolve(detection) {
          if (!detection.rect) {
            return undefined;
          }

          return {
            background: {
              alpha: 0.8,
              color: 0x111111,
              cornerRadius: 4,
              paddingX: 7,
              paddingY: 4,
            },
            offsetX: 2,
            offsetY: 3,
            placement: LabelPlacement.Bottom,
            rect: detection.rect,
            text: "player",
          };
        },
      },
    });
    const container = layer.createContainer() as FakeContainer;

    layer.drawFrame(1);

    const [background, label] = container.children as [FakeGraphics, FakeText];

    expect(background.x).toBe(12);
    expect(background.y).toBe(53);
    expect(label.x).toBe(19);
    expect(label.y).toBe(57);
  });

  it("renders creation labels with the committed label style", () => {
    const resolve = vi.fn(createStableLabelStyle().resolve.bind(null));
    const layer = createPixiLabelLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      Text: FakeText as never,
      detectionTimeline: createTimeline([firstFrame]),
      labelStyle: { resolve },
    });
    const container = layer.createContainer() as FakeContainer;
    const preview = {
      className: "player",
      id: "draft-player",
      rect: { height: 20, width: 10, x: 45, y: 40 },
    };

    layer.drawFrame(1);
    layer.drawCreationPreview(preview, 1, 2);

    const [, , previewBackground, previewLabel] = container.children as [
      FakeGraphics,
      FakeText,
      FakeGraphics,
      FakeText,
    ];
    expect(resolve).toHaveBeenLastCalledWith(
      preview,
      expect.objectContaining({
        ephemeral: false,
        isCreating: true,
        mediaTime: 1,
        viewportScale: 2,
      }),
    );
    expect(previewBackground.x).toBe(40);
    expect(previewLabel.visible).toBe(true);
    expect(previewBackground.roundRect).toHaveBeenCalledOnce();
    layer.drawCreationPreview(preview, 1, 2, preview.rect);
    expect(previewBackground.moveTo).toHaveBeenCalledWith(0, 14);
    expect(previewBackground.roundRect).toHaveBeenCalledOnce();

    layer.drawCreationPreview(null, 1, 2);
    expect(previewBackground.visible).toBe(false);
    expect(previewLabel.visible).toBe(false);
  });

  it("updates editing-box attachment without resetting a fast-translated label", () => {
    const { boxLayer, layer, container } = createBoxAwareLabelLayer(
      createStableLabelStyle(),
    );
    boxLayer.drawFrame(1);
    layer.drawFrame(1);
    const [background, label] = container.children as [FakeGraphics, FakeText];
    layer.translateDetection("player-1", 3, 4);
    layer.updateEditingBox("player-1", { height: 20, width: 10, x: 18, y: 44 });
    expect(background).toMatchObject({ x: 13, y: 16 });
    expect(background.clear).toHaveBeenCalledOnce();

    layer.translateDetection("player-1", 5, 8);
    layer.updateEditingBox("player-1", undefined);
    expect(background).toMatchObject({ x: 15, y: 20 });
    expect(background.roundRect).toHaveBeenCalledOnce();
    layer.updateEditingBox("player-1", { height: 20, width: 10, x: 20, y: 48 });
    expect(background).toMatchObject({ x: 15, y: 20 });
    expect(background.clear).toHaveBeenCalledTimes(3);
    expect(label.textAssignments).toBe(1);
    expect(label.styleAssignments).toBe(1);
  });

  it("does not add an implicit top gutter when the scene supplies viewport scale", () => {
    const timeline = createTimeline([firstFrame]);
    const layer = createPixiLabelLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      Text: FakeText as never,
      detectionTimeline: timeline,
      labelStyle: createStableLabelStyle(),
    });
    const container = layer.createContainer() as FakeContainer;

    layer.drawFrame(1, 2);

    const [background, label] = container.children as [FakeGraphics, FakeText];

    expect(background.y).toBe(16);
    expect(label.y).toBe(18);
  });

  it.each([LabelPlacement.Top, LabelPlacement.InsideBottom])(
    "keeps %s labels inside the media at its top edge",
    (placement) => {
      const edgeFrame: DetectionFrame = {
        detections: [
          {
            rect: { height: 10, width: 10, x: 10, y: 5 },
          },
        ],
        mediaTime: 3,
      };
      const boxLayer = createPixiBoxLayer({
        detectionTimeline: createTimeline([edgeFrame]),
        boxStyle: new BaseBoxStyle(),
      });
      boxLayer.attachGraphics(new FakeGraphics() as never);
      boxLayer.drawFrame(3);
      const layer = createPixiLabelLayer({
        Container: FakeContainer as never,
        Graphics: FakeGraphics as never,
        Text: FakeText as never,
        detectionTimeline: createTimeline([edgeFrame]),
        getRenderedBoxes: () => boxLayer.getRenderedBoxes(),
        labelStyle: {
          resolve(detection) {
            if (!detection.rect) return undefined;
            return {
              background: {
                alpha: 0.8,
                color: 0x111111,
                paddingX: 7,
                paddingY: 4,
              },
              placement,
              rect: detection.rect,
              text: "edge",
            };
          },
        },
      });
      const container = layer.createContainer() as FakeContainer;

      layer.drawFrame(3);

      const [background, label] = container.children as [
        FakeGraphics,
        FakeText,
      ];
      expect(background.y).toBe(0);
      expect(background.roundRect).toHaveBeenCalledOnce();
      expect(label.y).toBe(4);
    },
  );

  it("picks the visible label chip before underlying geometry", () => {
    const timeline = createTimeline([firstFrame]);
    const layer = createPixiLabelLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      Text: FakeText as never,
      detectionTimeline: timeline,
      labelStyle: createStableLabelStyle(),
    });

    layer.createContainer();
    layer.drawFrame(1);

    const pick = layer.pickDetectionAtPoint({ x: 11, y: 13 }, 1);

    expect(pick?.detectionIndex).toBe(0);
    expect(pick?.target).toBe(DetectionPickTarget.Label);
    expect(layer.pickDetectionAtPoint({ x: 100, y: 100 }, 1)).toBeNull();
  });

  it("reports the exact laid-out label bounds by detection id", () => {
    const layer = createPixiLabelLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      Text: FakeText as never,
      detectionTimeline: createTimeline([firstFrame]),
      labelStyle: createStableLabelStyle(),
    });

    layer.createContainer();
    layer.drawFrame(1);

    expect(layer.getDetectionLabelBounds("player-1")).toEqual({
      height: 18,
      width: 34,
      x: 10,
      y: 12,
    });

    layer.translateDetection("player-1", 3, 4);

    expect(layer.getDetectionLabelBounds("player-1")).toEqual({
      height: 18,
      width: 34,
      x: 13,
      y: 16,
    });

    layer.drawFrame(99);
    expect(layer.getDetectionLabelBounds("player-1")).toBeNull();
  });
});

class FakeContainer {
  readonly children: unknown[] = [];
  filters: readonly Filter[] | null = null;
  label = "";
  parent: FakeContainer | null = null;
  destroy() {
    this.removeChildren();
  }

  addChild(...children: unknown[]) {
    for (const child of children as { parent?: FakeContainer | null }[]) {
      child.parent?.removeChild(child);
      child.parent = this;
      this.children.push(child);
    }
  }

  removeChild(child: unknown) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    (child as { parent: null }).parent = null;
  }

  removeChildren() {
    const children = this.children.splice(0);
    for (const child of children as { parent: null }[]) child.parent = null;
    return children;
  }
}

class FakeGraphics {
  parent: FakeContainer | null = null;
  readonly clear = vi.fn(() => this);
  readonly fill = vi.fn(() => this);
  readonly roundRect = vi.fn(() => this);
  readonly rect = vi.fn(() => this);
  readonly stroke = vi.fn(() => this);
  readonly moveTo = vi.fn(() => this);
  readonly lineTo = vi.fn(() => this);
  readonly quadraticCurveTo = vi.fn(() => this);
  readonly closePath = vi.fn(() => this);
  visible = false;
  x = 0;
  y = 0;
}

class FakeText {
  parent: FakeContainer | null = null;
  private currentText = "";
  private currentStyle: unknown = {};
  alpha = 1;
  visible = false;
  x = 0;
  y = 0;
  styleAssignments = 0;
  textAssignments = 0;

  constructor(options: { text?: string; style?: unknown }) {
    this.currentText = options.text ?? "";
    this.currentStyle = options.style ?? {};
  }

  get height() {
    return 10;
  }

  get style() {
    return this.currentStyle;
  }

  set style(nextStyle: unknown) {
    this.styleAssignments += 1;
    this.currentStyle = nextStyle;
  }

  get text() {
    return this.currentText;
  }

  set text(nextText: string) {
    this.textAssignments += 1;
    this.currentText = nextText;
  }

  get width() {
    return 20;
  }
}

function createStableLabelStyle(): LabelStyle {
  return {
    resolve(detection) {
      if (!detection.rect) {
        return undefined;
      }

      return {
        background: {
          alpha: 0.8,
          color: 0x111111,
          cornerRadius: 4,
          paddingX: 7,
          paddingY: 4,
        },
        rect: detection.rect,
        text: "player 93%",
        textStyle: {
          alpha: 1,
          color: 0xffffff,
          fontFamily: "Inter, sans-serif",
          fontSize: 14,
          fontWeight: "750",
        },
      };
    },
  };
}

function createBoxAwareLabelLayer(
  labelStyle: LabelStyle,
  frames: readonly DetectionFrame[] = [firstFrame],
  boxStyle: BoxStyle | null = new BaseBoxStyle(),
) {
  const detectionTimeline = createTimeline(frames);
  const boxLayer = createPixiBoxLayer({ detectionTimeline, boxStyle });
  boxLayer.attachGraphics(new FakeGraphics() as never);
  const layer = createPixiLabelLayer({
    Container: FakeContainer as never,
    Graphics: FakeGraphics as never,
    Text: FakeText as never,
    detectionTimeline,
    labelStyle,
    getRenderedBoxes: () => boxLayer.getRenderedBoxes(),
  });
  return {
    boxLayer,
    layer,
    container: layer.createContainer() as FakeContainer,
  };
}

function createTimeline(
  frames: readonly DetectionFrame[],
): BufferedDetectionTimeline {
  return {
    destroy() {},
    getBufferedFrames: () => frames,
    getState: () => ({
      bufferEndTime: frames.at(-1)?.mediaTime ?? null,
      bufferStartTime: frames[0]?.mediaTime ?? null,
      detectionCount: frames.reduce(
        (count, frame) => count + frame.detections.length,
        0,
      ),
      errorMessage: null,
      frameCount: frames.length,
      requestedEndTime: frames.at(-1)?.mediaTime ?? null,
      requestedStartTime: frames[0]?.mediaTime ?? null,
      status: "ready",
    }),
    prepare: async () => undefined,
    prefetch() {},
    selectFrame: (mediaTime: number) =>
      frames.find((frame) => frame.mediaTime === mediaTime),
  } as unknown as BufferedDetectionTimeline;
}
