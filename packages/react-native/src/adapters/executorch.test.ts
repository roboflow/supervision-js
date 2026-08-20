import { describe, expect, it, vi } from "vitest";

import {
  decodeDetectionMask,
  DetectionMaskEncoding,
  KeypointVisibility,
} from "supervision-js-core";

import {
  createDetectionFrameFromExecutorchCocoPoses,
  createExecutorchLivePoseProcessor,
  createExecutorchLiveSegmentationProcessor,
  createExecutorchLiveSegmentationProducer,
  createExecutorchVideoFrameSerializer,
  EXECUTORCH_COCO_KEYPOINT_NAMES,
  unrotateExecutorchUpBbox,
  type ExecutorchBbox,
  type ExecutorchCocoPose,
} from "./executorch";

/**
 * ExecuTorch's forward mapping for `orientation: "up"` outputs, transcribed
 * from `inverseRotateBbox` in
 * react-native-executorch/common/rnexecutorch/utils/FrameTransform.cpp:
 *   nx1 = h - y2, ny1 = x1, nx2 = h - y1, ny2 = x2
 */
function executorchUpForwardMapping(
  bbox: ExecutorchBbox,
  frameHeight: number,
): ExecutorchBbox {
  return {
    x1: frameHeight - bbox.y2,
    y1: bbox.x1,
    x2: frameHeight - bbox.y1,
    y2: bbox.x2,
  };
}

describe("unrotateExecutorchUpBbox", () => {
  it("inverts the forward mapping exactly for a landscape frame", () => {
    // 1920x1080 landscape video, a person mid-court.
    const original: ExecutorchBbox = { x1: 420, y1: 200, x2: 660, y2: 780 };
    const mapped = executorchUpForwardMapping(original, 1080);

    expect(unrotateExecutorchUpBbox(mapped, 1080)).toEqual(original);
  });

  it("inverts the forward mapping exactly for a portrait frame", () => {
    // 1080x1920 portrait phone recording: the decoder bakes the file's
    // preferredTransform, so the upright frame is portrait-shaped and the
    // same inversion applies with its own height.
    const original: ExecutorchBbox = { x1: 100, y1: 900, x2: 500, y2: 1800 };
    const mapped = executorchUpForwardMapping(original, 1920);

    expect(unrotateExecutorchUpBbox(mapped, 1920)).toEqual(original);
  });

  it("keeps corners ordered after inversion", () => {
    const frameHeight = 1080;
    const originals: readonly ExecutorchBbox[] = [
      { x1: 0, y1: 0, x2: 1920, y2: 1080 },
      { x1: 0, y1: 0, x2: 1, y2: 1 },
      { x1: 1900, y1: 1060, x2: 1920, y2: 1080 },
    ];

    for (const original of originals) {
      const roundTripped = unrotateExecutorchUpBbox(
        executorchUpForwardMapping(original, frameHeight),
        frameHeight,
      );

      expect(roundTripped).toEqual(original);
      expect(roundTripped.x1).toBeLessThanOrEqual(roundTripped.x2);
      expect(roundTripped.y1).toBeLessThanOrEqual(roundTripped.y2);
    }
  });
});

describe("createDetectionFrameFromExecutorchCocoPoses", () => {
  it("maps valid COCO points, filters missing edges, and derives a bbox", () => {
    const pose = Object.fromEntries(
      EXECUTORCH_COCO_KEYPOINT_NAMES.map((name, index) => [
        name,
        { x: 100 + index * 2, y: 200 + index * 3 },
      ]),
    ) as ExecutorchCocoPose;

    const frame = createDetectionFrameFromExecutorchCocoPoses({
      frameIndex: 7,
      mediaTime: 0.25,
      poses: [
        {
          ...pose,
          LEFT_WRIST: { x: -1, y: -1 },
        },
      ],
    });

    expect(frame.frameIndex).toBe(7);
    expect(frame.mediaTime).toBe(0.25);
    expect(frame.detections).toHaveLength(1);
    expect(frame.detections[0]).toMatchObject({
      className: "person",
      id: "pose:7:0",
      rect: { height: 48, width: 32, x: 116, y: 224 },
    });
    expect(frame.detections[0]!.keypoints?.points).toHaveLength(17);
    expect(frame.detections[0]!.keypoints?.visibility?.[9]).toBe(
      KeypointVisibility.NotLabeled,
    );
    expect(
      frame.detections[0]!.keypoints?.edges.some(
        ([from, to]) => from === 7 && to === 9,
      ),
    ).toBe(false);
  });

  it("drops poses without enough visible points", () => {
    const frame = createDetectionFrameFromExecutorchCocoPoses({
      poses: [
        {
          LEFT_SHOULDER: { x: 10, y: 20 },
          RIGHT_SHOULDER: { x: 20, y: 20 },
        },
      ],
    });

    expect(frame.detections).toEqual([]);
  });
});

