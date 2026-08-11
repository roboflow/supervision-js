import { describe, expect, it } from "vitest";

import {
  BoxShape,
  BoxStrokeAlignment,
  createDefaultAnnotationPresentation,
  DetectionMaskEncoding,
  type Detection,
  DetectionPickTarget,
  DetectionInteractionState,
  FocusTargetMode,
  KeypointVisibility,
  LabelPlacement,
  MaskRenderMode,
} from "supervision";
import {
  constrainDemoPresentationSettings,
  createDemoPresentation,
  defaultDemoPresentationSettings,
  DemoBoxAnnotator,
  DemoKeypointAnnotator,
} from "./demo-presentation";

const detection: Detection = {
  className: "horse",
  confidence: 0.9,
  mask: {
    counts: "04",
    encoding: DetectionMaskEncoding.CompressedRle,
    height: 2,
    width: 2,
  },
  rect: { height: 40, width: 20, x: 10, y: 12 },
};

const rectangleDetection: Detection = {
  className: "horse",
  confidence: 0.9,
  rect: { height: 40, width: 20, x: 10, y: 12 },
};

const vectorDetection: Detection = {
  className: "person",
  confidence: 0.9,
  keypoints: {
    edges: [[0, 1]],
    points: [
      { x: 4, y: 4 },
      { x: 8, y: 8 },
      { x: 0, y: 0 },
    ],
    visibility: [
      KeypointVisibility.Visible,
      KeypointVisibility.Visible,
      KeypointVisibility.NotLabeled,
    ],
  },
  polygon: {
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
  },
  rect: { height: 10, width: 10, x: 5, y: 5 },
};

