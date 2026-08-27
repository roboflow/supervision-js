import { describe, expect, it, vi } from "vitest";

import {
  MarkerShape,
  MarkerSizeSpace,
  ShapeInstructionKind,
} from "supervision-js-core";
import { resolveAnnotationShapeStyle } from "#renderers/annotation-shape-styles";
import type {
  BoxCornerStyleContext,
  Detection,
  EllipseStyleContext,
} from "supervision-js-core";

const detection: Detection = {
  className: "player",
  rect: { height: 40, width: 30, x: 10, y: 20 },
};
const context: EllipseStyleContext = {
  detectionIndex: 0,
  frame: { detections: [detection], mediaTime: 0 },
  mediaTime: 0,
};
const boxCornerContext: BoxCornerStyleContext = context;

describe("annotation shape styles", () => {
  it("returns no shape style when no shape-backed kind is configured", () => {
    expect(resolveAnnotationShapeStyle({})).toBeNull();
    expect(resolveAnnotationShapeStyle({ ellipseStyle: null })).toBeNull();
  });

  it("lowers resolved ellipse instructions into the shape vocabulary", () => {
    const style = resolveAnnotationShapeStyle({
      ellipseStyle: {
        resolve: () => ({
          center: { x: 25, y: 60 },
          endAngle: 2,
          radiusX: 15,
          radiusY: 5,
          startAngle: -1,
          stroke: { alpha: 1, color: 0x123456, width: 2 },
        }),
      },
    });

    expect(style?.resolve(detection, context)).toEqual([
      {
        center: { x: 25, y: 60 },
        endAngle: 2,
        kind: ShapeInstructionKind.Ellipse,
        radiusX: 15,
        radiusY: 5,
        startAngle: -1,
        stroke: { alpha: 1, color: 0x123456, width: 2 },
      },
    ]);
  });

  it("lowers box-corner segments into one open path instruction", () => {
    const style = resolveAnnotationShapeStyle({
      boxCornerStyle: {
        resolve: () => ({
          segments: [
            [
              { x: 10, y: 20 },
              { x: 5, y: 20 },
              { x: 5, y: 25 },
            ],
          ],
          stroke: { alpha: 1, color: 0x123456, width: 2 },
        }),
      },
    });

    expect(style?.resolve(detection, boxCornerContext)).toEqual([
      {
        closed: false,
        kind: ShapeInstructionKind.Path,
        segments: [
          [
            { x: 10, y: 20 },
            { x: 5, y: 20 },
            { x: 5, y: 25 },
          ],
        ],
        stroke: { alpha: 1, color: 0x123456, width: 2 },
      },
    ]);
  });

  it("lowers semantic markers into shared marker instructions", () => {
    const style = resolveAnnotationShapeStyle({
      markerStyle: {
        resolve: () => ({
          center: { x: 20, y: 30 },
          fill: { alpha: 1, color: 0x123456 },
          shape: MarkerShape.Triangle,
          size: 16,
          sizeSpace: MarkerSizeSpace.Screen,
        }),
      },
    });

    expect(style?.resolve(detection, context)).toEqual([
      {
        center: { x: 20, y: 30 },
        fill: { alpha: 1, color: 0x123456 },
        kind: ShapeInstructionKind.Marker,
        shape: MarkerShape.Triangle,
        size: 16,
        sizeSpace: MarkerSizeSpace.Screen,
      },
    ]);
  });

  it("skips detections the ellipse style resolves to nothing", () => {
    const resolve = vi.fn(() => undefined);
    const style = resolveAnnotationShapeStyle({ ellipseStyle: { resolve } });

    expect(style?.resolve(detection, context)).toBeUndefined();
    expect(resolve).toHaveBeenCalledWith(detection, context);
  });

  it("preserves the shared closed-ellipse primitive contract", () => {
    const style = resolveAnnotationShapeStyle({
      ellipseStyle: {
        resolve: () => ({
          center: { x: 25, y: 60 },
          fill: { alpha: 0.2, color: 0x123456 },
          radiusX: 15,
          radiusY: 5,
          rotation: 0.25,
          stroke: { alpha: 1, color: 0xffffff, width: 2 },
        }),
      },
    });

    expect(style?.resolve(detection, context)).toEqual([
      {
        center: { x: 25, y: 60 },
        fill: { alpha: 0.2, color: 0x123456 },
        kind: ShapeInstructionKind.Ellipse,
        radiusX: 15,
        radiusY: 5,
        rotation: 0.25,
        stroke: { alpha: 1, color: 0xffffff, width: 2 },
      },
    ]);
  });

  it("lowers percentage bar geometry into background and value closed paths", () => {
    const style = resolveAnnotationShapeStyle({
      percentageBarStyle: {
        resolve: () => ({
          background: { alpha: 0.75, color: 0x0f172a },
          backgroundRect: { height: 10, width: 50, x: 25, y: 5 },
          fill: { alpha: 1, color: 0x00ff66 },
          value: 0.6,
          valueRect: { height: 10, width: 30, x: 15, y: 5 },
        }),
      },
    });

    expect(style?.resolve(detection, context)).toEqual([
      {
        closed: true,
        fill: { alpha: 0.75, color: 0x0f172a },
        kind: ShapeInstructionKind.Path,
        segments: [
          [
            { x: 0, y: 0 },
            { x: 50, y: 0 },
            { x: 50, y: 10 },
            { x: 0, y: 10 },
          ],
        ],
      },
      {
        closed: true,
        fill: { alpha: 1, color: 0x00ff66 },
        kind: ShapeInstructionKind.Path,
        segments: [
          [
            { x: 0, y: 0 },
            { x: 30, y: 0 },
            { x: 30, y: 10 },
            { x: 0, y: 10 },
          ],
        ],
      },
    ]);
  });
});
