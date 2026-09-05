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
  MarkerShape,
  MaskRenderMode,
} from "supervision";
import {
  constrainDemoPresentationSettings,
  createDemoPresentation,
  defaultDemoPresentationSettings,
  demoPresentationDrawsAnnotations,
} from "./demo-presentation";
import { docsRegionPlaygroundPresentationSettings } from "../docs-annotation-renderer";
import {
  createRegionPlaygroundRenderers,
  initialRegionPlaygroundSettings,
} from "../docs-region-annotation-renderer";
import {
  createRegionEffectsPlaygroundPresentation,
  initialRegionEffectsPlaygroundSettings,
} from "../docs-region-effects";

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

const maskOnlyDetection: Detection = {
  className: "horse",
  confidence: 0.9,
  mask: {
    counts: "04",
    encoding: DetectionMaskEncoding.CompressedRle,
    height: 2,
    width: 2,
  },
};

const polygonOnlyDetection: Detection = {
  className: "court",
  confidence: 0.9,
  polygon: {
    points: [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
    ],
  },
};

const geometrylessDetection: Detection = {
  className: "horse",
  confidence: 0.9,
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

  it("places the ellipse footprint below a center-based detection rect", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      ellipsesEnabled: true,
    });

    expect(
      presentation.ellipseStyle?.resolve(rectangleDetection, {
        detectionIndex: 0,
        frame: { detections: [rectangleDetection], mediaTime: 0 },
        mediaTime: 0,
      }),
    ).toMatchObject({
      center: { x: 10, y: 28.5 },
      radiusX: 10,
      radiusY: 3.5,
    });
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
    expect(demo.renderers?.map((renderer) => renderer.kind)).toEqual([
      "box",
      "mask",
      "polygon",
      "polyline",
      "keypoints",
      "label",
    ]);
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

  it("keeps the label when no geometry layer is enabled", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      boxesEnabled: false,
      keypointsEnabled: false,
      labelsEnabled: true,
      masksEnabled: false,
      polygonsEnabled: false,
      polylinesEnabled: false,
    });
    const context = {
      detectionIndex: 0,
      frame: { detections: [detection], mediaTime: 0 },
      mediaTime: 0,
    };

    expect(presentation.labelStyle?.resolve(detection, context)).toMatchObject({
      rect: detection.rect,
      text: "horse",
    });
    expect(
      presentation.labelStyle?.resolve(geometrylessDetection, {
        ...context,
        frame: { detections: [geometrylessDetection], mediaTime: 0 },
      }),
    ).toBeUndefined();
    expect(
      presentation.interactionStyle?.resolve(geometrylessDetection, {
        ...context,
        frame: { detections: [geometrylessDetection], mediaTime: 0 },
        point: { x: 12, y: 14 },
        state: DetectionInteractionState.Hovered,
        target: DetectionPickTarget.Box,
      }),
    ).toBeUndefined();
  });

  it("anchors the label on carried geometry the enabled layer does not draw", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      boxesEnabled: false,
      keypointsEnabled: true,
      labelsEnabled: true,
      masksEnabled: false,
      polygonsEnabled: false,
      polylinesEnabled: false,
    });
    const frame = {
      detections: [rectangleDetection, polygonOnlyDetection],
      mediaTime: 0,
    };

    expect(
      presentation.labelStyle?.resolve(rectangleDetection, {
        detectionIndex: 0,
        frame,
        mediaTime: 0,
      }),
    ).toMatchObject({ rect: rectangleDetection.rect, text: "horse" });
    expect(
      presentation.labelStyle?.resolve(polygonOnlyDetection, {
        detectionIndex: 1,
        frame,
        mediaTime: 0,
      }),
    ).toMatchObject({
      rect: { height: 10, width: 20, x: 10, y: 5 },
      text: "court",
    });
  });

  it("keeps the hover highlight for a detection carrying only a mask", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      boxesEnabled: false,
      keypointsEnabled: false,
      masksEnabled: true,
      polygonsEnabled: false,
      polylinesEnabled: false,
    });

    expect(
      presentation.interactionStyle?.resolve(maskOnlyDetection, {
        detectionIndex: 0,
        frame: { detections: [maskOnlyDetection], mediaTime: 0 },
        mediaTime: 0,
        point: { x: 12, y: 14 },
        state: DetectionInteractionState.Hovered,
        target: DetectionPickTarget.Mask,
      })?.maskStyle,
    ).toBeTruthy();
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
    expect(
      polygonsOnly.renderers?.map((renderer) => renderer.kind),
    ).not.toContain("keypoints");
    expect(
      keypointsOnly.renderers?.map((renderer) => renderer.kind),
    ).not.toContain("polygon");
  });

  it("maps marker shape and bounding-box position onto the marker style", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      markerPosition: "top-left",
      markerShape: MarkerShape.Triangle,
      markersEnabled: true,
    });

    expect(
      presentation.markerStyle?.resolve(rectangleDetection, {
        detectionIndex: 0,
        frame: { detections: [rectangleDetection], mediaTime: 0 },
        mediaTime: 0,
      }),
    ).toMatchObject({
      center: { x: 0, y: -8 },
      shape: MarkerShape.Triangle,
    });
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

  it("filters a trajectory on the track's confidence and every other layer on the frame's", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      confidenceThreshold: 0.5,
    });
    const weakFrameOfStrongTrack: Detection = {
      className: "basketball",
      confidence: 0.11,
      metadata: { trajectoryConfidence: 0.86 },
      polyline: {
        points: [
          { x: 0, y: 0 },
          { x: 4, y: 4 },
        ],
      },
      rect: { height: 34, width: 34, x: 10, y: 12 },
    };
    const strongFrameOfWeakTrack: Detection = {
      ...weakFrameOfStrongTrack,
      confidence: 0.9,
      metadata: { trajectoryConfidence: 0.17 },
    };
    const context = {
      detectionIndex: 0,
      frame: { detections: [weakFrameOfStrongTrack], mediaTime: 0 },
      mediaTime: 0,
    };

    expect(
      presentation.polylineStyle?.resolve(weakFrameOfStrongTrack, context),
    ).toBeDefined();
    expect(
      presentation.boxStyle?.resolve(weakFrameOfStrongTrack, context),
    ).toBeUndefined();
    expect(
      presentation.polylineStyle?.resolve(strongFrameOfWeakTrack, context),
    ).toBeUndefined();
  });

  it("draws a trajectory over a contrast stroke so it reads on any media", () => {
    const presentation = createDemoPresentation(
      defaultDemoPresentationSettings,
    );
    const trajectory: Detection = {
      className: "basketball",
      confidence: 0.9,
      polyline: {
        points: [
          { x: 0, y: 0 },
          { x: 4, y: 4 },
        ],
      },
    };

    expect(
      presentation.polylineStyle?.resolve(trajectory, {
        detectionIndex: 0,
        frame: { detections: [trajectory], mediaTime: 0 },
        mediaTime: 0,
      })?.shadowStroke,
    ).toMatchObject({ alpha: 0.55, color: 0x000000 });
  });

  it("keeps the class color the majority of the drawn trajectory", () => {
    const presentation = createDemoPresentation(
      defaultDemoPresentationSettings,
    );
    const trajectory = {
      className: "basketball",
      confidence: 0.9,
      polyline: {
        points: [
          { x: 0, y: 0 },
          { x: 4, y: 4 },
        ],
      },
    };
    const resolved = presentation.polylineStyle?.resolve(trajectory, {
      detectionIndex: 0,
      frame: { detections: [trajectory], mediaTime: 0 },
      mediaTime: 0,
    });
    const strokeWidth = resolved?.stroke?.width ?? 0;
    const shadowWidth = resolved?.shadowStroke?.width ?? 0;

    expect(shadowWidth).toBeGreaterThan(strokeWidth);
    expect(shadowWidth).toBeLessThan(strokeWidth * 2);
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

  it("routes class visibility through the renderer-owned contract", () => {
    const presentation = createDemoPresentation({
      ...defaultDemoPresentationSettings,
      hiddenClasses: ["person", "cow"],
    });

    expect(presentation.visibility).toEqual({
      hiddenClasses: ["person", "cow"],
    });
    // Styles keep confidence as their only local predicate; the mask
    // artifact key never encodes class visibility, so the backend owns
    // hidden-class invalidation.
    expect(
      presentation.maskStyle && "artifactKey" in presentation.maskStyle
        ? presentation.maskStyle.artifactKey
        : "",
    ).toBe(
      createDemoPresentation(defaultDemoPresentationSettings).maskStyle
        ?.artifactKey,
    );
  });

  it("hides detections in demo-owned styles when the context marks them hidden", () => {
    const presentation = createDemoPresentation(
      defaultDemoPresentationSettings,
    );
    const context = {
      detectionIndex: 0,
      frame: { detections: [rectangleDetection], mediaTime: 0 },
      hidden: true,
      mediaTime: 0,
    };

    expect(
      presentation.boxStyle?.resolve(rectangleDetection, context),
    ).toBeUndefined();
    expect(
      presentation.labelStyle?.resolve(rectangleDetection, context),
    ).toBeUndefined();
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

describe("demo annotation demand", () => {
  const withoutLayers = {
    ...defaultDemoPresentationSettings,
    boxesEnabled: false,
    boxCornersEnabled: false,
    ellipsesEnabled: false,
    focusEnabled: false,
    keypointsEnabled: false,
    labelsEnabled: false,
    maskHaloEnabled: false,
    masksEnabled: false,
    markersEnabled: false,
    polygonsEnabled: false,
    polylinesEnabled: false,
  };

  it("reports no demand only once every layer is switched off", () => {
    expect(
      demoPresentationDrawsAnnotations(
        createDemoPresentation(defaultDemoPresentationSettings),
      ),
    ).toBe(true);
    expect(
      demoPresentationDrawsAnnotations(createDemoPresentation(withoutLayers)),
    ).toBe(false);

    for (const layer of [
      "polylinesEnabled",
      "maskHaloEnabled",
      "focusEnabled",
    ] as const) {
      expect(
        demoPresentationDrawsAnnotations(
          createDemoPresentation({ ...withoutLayers, [layer]: true }),
        ),
      ).toBe(true);
    }
  });

  it("reports demand for renderers a docs playground composed itself", () => {
    const base = createDemoPresentation({
      ...withoutLayers,
      ...docsRegionPlaygroundPresentationSettings,
    });

    expect(demoPresentationDrawsAnnotations(base)).toBe(false);
    expect(
      demoPresentationDrawsAnnotations(
        createRegionEffectsPlaygroundPresentation(
          initialRegionEffectsPlaygroundSettings,
          base,
        ),
      ),
    ).toBe(true);
    expect(
      demoPresentationDrawsAnnotations({
        ...base,
        renderers: createRegionPlaygroundRenderers(
          initialRegionPlaygroundSettings,
          {
            fireGif: "fire.gif",
            whiteTeamBadge: "white-team-badge.svg",
            yellowTeamBadge: "yellow-team-badge.svg",
          },
        ),
      }),
    ).toBe(true);
  });
});