describe("demo presentation", () => {
  it("keeps unavailable fixture layers disabled", () => {
    const constrained = constrainDemoPresentationSettings(
      {
        ...defaultDemoPresentationSettings,
        keypointsEnabled: true,
        polygonsEnabled: true,
      },
      { keypointsEnabled: false, polygonsEnabled: false },
    );

    expect(constrained.keypointsEnabled).toBe(false);
    expect(constrained.polygonsEnabled).toBe(false);
    expect(constrained.labelsEnabled).toBe(
      defaultDemoPresentationSettings.labelsEnabled,
    );
  });

  it("uses the border radius slider as the only box shape control", () => {
    const rectPresentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      boxesEnabled: true,
      boxCornerRadius: 0,
    });
    const roundedPresentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      boxesEnabled: true,
      boxCornerRadius: 8,
    });

    expect(
      rectPresentation.boxStyle?.resolve(rectangleDetection, {
        detectionIndex: 0,
        frame: { detections: [rectangleDetection], mediaTime: 0 },
        mediaTime: 0,
      }),
    ).toMatchObject({
      shape: BoxShape.Rect,
    });
    expect(
      roundedPresentation.boxStyle?.resolve(rectangleDetection, {
        detectionIndex: 0,
        frame: { detections: [rectangleDetection], mediaTime: 0 },
        mediaTime: 0,
      }),
    ).toMatchObject({
      cornerRadius: 8,
      shape: BoxShape.RoundedRect,
    });
  });

  it("lowers the round box annotator to a rounded rectangle", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      boxAnnotator: DemoBoxAnnotator.RoundBox,
      boxCornerRadius: 12,
    });

    expect(
      presentation.boxStyle?.resolve(rectangleDetection, {
        detectionIndex: 0,
        frame: { detections: [rectangleDetection], mediaTime: 0 },
        mediaTime: 0,
      }),
    ).toMatchObject({
      cornerRadius: 12,
      shape: BoxShape.RoundedRect,
    });
  });

  it("lowers the circle annotator to a fully rounded square over the box diagonal", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      boxAnnotator: DemoBoxAnnotator.Circle,
    });
    const instruction = presentation.boxStyle?.resolve(rectangleDetection, {
      detectionIndex: 0,
      frame: { detections: [rectangleDetection], mediaTime: 0 },
      mediaTime: 0,
    });
    const side = Math.hypot(20, 40);

    expect(instruction?.shape).toBe(BoxShape.RoundedRect);
    expect(instruction?.rect.x).toBe(rectangleDetection.rect!.x);
    expect(instruction?.rect.y).toBe(rectangleDetection.rect!.y);
    expect(instruction?.rect.width).toBeCloseTo(side);
    expect(instruction?.rect.height).toBeCloseTo(side);
    expect(instruction?.cornerRadius).toBeCloseTo(side / 2);
  });

  it("lowers the ellipse annotator to a stroked ground marker at the box bottom", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      boxAnnotator: DemoBoxAnnotator.Ellipse,
    });
    const instruction = presentation.boxStyle?.resolve(rectangleDetection, {
      detectionIndex: 0,
      frame: { detections: [rectangleDetection], mediaTime: 0 },
      mediaTime: 0,
    });
    const markerHeight = 20 * 0.35;

    expect(instruction?.shape).toBe(BoxShape.RoundedRect);
    expect(instruction?.rect).toMatchObject({
      height: markerHeight,
      width: 20,
      x: rectangleDetection.rect!.x,
      y: rectangleDetection.rect!.y + 20,
    });
    expect(instruction?.cornerRadius).toBeCloseTo(markerHeight / 2);
    expect(instruction?.fill).toBeUndefined();
  });

  it("lowers the dot annotator to a screen-sized filled circle at the box center", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      boxAnnotator: DemoBoxAnnotator.Dot,
      boxDotRadius: 5,
    });
    const instruction = presentation.boxStyle?.resolve(rectangleDetection, {
      detectionIndex: 0,
      frame: { detections: [rectangleDetection], mediaTime: 0 },
      mediaTime: 0,
      viewportScale: 2,
    });

    expect(instruction?.shape).toBe(BoxShape.RoundedRect);
    expect(instruction?.rect).toMatchObject({
      height: 5,
      width: 5,
      x: rectangleDetection.rect!.x,
      y: rectangleDetection.rect!.y,
    });
    expect(instruction?.fill).toMatchObject({ alpha: 1 });
  });

  it("emphasizes hovered and selected dots through the interaction style", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      boxAnnotator: DemoBoxAnnotator.Dot,
      interactionSelectedStrokeWidth: 5,
    });
    const context = {
      detectionIndex: 0,
      frame: { detections: [rectangleDetection], mediaTime: 0 },
      mediaTime: 0,
      point: { x: 10, y: 12 },
      state: DetectionInteractionState.Selected,
      target: DetectionPickTarget.Box,
    };
    const base = presentation.boxStyle?.resolve(rectangleDetection, context);
    const selected = presentation.interactionStyle?.resolve(
      rectangleDetection,
      context,
    );

    expect(base?.stroke?.width).toBe(1);
    expect(
      selected?.boxStyle?.resolve(rectangleDetection, context)?.stroke?.width,
    ).toBe(5);
  });

  it("lowers the color annotator to a fill-only rectangle", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      boxAnnotator: DemoBoxAnnotator.Color,
      boxColorFillAlpha: 0.6,
    });
    const instruction = presentation.boxStyle?.resolve(rectangleDetection, {
      detectionIndex: 0,
      frame: { detections: [rectangleDetection], mediaTime: 0 },
      mediaTime: 0,
    });

    expect(instruction).toMatchObject({
      fill: { alpha: 0.6 },
      rect: rectangleDetection.rect,
      shape: BoxShape.Rect,
    });
    expect(instruction?.stroke).toBeUndefined();
  });

  it("lowers the box corner annotator to a per-detection dashed stroke", () => {
    const wideDetection: Detection = {
      className: "horse",
      confidence: 0.9,
      rect: { height: 60, width: 100, x: 50, y: 30 },
    };
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      boxAnnotator: DemoBoxAnnotator.BoxCorner,
      boxCornerLength: 15,
    });
    const instruction = presentation.boxStyle?.resolve(wideDetection, {
      detectionIndex: 0,
      frame: { detections: [wideDetection], mediaTime: 0 },
      mediaTime: 0,
      viewportScale: 1,
    });

    // Clockwise from the top-left vertex: half corner, gap, then full
    // corners across each remaining vertex.
    expect(instruction?.stroke?.dash).toEqual([
      15, 70, 30, 30, 30, 70, 30, 30, 15,
    ]);
    expect(instruction?.fill).toBeUndefined();
  });

  it("falls back to a solid border when box corner arms would overlap", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      boxAnnotator: DemoBoxAnnotator.BoxCorner,
      boxCornerLength: 15,
    });
    const instruction = presentation.boxStyle?.resolve(rectangleDetection, {
      detectionIndex: 0,
      frame: { detections: [rectangleDetection], mediaTime: 0 },
      mediaTime: 0,
      viewportScale: 1,
    });

    expect(instruction?.stroke?.dash).toBeUndefined();
    expect(instruction?.stroke).toBeDefined();
  });

  it("restricts keypoint annotator variants to vertices or edges", () => {
    const context = {
      detectionIndex: 0,
      frame: { detections: [vectorDetection], mediaTime: 0 },
      mediaTime: 0,
    };
    const verticesInstruction = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      keypointAnnotator: DemoKeypointAnnotator.Vertices,
    }).keypointStyle?.resolve(vectorDetection, context);
    const edgesInstruction = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      keypointAnnotator: DemoKeypointAnnotator.Edges,
    }).keypointStyle?.resolve(vectorDetection, context);
    const combinedInstruction = createDemoPresentation(
      defaultDemoPresentationSettings,
    ).keypointStyle?.resolve(vectorDetection, context);

    expect(verticesInstruction?.markers.length).toBeGreaterThan(0);
    expect(verticesInstruction?.edges).toEqual([]);
    expect(edgesInstruction?.edges.length).toBeGreaterThan(0);
    expect(edgesInstruction?.markers).toEqual([]);
    expect(combinedInstruction?.markers.length).toBeGreaterThan(0);
    expect(combinedInstruction?.edges.length).toBeGreaterThan(0);
  });

  it("renders enabled boxes for detections with other geometry", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      boxesEnabled: true,
    });

    for (const combinedDetection of [detection, vectorDetection]) {
      const context = {
        detectionIndex: 0,
        frame: { detections: [combinedDetection], mediaTime: 0 },
        mediaTime: 0,
      };

      expect(
        presentation.boxStyle?.resolve(combinedDetection, context),
      ).toMatchObject({ rect: combinedDetection.rect });
    }
  });

  it("removes the box style when boxes are disabled", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      boxesEnabled: false,
    });

    expect(presentation.boxStyle).toBeNull();
  });

  it("treats mask opacity as a cheap presentation knob", () => {
    const lowOpacityPresentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      maskOpacity: 0.2,
    });
    const highOpacityPresentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      maskOpacity: 0.8,
    });
    const context = {
      detectionIndex: 0,
      frame: { detections: [detection], mediaTime: 0 },
      mediaTime: 0,
    };

    expect(lowOpacityPresentation.maskStyle?.artifactKey).toBe(
      highOpacityPresentation.maskStyle?.artifactKey,
    );
    expect(lowOpacityPresentation.maskStyle?.opacity).toBe(0.2);
    expect(highOpacityPresentation.maskStyle?.opacity).toBe(0.8);
    expect(
      lowOpacityPresentation.maskStyle?.resolve(detection, context),
    ).toMatchObject({
      alpha: defaultDemoPresentationSettings.maskFillAlpha,
    });
  });

  it("can render a fully opaque mask when the fill and layer opacity are both 100%", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      maskFillAlpha: 1,
      maskOpacity: 1,
    });
    const context = {
      detectionIndex: 0,
      frame: { detections: [detection], mediaTime: 0 },
      mediaTime: 0,
    };

    expect(presentation.maskStyle?.opacity).toBe(1);
    expect(presentation.maskStyle?.resolve(detection, context)).toMatchObject({
      alpha: 1,
    });
  });

  it("matches the Core annotation presentation before demo controls override it", () => {
    const demo = createDemoPresentation(defaultDemoPresentationSettings);
    const canonical = createDefaultAnnotationPresentation();
    const frame = { detections: [detection, vectorDetection], mediaTime: 0 };
    const context = { detectionIndex: 0, frame, mediaTime: 0 };
    const rectangle = {
      className: "person",
      confidence: 0.9,
      rect: { height: 40, width: 20, x: 10, y: 12 },
    };
    const polyline = {
      className: "person",
      polyline: {
        points: [
          { x: 0, y: 0 },
          { x: 4, y: 4 },
        ],
      },
    };

    expect(demo.backgroundColor).toBe(0xf3f4f6);
    expect(demo.boxStyle?.resolve(rectangle, context)).toEqual(
      canonical.boxStyle?.resolve(rectangle, context),
    );
    expect(demo.maskStyle?.resolve(detection, context)).toEqual(
      canonical.maskStyle?.resolve(detection, context),
    );
    expect(demo.labelStyle?.resolve(detection, context)).toEqual(
      canonical.labelStyle?.resolve(detection, context),
    );
    expect(demo.polygonStyle?.resolve(vectorDetection, context)).toEqual(
      canonical.polygonStyle?.resolve(vectorDetection, context),
    );
    expect(demo.polylineStyle?.resolve(polyline, context)).toEqual(
      canonical.polylineStyle?.resolve(polyline, context),
    );
    expect(demo.keypointStyle?.resolve(vectorDetection, context)).toEqual(
      canonical.keypointStyle?.resolve(vectorDetection, context),
    );
  });

  it("maps demo style controls to renderer-neutral draw instructions", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      boxesEnabled: true,
      boxStrokeAlignment: BoxStrokeAlignment.Inside,
      labelCornerRadius: 9,
      labelOffsetX: 3,
      labelOffsetY: 5,
      labelPaddingX: 11,
      labelPaddingY: 6,
      labelPlacement: LabelPlacement.Bottom,
      maskMode: MaskRenderMode.StrokeOnly,
    });
    const context = {
      detectionIndex: 0,
      frame: { detections: [detection], mediaTime: 0 },
      mediaTime: 0,
    };

    expect(presentation.backgroundColor).toBe(0xf3f4f6);

    expect(
      presentation.boxStyle?.resolve(rectangleDetection, context),
    ).toMatchObject({ stroke: { alignment: BoxStrokeAlignment.Inside } });
    expect(presentation.labelStyle?.resolve(detection, context)).toMatchObject({
      background: {
        cornerRadius: 9,
        paddingX: 11,
        paddingY: 6,
      },
      offsetX: 3,
      offsetY: 5,
      placement: LabelPlacement.Bottom,
    });
    expect(presentation.maskStyle?.resolve(detection, context)).toMatchObject({
      alpha: 0,
      stroke: {
        width: defaultDemoPresentationSettings.maskStrokeWidth,
      },
    });
  });

  it("keeps mask-only interaction picking free of box highlights", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      boxesEnabled: false,
    });
    const frame = { detections: [detection], mediaTime: 0 };
    const hoverPresentation = presentation.interactionStyle?.resolve(
      detection,
      {
        detectionIndex: 0,
        frame,
        mediaTime: 0,
        point: { x: 12, y: 14 },
        state: DetectionInteractionState.Hovered,
        target: DetectionPickTarget.Mask,
      },
    );

    expect(
      hoverPresentation?.boxStyle?.resolve(detection, {
        detectionIndex: 0,
        frame,
        mediaTime: 0,
      }),
    ).toBeUndefined();
    expect(
      hoverPresentation?.maskStyle?.resolve(detection, {
        detectionIndex: 0,
        frame,
        mediaTime: 0,
      }),
    ).toMatchObject({
      alpha: defaultDemoPresentationSettings.interactionHoverFillAlpha,
      stroke: {
        width: defaultDemoPresentationSettings.interactionHoverStrokeWidth,
      },
    });
  });

  it("creates class-aware hover and selected interaction presentations", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      boxesEnabled: true,
    });
    const frame = { detections: [detection], mediaTime: 0 };
    const hoverPresentation = presentation.interactionStyle?.resolve(
      detection,
      {
        detectionIndex: 0,
        frame,
        mediaTime: 0,
        point: { x: 12, y: 14 },
        state: DetectionInteractionState.Hovered,
        target: DetectionPickTarget.Mask,
      },
    );
    const selectedPresentation = presentation.interactionStyle?.resolve(
      detection,
      {
        detectionIndex: 0,
        frame,
        mediaTime: 0,
        point: { x: 12, y: 14 },
        state: DetectionInteractionState.Selected,
        target: DetectionPickTarget.Mask,
      },
    );

    const hoverBox = hoverPresentation?.boxStyle?.resolve(detection, {
      detectionIndex: 0,
      frame,
      mediaTime: 0,
    });
    const selectedBox = selectedPresentation?.boxStyle?.resolve(detection, {
      detectionIndex: 0,
      frame,
      mediaTime: 0,
    });
    const hoverMask = hoverPresentation?.maskStyle?.resolve(detection, {
      detectionIndex: 0,
      frame,
      mediaTime: 0,
    });
    const selectedMask = selectedPresentation?.maskStyle?.resolve(detection, {
      detectionIndex: 0,
      frame,
      mediaTime: 0,
    });

    expect(hoverBox).toMatchObject({
      fill: {
        alpha: defaultDemoPresentationSettings.interactionHoverFillAlpha,
        color: 0x38bdf8,
      },
      stroke: {
        alpha: 1,
        color: 0x38bdf8,
      },
    });
    expect(selectedBox).toMatchObject({
      fill: {
        alpha: defaultDemoPresentationSettings.interactionSelectedFillAlpha,
        color: 0x38bdf8,
      },
      stroke: {
        alpha: 1,
        color: 0x38bdf8,
      },
    });
    expect(hoverMask).toMatchObject({
      alpha: defaultDemoPresentationSettings.interactionHoverFillAlpha,
      color: 0x38bdf8,
      stroke: {
        color: 0x38bdf8,
      },
    });
    expect(selectedMask).toMatchObject({
      alpha: defaultDemoPresentationSettings.interactionSelectedFillAlpha,
      color: 0x38bdf8,
      stroke: {
        alpha: 1,
        color: 0x38bdf8,
      },
    });
    expect(selectedBox?.stroke?.width).toBeGreaterThan(
      hoverBox?.stroke?.width ?? 0,
    );
    expect(selectedMask?.stroke?.width).toBeGreaterThan(
      hoverMask?.stroke?.width ?? 0,
    );
  });

  it("toggles each vector layer independently without touching the other styles", () => {
    const allEnabled = createDemoPresentation(defaultDemoPresentationSettings);
    const polygonsOnly = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      keypointsEnabled: false,
    });
    const keypointsOnly = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      polygonsEnabled: false,
    });

    expect(allEnabled.polygonStyle).toBeTruthy();
    expect(allEnabled.keypointStyle).toBeTruthy();
    expect(polygonsOnly.polygonStyle).toBeTruthy();
    expect(polygonsOnly.keypointStyle).toBeNull();
    expect(keypointsOnly.polygonStyle).toBeNull();
    expect(keypointsOnly.keypointStyle).toBeTruthy();
    expect(keypointsOnly.maskStyle).toBeTruthy();
    expect(keypointsOnly.labelStyle).toBeTruthy();
  });

  it("maps polygon controls onto class-aware polygon draw instructions", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      polygonFillAlpha: 0.3,
      polygonStrokeWidth: 6,
    });
    const context = {
      detectionIndex: 0,
      frame: { detections: [vectorDetection], mediaTime: 0 },
      mediaTime: 0,
    };

    expect(
      presentation.polygonStyle?.resolve(vectorDetection, context),
    ).toMatchObject({
      fill: { alpha: 0.3 },
      points: vectorDetection.polygon!.points,
      stroke: { width: 6 },
    });
  });

  it("renders keypoint markers and edges while skipping not-labeled points", () => {
    const personStyle = {
      fill: 0x123456,
      labelBackground: 0x234567,
      labelText: 0xffffff,
      stroke: 0xfacc15,
    };
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      classStyles: {
        ...defaultDemoPresentationSettings.classStyles,
        person: personStyle,
      },
      keypointEdgeWidth: 4,
      keypointRadius: 7,
    });
    const context = {
      detectionIndex: 0,
      frame: { detections: [vectorDetection], mediaTime: 0 },
      mediaTime: 0,
    };
    const instruction = presentation.keypointStyle?.resolve(
      vectorDetection,
      context,
    );

    expect(instruction?.markers).toHaveLength(2);
    expect(instruction?.markers[0]).toMatchObject({
      fill: { color: personStyle.fill },
      radius: 7,
      stroke: { color: 0xffffff },
    });
    expect(instruction?.edges).toHaveLength(1);
    expect(instruction?.edges[0]).toMatchObject({
      stroke: { color: personStyle.stroke, width: 4 },
    });
    expect(instruction?.edges[0]?.shadowStroke).toMatchObject({
      alpha: 0.25,
      color: 0x000000,
      width: 3,
    });
  });

  it("filters vector layers through the shared confidence threshold", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      confidenceThreshold: 0.95,
    });
    const context = {
      detectionIndex: 0,
      frame: { detections: [vectorDetection], mediaTime: 0 },
      mediaTime: 0,
    };

    expect(
      presentation.polygonStyle?.resolve(vectorDetection, context),
    ).toBeUndefined();
    expect(
      presentation.keypointStyle?.resolve(vectorDetection, context),
    ).toBeUndefined();
  });

  it("hides detections whose class is excluded from visibility", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      hiddenClasses: ["person"],
    });
    const hiddenContext = {
      detectionIndex: 0,
      frame: { detections: [vectorDetection], mediaTime: 0 },
      mediaTime: 0,
    };
    const visibleContext = {
      detectionIndex: 0,
      frame: { detections: [detection], mediaTime: 0 },
      mediaTime: 0,
    };

    expect(
      presentation.boxStyle?.resolve(vectorDetection, hiddenContext),
    ).toBeUndefined();
    expect(
      presentation.polygonStyle?.resolve(vectorDetection, hiddenContext),
    ).toBeUndefined();
    expect(
      presentation.keypointStyle?.resolve(vectorDetection, hiddenContext),
    ).toBeUndefined();
    expect(
      presentation.labelStyle?.resolve(vectorDetection, hiddenContext),
    ).toBeUndefined();

    expect(
      presentation.boxStyle?.resolve(detection, visibleContext),
    ).toBeDefined();
    expect(
      presentation.maskStyle?.resolve(detection, visibleContext),
    ).toBeDefined();
    expect(
      presentation.labelStyle?.resolve(detection, visibleContext),
    ).toBeDefined();
  });

  it("keeps detections without a class name visible when classes are hidden", () => {
    const unnamedDetection: Detection = {
      confidence: 0.9,
      rect: { height: 40, width: 20, x: 10, y: 12 },
    };
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      hiddenClasses: ["person", "horse", "cow"],
    });

    expect(
      presentation.boxStyle?.resolve(unnamedDetection, {
        detectionIndex: 0,
        frame: { detections: [unnamedDetection], mediaTime: 0 },
        mediaTime: 0,
      }),
    ).toBeDefined();
  });

  it("invalidates the mask artifact key when hidden classes change", () => {
    const basePresentation = createDemoPresentation(
      defaultDemoPresentationSettings,
    );
    const filteredPresentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      hiddenClasses: ["horse"],
    });

    expect(filteredPresentation.maskStyle?.artifactKey).not.toBe(
      basePresentation.maskStyle?.artifactKey,
    );
  });

  it("highlights picked polygon and keypoint targets through the interaction style", () => {
    const personStyle = {
      fill: 0x123456,
      labelBackground: 0x234567,
      labelText: 0xffffff,
      stroke: 0xfacc15,
    };
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      classStyles: {
        ...defaultDemoPresentationSettings.classStyles,
        person: personStyle,
      },
    });
    const frame = { detections: [vectorDetection], mediaTime: 0 };
    const hoverPresentation = presentation.interactionStyle?.resolve(
      vectorDetection,
      {
        detectionIndex: 0,
        frame,
        mediaTime: 0,
        point: { x: 5, y: 5 },
        state: DetectionInteractionState.Hovered,
        target: DetectionPickTarget.Polygon,
      },
    );
    const context = { detectionIndex: 0, frame, mediaTime: 0 };

    expect(
      hoverPresentation?.polygonStyle?.resolve(vectorDetection, context),
    ).toMatchObject({
      fill: {
        alpha: defaultDemoPresentationSettings.interactionHoverFillAlpha,
      },
      stroke: {
        width: defaultDemoPresentationSettings.interactionHoverStrokeWidth,
      },
    });
    const keypointInstruction = hoverPresentation?.keypointStyle?.resolve(
      vectorDetection,
      context,
    );

    expect(keypointInstruction?.markers).toHaveLength(2);
    expect(keypointInstruction?.markers[0]).toMatchObject({
      fill: { color: personStyle.fill },
      stroke: { color: 0xffffff },
    });
    expect(keypointInstruction?.edges[0]).toMatchObject({
      stroke: { color: personStyle.stroke },
    });
    expect(keypointInstruction?.edges[0]?.shadowStroke).toMatchObject({
      alpha: 0.25,
      color: 0x000000,
      width: 3,
    });
  });

  it("creates a selected-or-hovered focus style for dimming the surrounding frame", () => {
    const presentation = createDemoPresentation(
      defaultDemoPresentationSettings,
    );
    const frame = { detections: [detection], mediaTime: 0 };
    const selectedPick = {
      detection,
      detectionIndex: 0,
      frame,
      mediaTime: 0,
      point: { x: 12, y: 14 },
      target: DetectionPickTarget.Mask,
    };

    expect(
      presentation.focusStyle?.resolve({
        frame,
        hoveredPick: null,
        mediaTime: 0,
        selectedPick,
      }),
    ).toMatchObject({
      fill: {
        alpha: defaultDemoPresentationSettings.focusDimAlpha,
        color: defaultDemoPresentationSettings.focusDimColor,
      },
      targetMode: FocusTargetMode.Ambient,
      targets: [selectedPick],
    });
  });

  it("keeps ambient focus targets aligned with the confidence filter", () => {
    const visibleDetection = {
      className: "horse",
      confidence: 0.9,
      rect: { height: 20, width: 20, x: 20, y: 20 },
    };
    const filteredDetection = {
      className: "horse",
      confidence: 0.4,
      rect: { height: 20, width: 20, x: 50, y: 50 },
    };
    const frame = {
      detections: [visibleDetection, filteredDetection],
      mediaTime: 0,
    };
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      confidenceThreshold: 0.5,
    });

    expect(
      presentation.focusStyle?.resolve({
        frame,
        hoveredPick: null,
        mediaTime: 0,
        selectedPick: null,
      }),
    ).toMatchObject({
      ambient: true,
      targets: [expect.objectContaining({ detection: visibleDetection })],
    });

    expect(
      presentation.focusStyle?.resolve({
        frame,
        hoveredPick: null,
        mediaTime: 0,
        selectedPick: {
          detection: filteredDetection,
          detectionIndex: 1,
          frame,
          mediaTime: 0,
          point: { x: 50, y: 50 },
          target: DetectionPickTarget.Box,
        },
      }),
    ).toMatchObject({
      ambient: true,
      targets: [expect.objectContaining({ detection: visibleDetection })],
    });

    const hiddenPresentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      confidenceThreshold: 1,
    });

    expect(
      hiddenPresentation.focusStyle?.resolve({
        frame,
        hoveredPick: null,
        mediaTime: 0,
        selectedPick: null,
      }),
    ).toBeUndefined();
  });

  it("maps demo focus controls to target mode, tone, and fallback geometry", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      focusCornerRadius: 0,
      focusDimAlpha: 0.62,
      focusDimColor: 0x111827,
      focusTargetMode: FocusTargetMode.HoveredAndSelected,
    });
    const frame = { detections: [detection], mediaTime: 0 };
    const selectedPick = {
      detection,
      detectionIndex: 0,
      frame,
      mediaTime: 0,
      point: { x: 12, y: 14 },
      target: DetectionPickTarget.Box,
    };
    const hoveredPick = {
      detection,
      detectionIndex: 0,
      frame,
      mediaTime: 0,
      point: { x: 16, y: 18 },
      target: DetectionPickTarget.Mask,
    };

    expect(
      presentation.focusStyle?.resolve({
        frame,
        hoveredPick,
        mediaTime: 0,
        selectedPick,
      }),
    ).toMatchObject({
      fallback: {
        shape: BoxShape.Rect,
      },
      fill: {
        alpha: 0.62,
        color: 0x111827,
      },
      targetMode: FocusTargetMode.HoveredAndSelected,
      targets: [selectedPick, hoveredPick],
    });
  });
});
