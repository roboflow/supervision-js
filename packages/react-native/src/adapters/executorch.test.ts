import { describe, expect, it } from "vitest";

import { KeypointVisibility } from "supervision-js-core";

import {
  createDetectionFrameFromExecutorchCocoPoses,
  createExecutorchLivePoseProcessor,
  createExecutorchLiveSegmentationProcessor,
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

  it("normalizes live pose output into a core detection frame", () => {
    const processor = createExecutorchLivePoseProcessor({
      runOnFrame: () => [
        {
          LEFT_SHOULDER: { x: 10, y: 20 },
          RIGHT_SHOULDER: { x: 30, y: 20 },
          LEFT_HIP: { x: 12, y: 50 },
        },
      ],
    });

    expect(processor.process({ timestamp: 2_000_000_000 })).toMatchObject({
      frameIndex: 2_000_000_000,
      mediaTime: 2,
    });
  });
});