describe("createExecutorchVideoFrameSerializer", () => {
  it("keeps decoded video handles alive while restoring upright detections", () => {
    const runOnFrame = (
      frame: { getNativeBuffer(): { pointer: bigint; release(): void } },
      mirrorFrame: boolean,
      options: {
        confidenceThreshold: number;
        maxInstances: number;
        returnMaskAtOriginalResolution: boolean;
      },
    ) => {
      expect(frame.getNativeBuffer().pointer).toBe(42n);
      expect(mirrorFrame).toBe(false);
      expect(options).toEqual({
        confidenceThreshold: 0.45,
        maxInstances: 4,
        returnMaskAtOriginalResolution: false,
      });

      return [
        {
          bbox: { x1: 100, y1: 20, x2: 300, y2: 80 },
          label: "person",
          mask: new Uint8Array([1]),
          maskHeight: 1,
          maskWidth: 1,
          score: 0.9,
        },
      ];
    };
    const serialize = createExecutorchVideoFrameSerializer({
      maxInstances: 4,
      runOnFrame,
    });

    expect(
      serialize(
        {
          height: 200,
          pointer: 42n,
          release: () => {},
          timestampMs: 0,
          width: 100,
        },
        false,
      ),
    ).toMatchObject([
      {
        bbox: { x1: 20, x2: 80, y1: -100, y2: 100 },
        label: "person",
        maskRotatedCw: true,
        score: 0.9,
      },
    ]);
  });

  it("returns no detections while the host model is unavailable", () => {
    const serialize = createExecutorchVideoFrameSerializer({
      runOnFrame: null,
    });

    expect(
      serialize(
        {
          height: 100,
          pointer: 0n,
          release: () => {},
          timestampMs: 0,
          width: 100,
        },
        true,
      ),
    ).toEqual([]);
  });
});

describe("live ExecuTorch processors", () => {
  it("serializes live segmentation through a package-owned processor", () => {
    const processor = createExecutorchLiveSegmentationProcessor({
      confidenceThreshold: 0.7,
      maxInstances: 2,
      runOnFrame: (
        _frame: unknown,
        mirror: boolean,
        options: {
          confidenceThreshold: number;
          maxInstances: number;
          returnMaskAtOriginalResolution: boolean;
        },
      ) => {
        expect(mirror).toBe(false);
        expect(options).toEqual({
          confidenceThreshold: 0.7,
          maxInstances: 2,
          returnMaskAtOriginalResolution: true,
        });
        return [
          {
            bbox: { x1: 1, y1: 2, x2: 3, y2: 4 },
            label: "person",
            mask: new Uint8Array([1]),
            maskHeight: 1,
            maskWidth: 1,
            score: 0.8,
          },
        ];
      },
    });

    expect(processor.process({})).toMatchObject([
      {
        bbox: { x1: 1, y1: 2, x2: 3, y2: 4 },
        label: "person",
        score: 0.8,
      },
    ]);
  });

  it("restores physically upright camera predictions after ExecuTorch's up mapping", () => {
    const original = { x1: 10, y1: 30, x2: 40, y2: 80 };
    const getNativeBuffer = vi.fn(() => ({ pointer: 42n, release: vi.fn() }));
    const processor = createExecutorchLiveSegmentationProcessor({
      framePixelsAreUpright: true,
      runOnFrame: (frame: {
        getNativeBuffer(): { pointer: bigint; release(): void };
        isMirrored: boolean;
        orientation: string;
      }) => {
        expect(frame.orientation).toBe("up");
        expect(frame.isMirrored).toBe(false);
        expect(frame.getNativeBuffer().pointer).toBe(42n);
        return [
          {
            bbox: executorchUpForwardMapping(original, 100),
            label: "person",
            mask: new Uint8Array([1, 2, 3, 4, 5, 6]),
            maskHeight: 2,
            maskWidth: 3,
          },
        ];
      },
    });

    expect(
      processor.process({
        getNativeBuffer,
        height: 100,
        orientation: "left",
        width: 50,
      }),
    ).toMatchObject([
      {
        bbox: original,
        maskRotatedCw: true,
      },
    ]);
  });

  it("normalizes live pose output into a core detection frame", () => {
    const runOnFrame = vi.fn(() => [
      {
        LEFT_SHOULDER: { x: 10, y: 20 },
        RIGHT_SHOULDER: { x: 30, y: 20 },
        LEFT_HIP: { x: 12, y: 50 },
      },
    ]);
    const processor = createExecutorchLivePoseProcessor({
      mirrorFrame: true,
      runOnFrame,
    });

    expect(processor.process({ timestamp: 2_000_000_000 })).toMatchObject({
      frameIndex: 2_000_000_000,
      mediaTime: 2,
    });
    expect(runOnFrame).toHaveBeenCalledWith(
      { timestamp: 2_000_000_000 },
      true,
      expect.objectContaining({
        detectionThreshold: 0.4,
        inputSize: 384,
        keypointThreshold: 0.35,
      }),
    );
  });

  it("keeps the camera lane inert while a pose runner is unavailable", () => {
    const processor = createExecutorchLivePoseProcessor({
      runOnFrame: undefined as unknown as null,
    });

    expect(processor.process({ timestamp: 2_000_000_000 })).toMatchObject({
      detections: [],
      frameIndex: 2_000_000_000,
      mediaTime: 2,
    });
  });

  it("restores pose points after ExecuTorch's upright-frame output mapping", () => {
    const processor = createExecutorchLivePoseProcessor({
      framePixelsAreUpright: true,
      runOnFrame: (
        frame: { readonly orientation: string },
        mirrorFrame: boolean,
      ) => {
        expect(frame.orientation).toBe("up");
        expect(mirrorFrame).toBe(false);
        return [
          {
            LEFT_SHOULDER: { x: 80, y: 10 },
            LEFT_HIP: { x: 50, y: 12 },
            RIGHT_SHOULDER: { x: 80, y: 30 },
          },
        ];
      },
    });

    const frame = processor.process({
      getNativeBuffer: () => ({ pointer: 42n, release: () => {} }),
      height: 100,
      orientation: "left",
      timestamp: 2_000_000_000,
      width: 50,
    });

    const points = frame.detections[0]!.keypoints?.points;

    expect(points?.[5]).toEqual({ x: 10, y: 20 });
    expect(points?.[6]).toEqual({ x: 30, y: 20 });
    expect(points?.[11]).toEqual({ x: 12, y: 50 });
  });
});

