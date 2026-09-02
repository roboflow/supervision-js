import { describe, expect, it } from "vitest";

import {
  DetectionMaskEncoding,
  type DetectionFrame,
} from "supervision-js-core";

import {
  createExecutorchLiveSegmentationProcessor,
  createExecutorchLiveSegmentationProducer,
} from "../adapters/executorch";
import {
  serializeReactNativeLiveDetection,
  serializeReactNativeLiveDetectionFrame,
} from "./live-serialized-detections";

const rawDetection = {
  bbox: { x1: 10, y1: 20, x2: 50, y2: 100 },
  label: "person",
  mask: new Uint8Array([1, 0, 0, 1, 0, 0]),
  maskHeight: 3,
  maskWidth: 2,
  score: 0.9,
};

describe("serializeReactNativeLiveDetectionFrame", () => {
  it("reproduces exactly what the live segmentation processor emits today", () => {
    // The device runs the processor path. Whatever the producer plus this
    // bridge yield must be identical, or switching the hook changes what is
    // drawn.
    const runOnFrame = () => [rawDetection];
    const frame = { height: 200, timestamp: 1_000_000_000 };

    const viaProcessor = createExecutorchLiveSegmentationProcessor({
      framePixelsAreUpright: true,
      runOnFrame,
    }).process(frame);
    const viaProducer = serializeReactNativeLiveDetectionFrame(
      createExecutorchLiveSegmentationProducer({
        framePixelsAreUpright: true,
        runOnFrame,
      }).process(frame),
    );

    expect(viaProducer.detections).toEqual(viaProcessor);
  });

  it("matches the processor for a frame that is not reported upright", () => {
    const runOnFrame = () => [rawDetection];
    const frame = { timestamp: 0 };

    const viaProcessor = createExecutorchLiveSegmentationProcessor({
      runOnFrame,
    }).process(frame);
    const viaProducer = serializeReactNativeLiveDetectionFrame(
      createExecutorchLiveSegmentationProducer({ runOnFrame }).process(frame),
    );

    expect(viaProducer.detections).toEqual(viaProcessor);
  });

  it("passes mask buffers by reference rather than copying them", () => {
    const detectionFrame: DetectionFrame = {
      detections: [
        {
          className: "ball",
          mask: {
            data: rawDetection.mask,
            encoding: DetectionMaskEncoding.DenseBitmap,
            height: 3,
            width: 2,
          },
          rect: { height: 80, width: 40, x: 30, y: 60 },
        },
      ],
      mediaTime: 0,
    };

    const { detections } =
      serializeReactNativeLiveDetectionFrame(detectionFrame);
    const serialized = detections[0];

    expect(serialized!.mask).toBe(rawDetection.mask);
  });

  it("converts a center rect back into corner bbox coordinates", () => {
    const serialized = serializeReactNativeLiveDetection({
      className: "person",
      rect: { height: 80, width: 40, x: 30, y: 60 },
    });

    expect(serialized!.bbox).toEqual({ x1: 10, x2: 50, y1: 20, y2: 100 });
  });

  it("reports stored buffer dimensions, swapped back for a rotated mask", () => {
    const serialized = serializeReactNativeLiveDetection({
      className: "person",
      mask: {
        data: rawDetection.mask,
        encoding: DetectionMaskEncoding.DenseBitmap,
        // Logical dims; the stored buffer is 2 wide and 3 tall.
        height: 2,
        rotatedCw: true,
        width: 3,
      },
      rect: { height: 80, width: 40, x: 30, y: 60 },
    });

    expect(serialized).toMatchObject({
      maskHeight: 3,
      maskRotatedCw: true,
      maskWidth: 2,
    });
  });

  it("drops detections without a rectangle", () => {
    // Pose detections have keypoints and no rect; they render through the
    // vector lane, not the bbox-indexed mask fill.
    expect(
      serializeReactNativeLiveDetectionFrame({
        detections: [{ className: "person" }],
        mediaTime: 0,
      }),
    ).toEqual({ detections: [], skippedRleMaskCount: 0 });
  });

  it("treats a cold-storage RLE mask as no mask", () => {
    const serialized = serializeReactNativeLiveDetection({
      className: "person",
      mask: {
        counts: "021",
        encoding: DetectionMaskEncoding.CompressedRle,
        height: 2,
        width: 2,
      },
      rect: { height: 80, width: 40, x: 30, y: 60 },
    });

    expect(serialized).toMatchObject({ maskHeight: 0, maskWidth: 0 });
    expect(serialized!.mask).toHaveLength(0);
  });

  it("counts skipped RLE masks so a producer can tell they were dropped", () => {
    // The detection still renders its box; only the mask is missing. Without a
    // count that is indistinguishable from a model that produced no mask.
    const result = serializeReactNativeLiveDetectionFrame({
      detections: [
        {
          className: "person",
          mask: {
            counts: "021",
            encoding: DetectionMaskEncoding.CompressedRle,
            height: 2,
            width: 2,
          },
          rect: { height: 80, width: 40, x: 30, y: 60 },
        },
        {
          className: "ball",
          mask: {
            data: rawDetection.mask,
            encoding: DetectionMaskEncoding.DenseBitmap,
            height: 3,
            width: 2,
          },
          rect: { height: 10, width: 10, x: 5, y: 5 },
        },
      ],
      mediaTime: 0,
    });

    expect(result.detections).toHaveLength(2);
    expect(result.skippedRleMaskCount).toBe(1);
    expect(result.detections[0]!.mask).toHaveLength(0);
    expect(result.detections[1]!.mask).toBe(rawDetection.mask);
  });
});
