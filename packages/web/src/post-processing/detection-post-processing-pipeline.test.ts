import { describe, expect, it } from "vitest";
import {
  TrackingGeometry,
  createMemoryColdDetectionFrameStore,
  createWritableDetectionFrameSource,
  detectionPostProcessors,
  type DetectionFrame,
  type WritableDetectionFrameSource,
} from "supervision-js-core";
import { createDetectionPostProcessingPipeline } from "./detection-post-processing-pipeline";
import { DetectionPostProcessingMode } from "../types/detection-post-processing";

const frame = (frameIndex: number, x = frameIndex * 2): DetectionFrame => ({
  detections: [
    {
      className: "person",
      id: `annotation:${frameIndex}`,
      mask: {
        counts: "11",
        encoding: "compressedRle" as never,
        height: 2,
        width: 2,
      },
      rect: { height: 20, width: 10, x, y: 10 },
    },
  ],
  frameIndex,
  mediaTime: frameIndex / 30,
});

describe("createDetectionPostProcessingPipeline", () => {
  it("reorders arrivals and preserves annotation identity and masks", async () => {
    const output = createWritableDetectionFrameSource({
      datasetId: "tracked",
      store: createMemoryColdDetectionFrameStore(),
    });
    const pipeline = createDetectionPostProcessingPipeline({
      mode: DetectionPostProcessingMode.MainThread,
      output,
      processors: [
        detectionPostProcessors.tracking({ geometry: TrackingGeometry.Mask }),
      ],
    });

    expect(
      (await pipeline.appendFrames([frame(2), frame(1)])).processedFrameCount,
    ).toBe(0);
    expect((await pipeline.appendFrames([frame(0)])).processedFrameCount).toBe(
      3,
    );

    const loaded = await output.loadFrames(0, 1);
    expect(loaded.map((candidate) => candidate.frameIndex)).toEqual([0, 1, 2]);
    expect(loaded[0]!.detections[0]!.mask).toBeDefined();
    expect(loaded[2]!.detections[0]).toMatchObject({
      id: "annotation:2",
      trackerId: 0,
    });
    pipeline.destroy();
  });

  it("mutates derived tracking identity on input detections by default", async () => {
    const inputFrames = [frame(0), frame(1), frame(2)];
    const inputDetection = inputFrames[2]!.detections[0]!;
    const pipeline = createDetectionPostProcessingPipeline({
      mode: DetectionPostProcessingMode.MainThread,
      processors: [detectionPostProcessors.tracking()],
    });

    const result = await pipeline.appendFrames(inputFrames);

    expect(result.processedFrames[2]).toBe(inputFrames[2]);
    expect(result.processedFrames[2]!.detections[0]).toBe(inputDetection);
    expect(inputDetection.trackerId).toBe(0);
    pipeline.destroy();
  });

  it("can preserve raw detections for comparison workflows", async () => {
    const inputFrames = [frame(0), frame(1), frame(2)];
    const inputDetection = inputFrames[2]!.detections[0]!;
    const pipeline = createDetectionPostProcessingPipeline({
      mode: DetectionPostProcessingMode.MainThread,
      mutateInput: false,
      processors: [detectionPostProcessors.tracking()],
    });

    const result = await pipeline.appendFrames(inputFrames);

    expect(result.processedFrames[2]).not.toBe(inputFrames[2]);
    expect(result.processedFrames[2]!.detections[0]).not.toBe(inputDetection);
    expect(result.processedFrames[2]!.detections[0]!.trackerId).toBe(0);
    expect(inputDetection.trackerId).toBeUndefined();
    pipeline.destroy();
  });

  it("keeps gap predictions internal and reassociates the observed detection", async () => {
    const output = createWritableDetectionFrameSource({
      datasetId: "observation-only",
      store: createMemoryColdDetectionFrameStore(),
    });
    const gapFrame: DetectionFrame = {
      detections: [],
      frameIndex: 2,
      mediaTime: 2 / 30,
    };
    const pipeline = createDetectionPostProcessingPipeline({
      mode: DetectionPostProcessingMode.MainThread,
      output,
      processors: [
        detectionPostProcessors.tracking({
          geometry: TrackingGeometry.Mask,
          minimumConsecutiveFrames: 2,
        }),
      ],
    });

    await pipeline.appendFrames([frame(0), frame(1)]);
    const gapResult = await pipeline.appendFrames([gapFrame]);

    expect(gapResult.processedFrames[0]).toBe(gapFrame);
    expect(gapFrame.detections).toEqual([]);
    const storedGap = (await output.loadFrames(0, 1)).find(
      (candidate) => candidate.frameIndex === 2,
    );
    expect(storedGap?.detections).toEqual([]);
    const resumed = await pipeline.appendFrames([frame(3, 6)]);
    expect(resumed.processedFrames[0]!.detections[0]!.trackerId).toBe(0);
    pipeline.destroy();
  });

  it("bounds pending out-of-order frames", async () => {
    const pipeline = createDetectionPostProcessingPipeline({
      maxPendingFrames: 2,
      mode: DetectionPostProcessingMode.MainThread,
      processors: [detectionPostProcessors.tracking()],
    });

    await pipeline.appendFrames([frame(2), frame(3)]);
    await expect(pipeline.appendFrames([frame(4)])).rejects.toThrow(
      "Out-of-order buffer limit exceeded",
    );
    pipeline.destroy();
  });

  it("rejects revisions behind the causal frontier", async () => {
    const pipeline = createDetectionPostProcessingPipeline({
      mode: DetectionPostProcessingMode.MainThread,
      processors: [detectionPostProcessors.tracking()],
    });
    await pipeline.appendFrames([frame(0)]);

    await expect(pipeline.appendFrames([frame(0)])).rejects.toThrow(
      "behind the processed frontier",
    );
    pipeline.destroy();
  });

  it("rejects a revision while its frame is being committed", async () => {
    const baseOutput = createWritableDetectionFrameSource({
      datasetId: "tracked-in-flight",
      store: createMemoryColdDetectionFrameStore(),
    });
    let signalAppendStarted!: () => void;
    let releaseAppend!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      signalAppendStarted = resolve;
    });
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const output: WritableDetectionFrameSource = {
      ...baseOutput,
      async appendFrames(frames) {
        signalAppendStarted();
        await appendGate;
        return baseOutput.appendFrames(frames);
      },
    };
    const pipeline = createDetectionPostProcessingPipeline({
      mode: DetectionPostProcessingMode.MainThread,
      output,
      processors: [detectionPostProcessors.tracking()],
    });
    const firstAppend = pipeline.appendFrames([frame(0)]);
    await appendStarted;

    await expect(pipeline.appendFrames([frame(0)])).rejects.toThrow(
      "already being processed",
    );
    releaseAppend();
    await firstAppend;
    pipeline.destroy();
  });

  it("requires reset after a stateful processing failure", async () => {
    const baseOutput = createWritableDetectionFrameSource({
      datasetId: "tracked-failure",
      store: createMemoryColdDetectionFrameStore(),
    });
    const output: WritableDetectionFrameSource = {
      ...baseOutput,
      async appendFrames() {
        throw new Error("storage failed");
      },
    };
    const pipeline = createDetectionPostProcessingPipeline({
      mode: DetectionPostProcessingMode.MainThread,
      output,
      processors: [detectionPostProcessors.tracking()],
    });

    await expect(pipeline.appendFrames([frame(0)])).rejects.toThrow(
      "storage failed",
    );
    await expect(pipeline.appendFrames([frame(1)])).rejects.toThrow(
      "failed and must be reset",
    );
    await pipeline.reset({ startFrameIndex: 1 });
    await expect(pipeline.appendFrames([frame(1)])).rejects.toThrow(
      "storage failed",
    );
    pipeline.destroy();
  });
});
