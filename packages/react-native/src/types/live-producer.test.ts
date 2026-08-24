import { describe, expect, it } from "vitest";

import {
  DetectionMaskEncoding,
  KeypointVisibility,
  type DetectionFrame,
} from "supervision-js-core";

import { createReactNativeKeypointDrawInstructions } from "../renderers/keypoint-draw-instructions";
import { serializeReactNativeLiveDetectionFrame } from "../renderers/live-serialized-detections";
import type { ReactNativeLiveDetectionProducer } from "./live-producer";

/**
 * A producer for a model runtime the package has never heard of.
 *
 * This file deliberately imports nothing from `adapters/`. If a new runtime
 * could not be adopted without editing package internals, this test would not
 * compile — which is the property Phase 1 exists to establish.
 */
function createFakeRuntimeProducer(
  detect: (frame: { readonly ts: number }) => {
    readonly boxes: readonly {
      readonly h: number;
      readonly label: string;
      readonly mask?: Uint8Array;
      readonly w: number;
      readonly x: number;
      readonly y: number;
    }[];
  },
): ReactNativeLiveDetectionProducer {
  return {
    process(frame) {
      const typed = frame as { readonly ts: number };
      const result = detect(typed);

      return {
        detections: result.boxes.map((box) => ({
          className: box.label,
          confidence: 0.5,
          ...(box.mask
            ? {
                mask: {
                  data: box.mask,
                  encoding: DetectionMaskEncoding.DenseBitmap,
                  height: 2,
                  width: 2,
                } as const,
              }
            : {}),
          rect: { height: box.h, width: box.w, x: box.x, y: box.y },
        })),
        mediaTime: typed.ts / 1000,
      };
    },
  };
}

describe("ReactNativeLiveDetectionProducer", () => {
  it("lets an unrelated runtime reach the live fill path", () => {
    const producer = createFakeRuntimeProducer(() => ({
      boxes: [
        {
          h: 40,
          label: "forklift",
          mask: new Uint8Array([1, 1, 0, 0]),
          w: 20,
          x: 100,
          y: 200,
        },
      ],
    }));

    const serialized = serializeReactNativeLiveDetectionFrame(
      producer.process({ ts: 1500 }),
    );

    expect(serialized.detections).toEqual([
      {
        bbox: { x1: 90, x2: 110, y1: 180, y2: 220 },
        color: expect.any(Number),
        label: "forklift",
        mask: new Uint8Array([1, 1, 0, 0]),
        maskHeight: 2,
        maskRotatedCw: false,
        maskWidth: 2,
        score: 0.5,
      },
    ]);
  });

  it("lets an unrelated runtime reach the keypoint vector path", () => {
    const detectionFrame: DetectionFrame = {
      detections: [
        {
          className: "worker",
          keypoints: {
            edges: [[0, 1]],
            points: [
              { x: 10, y: 20 },
              { x: 30, y: 40 },
              { x: 50, y: 60 },
            ],
            visibility: [
              KeypointVisibility.Visible,
              KeypointVisibility.Visible,
              KeypointVisibility.NotLabeled,
            ],
          },
        },
      ],
      mediaTime: 0,
    };

    const instructions =
      createReactNativeKeypointDrawInstructions(detectionFrame);

    expect(instructions).toHaveLength(1);
    expect(instructions[0]!.edges).toHaveLength(1);
    // The unlabeled point is skipped, so two of three become markers.
    expect(instructions[0]!.markers).toHaveLength(2);
  });

  it("routes geometry independently of any task label", () => {
    // The same producer emits a masked box and a keypoint skeleton. Each
    // reaches its lane by what it carries, with nothing declaring a task.
    const detectionFrame: DetectionFrame = {
      detections: [
        {
          className: "pallet",
          rect: { height: 40, width: 20, x: 100, y: 200 },
        },
        {
          className: "worker",
          keypoints: { edges: [], points: [{ x: 1, y: 2 }] },
        },
      ],
      mediaTime: 0,
    };

    expect(
      serializeReactNativeLiveDetectionFrame(detectionFrame).detections,
    ).toHaveLength(1);
    expect(
      createReactNativeKeypointDrawInstructions(detectionFrame),
    ).toHaveLength(1);
  });
});
