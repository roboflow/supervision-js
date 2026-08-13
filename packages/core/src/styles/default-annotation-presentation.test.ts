import { describe, expect, it } from "vitest";

import {
  createDefaultAnnotationPresentation,
  createDefaultEllipseStyle,
} from "#styles/default-annotation-presentation";
import { createSourceAwarePresentation } from "#styles/source-presentation";
import { BoxShape } from "#types/box-style";
import { DetectionMaskEncoding, type DetectionFrame } from "#types/detections";

const frame: DetectionFrame = { detections: [], mediaTime: 0 };
const context = { detectionIndex: 0, frame, mediaTime: 0 };
const mask = {
  counts: "04",
  encoding: DetectionMaskEncoding.CompressedRle,
  height: 2,
  width: 2,
} as const;
const rect = { height: 20, width: 10, x: 5, y: 7 };

describe("createDefaultAnnotationPresentation", () => {
  it("matches the Core annotation visual language for every geometry", () => {
    const presentation = createDefaultAnnotationPresentation();
    const color = 0x22c55e;

    expect(
      presentation.boxStyle?.resolve({ className: "person", rect }, context),
    ).toEqual({
      cornerRadius: 1,
      fill: { alpha: 0.08, color },
      rect,
      shape: BoxShape.RoundedRect,
      stroke: { alpha: 1, color, width: 2 },
    });
    expect(
      createDefaultEllipseStyle().resolve(
        { className: "person", rect },
        context,
      ),
    ).toMatchObject({
      center: { x: 5, y: 15.25 },
      radiusX: 5,
      radiusY: 1.75,
    });
    expect(
      presentation.maskStyle?.resolve({ className: "person", mask }, context),
    ).toEqual({
      alpha: 0.45,
      color,
      mask,
      stroke: { alpha: 1, color, width: 2 },
    });
    expect(
      presentation.polygonStyle?.resolve(
        {
          className: "person",
          polygon: {
            points: [
              { x: 0, y: 0 },
              { x: 4, y: 0 },
              { x: 0, y: 4 },
            ],
          },
        },
        context,
      ),
    ).toMatchObject({
      fill: { alpha: 0.08, color },
      stroke: { alpha: 1, color, width: 2 },
    });
    expect(
      presentation.polylineStyle?.resolve(
        {
          className: "person",
          polyline: {
            points: [
              { x: 0, y: 0 },
              { x: 4, y: 4 },
            ],
          },
        },
        context,
      ),
    ).toMatchObject({ stroke: { alpha: 1, color, width: 2 } });
    const keypoints = presentation.keypointStyle?.resolve(
      {
        className: "person",
        keypoints: {
          edges: [[0, 1]],
          points: [
            { x: 0, y: 0 },
            { x: 4, y: 4 },
          ],
        },
      },
      context,
    );
    expect(keypoints?.edges[0]).toMatchObject({
      shadowStroke: { alpha: 0.25, color: 0x000000, width: 3 },
      stroke: { alpha: 1, color, width: 1.5 },
    });
    expect(keypoints?.markers[0]).toMatchObject({
      fill: { alpha: 1, color },
      radius: 3.5,
      stroke: { alpha: 1, color: 0xffffff, width: 1 },
    });
    expect(
      presentation.labelStyle?.resolve(
        { className: "person", confidence: 0.88, rect },
        context,
      ),
    ).toEqual({
      background: {
        alpha: 1,
        color,
        cornerRadius: 4,
        paddingX: 6,
        paddingY: 3,
        topCornersOnly: true,
      },
      offsetY: 0,
      placement: "top",
      rect,
      text: "person",
      textStyle: {
        alpha: 1,
        color: 0xffffff,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
        fontSize: 12,
        fontWeight: "600",
      },
    });
  });

  it("uses stable colors by default and accepts consumer class colors", () => {
    const defaultPresentation = createDefaultAnnotationPresentation();
    const customPresentation = createDefaultAnnotationPresentation({
      getClassColor: (className) =>
        className === "custom" ? 0x123456 : undefined,
      includeConfidence: true,
    });

    expect(
      defaultPresentation.boxStyle?.resolve(
        { className: "person", rect },
        context,
      )?.stroke?.color,
    ).toBe(0x22c55e);
    expect(
      customPresentation.boxStyle?.resolve(
        { className: "custom", rect },
        context,
      )?.stroke?.color,
    ).toBe(0x123456);
    expect(
      customPresentation.labelStyle?.resolve(
        { className: "custom", confidence: 0.88, rect },
        context,
      )?.text,
    ).toBe("custom 88%");
  });

  it("uses primary geometry instead of adding fallback rectangles", () => {
    const presentation = createDefaultAnnotationPresentation();

    for (const detection of [
      { className: "person", mask, rect },
      {
        className: "person",
        polygon: {
          points: [
            { x: 0, y: 0 },
            { x: 4, y: 0 },
            { x: 0, y: 4 },
          ],
        },
        rect,
      },
      {
        className: "person",
        polyline: {
          points: [
            { x: 0, y: 0 },
            { x: 4, y: 4 },
          ],
        },
        rect,
      },
      {
        className: "person",
        keypoints: { edges: [], points: [{ x: 0, y: 0 }] },
        rect,
      },
    ]) {
      expect(
        presentation.boxStyle?.resolve(detection, context),
      ).toBeUndefined();
      expect(
        presentation.labelStyle?.resolve(detection, context),
      ).toBeDefined();
    }
  });

  it("keeps explicit and source-specific styles ahead of the canonical defaults", () => {
    const defaults = createDefaultAnnotationPresentation();
    const override = {
      ...defaults,
      boxStyle: null,
    };
    const presentation = createSourceAwarePresentation(override, [
      {
        id: "draft",
        presentation: { labelStyle: null },
      },
    ]);

    expect(override.boxStyle).toBeNull();
    expect(
      presentation.labelStyle?.resolve(
        { className: "person", rect, sourceId: "draft" },
        context,
      ),
    ).toBeUndefined();
    expect(
      presentation.labelStyle?.resolve({ className: "person", rect }, context)
        ?.text,
    ).toBe("person");
  });
});