describe("createExecutorchLiveSegmentationProducer", () => {
  const rawDetection = {
    bbox: { x1: 10, y1: 20, x2: 50, y2: 100 },
    label: "person",
    mask: new Uint8Array([1, 0, 0, 1, 0, 0]),
    maskHeight: 3,
    maskWidth: 2,
    score: 0.9,
  };

  it("publishes a DetectionFrame with core geometry and no styling", () => {
    const produce = createExecutorchLiveSegmentationProducer({
      runOnFrame: () => [rawDetection],
    });

    const frame = produce.process({ height: 0, timestamp: 2_000_000_000 });

    expect(frame.mediaTime).toBe(2);
    expect(frame.detections).toHaveLength(1);

    const detection = frame.detections[0]!;

    expect(detection.className).toBe("person");
    expect(detection.confidence).toBe(0.9);
    // Center-based Rect, converted from ExecuTorch's corner bbox.
    expect(detection.rect).toEqual({ height: 80, width: 40, x: 30, y: 60 });
    // Core detections carry no color; presentation resolves it from className.
    expect(detection).not.toHaveProperty("color");
  });

  it("publishes the mask buffer in place, with swapped logical dims when rotated", () => {
    const produce = createExecutorchLiveSegmentationProducer({
      framePixelsAreUpright: true,
      runOnFrame: () => [rawDetection],
    });

    const frame = produce.process({ height: 200, timestamp: 0 });
    const mask = frame.detections[0]!.mask;

    expect(mask).toMatchObject({
      encoding: DetectionMaskEncoding.DenseBitmap,
      // ExecuTorch reports the rotated buffer's dims; logical dims swap.
      height: 2,
      rotatedCw: true,
      width: 3,
    });
    // No upright copy: the model's buffer is published as-is.
    expect((mask as { data: Uint8Array }).data).toBe(rawDetection.mask);
  });

  it("decodes a produced rotated mask to the same bytes the fill loop samples", () => {
    const produce = createExecutorchLiveSegmentationProducer({
      framePixelsAreUpright: true,
      runOnFrame: () => [rawDetection],
    });

    const mask = produce.process({ height: 200, timestamp: 0 }).detections[0]!
      .mask!;
    const decoded = decodeDetectionMask(mask);

    // Transcribed from the ID-mask fill loops in src/index.ts:
    //   logical(x, y) = stored[x * storedRowWidth + (storedRowWidth - 1 - y)]
    const storedRowWidth = rawDetection.maskWidth;
    const expected = new Uint8Array(decoded.width * decoded.height);

    for (let y = 0; y < decoded.height; y += 1) {
      for (let x = 0; x < decoded.width; x += 1) {
        expected[y * decoded.width + x] =
          rawDetection.mask[x * storedRowWidth + (storedRowWidth - 1 - y)] ?? 0;
      }
    }

    expect(decoded.data).toEqual(expected);
  });

  it("leaves bboxes alone when the frame is not reported upright", () => {
    const produce = createExecutorchLiveSegmentationProducer({
      runOnFrame: () => [rawDetection],
    });

    const detection = produce.process({ timestamp: 0 }).detections[0]!;

    expect(detection.rect).toEqual({ height: 80, width: 40, x: 30, y: 60 });
    expect(detection.mask).toMatchObject({ rotatedCw: false, width: 2 });
  });

  it("returns an empty frame when no runner is configured", () => {
    const produce = createExecutorchLiveSegmentationProducer({
      runOnFrame: null,
    });

    expect(produce.process({ timestamp: 1_000_000_000 })).toEqual({
      detections: [],
      mediaTime: 1,
    });
  });
});
