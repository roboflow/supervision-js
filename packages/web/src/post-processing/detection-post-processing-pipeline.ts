import {
  createByteTrackTracker,
  createCBIoUTracker,
  createOCSortTracker,
  createSortTracker,
  projectDetectionFrameForTracking,
  type DetectionFrame,
  type TrackingTracker,
  type TrackingAssignment,
  type TrackingDetectionPostProcessor,
  type TrackingProjection,
} from "supervision-js-core";
import { createDefaultDetectionPostProcessingWorkerFactory } from "#post-processing/default-tracking-worker";
import {
  isTrackingWorkerResponse,
  type TrackingWorkerRequest,
  type TrackingWorkerResponse,
} from "#post-processing/tracking-worker-protocol";
import {
  DetectionPostProcessingMode,
  type DetectionPostProcessingAppendResult,
  type DetectionPostProcessingDiagnostics,
  type DetectionPostProcessingPipeline,
  type DetectionPostProcessingPipelineOptions,
  type TrackingExecutionResult,
} from "#types/detection-post-processing";
import {
  createWorkerRpcClient,
  type WorkerRpcClient,
  type WorkerRpcRequestInput,
} from "#workers/worker-rpc-client";

const DEFAULT_MAX_PENDING_FRAMES = 90;

interface TrackingExecution {
  readonly mode: "worker" | "mainThread";
  destroy(): void;
  process(
    detections: readonly TrackingProjection[],
    frameIndex: number,
  ): Promise<TrackingExecutionResult>;
  reset(): Promise<void>;
}

/**
 * Creates an ordered, bounded stream processor for detections arriving out of
 * order. Stateful processors run serially; the renderer remains independent.
 */
export function createDetectionPostProcessingPipeline(
  options: DetectionPostProcessingPipelineOptions,
): DetectionPostProcessingPipeline {
  const processor = validateProcessors(options.processors);
  const maxPendingFrames = normalizePositiveInteger(
    options.maxPendingFrames ?? DEFAULT_MAX_PENDING_FRAMES,
    "maxPendingFrames",
  );
  let nextFrameIndex = normalizeFrameIndex(
    options.startFrameIndex ?? 0,
    "startFrameIndex",
  );
  let execution: TrackingExecution | undefined;
  let destroyed = false;
  let failedError: Error | undefined;
  let inFlightFrameIndex: number | undefined;
  let processing = Promise.resolve<DetectionPostProcessingAppendResult>({
    acceptedFrameCount: 0,
    processedFrameCount: 0,
    processedFrames: [],
  });
  const pendingFrames = new Map<number, DetectionFrame>();
  let diagnostics: DetectionPostProcessingDiagnostics = {
    activeTrackCount: 0,
    confirmedTrackCount: 0,
    errorMessage: null,
    executionMode: null,
    lastFrameDurationMs: null,
    nextFrameIndex,
    pendingFrameCount: 0,
    processedFrameCount: 0,
    trackedDetectionCount: 0,
  };

  publishDiagnostics();

  return {
    async appendFrames(frames) {
      assertActive();
      assertHealthy();
      const acceptedFrameCount = enqueueFrames(frames);
      processing = processing.then(() =>
        drainPendingFrames(acceptedFrameCount),
      );
      return processing;
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      pendingFrames.clear();
      execution?.destroy();
      execution = undefined;
    },

    getDiagnostics() {
      return { ...diagnostics };
    },

    async reset(resetOptions = {}) {
      assertActive();
      await processing.catch(() => undefined);
      pendingFrames.clear();
      inFlightFrameIndex = undefined;
      nextFrameIndex = normalizeFrameIndex(
        resetOptions.startFrameIndex ?? options.startFrameIndex ?? 0,
        "startFrameIndex",
      );
      await execution?.reset();
      failedError = undefined;
      processing = Promise.resolve({
        acceptedFrameCount: 0,
        processedFrameCount: 0,
        processedFrames: [],
      });
      diagnostics = {
        ...diagnostics,
        activeTrackCount: 0,
        confirmedTrackCount: 0,
        errorMessage: null,
        lastFrameDurationMs: null,
        nextFrameIndex,
        pendingFrameCount: 0,
        processedFrameCount: 0,
        trackedDetectionCount: 0,
      };
      publishDiagnostics();
    },
  };

  function enqueueFrames(frames: readonly DetectionFrame[]) {
    let acceptedFrameCount = 0;
    const additions = new Map<number, DetectionFrame>();

    for (const frame of frames) {
      const frameIndex = normalizeFrameIndex(frame.frameIndex, "frameIndex");
      if (frameIndex < nextFrameIndex) {
        throw new Error(
          `Frame ${frameIndex} is behind the processed frontier ${nextFrameIndex}. Reset before revising causal history.`,
        );
      }
      if (frameIndex === inFlightFrameIndex) {
        throw new Error(
          `Frame ${frameIndex} is already being processed. Reset before revising causal history.`,
        );
      }
      if (!pendingFrames.has(frameIndex) && !additions.has(frameIndex)) {
        acceptedFrameCount += 1;
      }
      additions.set(frameIndex, frame);
    }

    const nextPendingCount = pendingFrames.size + acceptedFrameCount;
    if (nextPendingCount > maxPendingFrames) {
      throw new Error(
        `Out-of-order buffer limit exceeded (${nextPendingCount}/${maxPendingFrames}). Apply upstream backpressure or increase maxPendingFrames.`,
      );
    }

    for (const [frameIndex, frame] of additions) {
      pendingFrames.set(frameIndex, frame);
    }
    diagnostics = {
      ...diagnostics,
      nextFrameIndex,
      pendingFrameCount: pendingFrames.size,
    };
    publishDiagnostics();
    return acceptedFrameCount;
  }

  async function drainPendingFrames(
    acceptedFrameCount: number,
  ): Promise<DetectionPostProcessingAppendResult> {
    const processedFrames: DetectionFrame[] = [];

    try {
      execution ??= await createTrackingExecution(processor, options);
      diagnostics = { ...diagnostics, executionMode: execution.mode };

      while (!destroyed) {
        const frame = pendingFrames.get(nextFrameIndex);
        if (!frame) break;
        pendingFrames.delete(nextFrameIndex);
        inFlightFrameIndex = nextFrameIndex;
        const projections = projectDetectionFrameForTracking(
          frame,
          processor.geometry,
        );
        const result = await execution.process(projections, nextFrameIndex);
        const processedFrame = attachTrackerIds(
          frame,
          result.assignments,
          options.mutateInput ?? true,
        );

        if (destroyed) break;
        await options.output?.appendFrames([processedFrame]);
        options.onFrame?.(processedFrame);
        processedFrames.push(processedFrame);
        nextFrameIndex += 1;
        inFlightFrameIndex = undefined;
        diagnostics = {
          ...diagnostics,
          activeTrackCount: result.activeTrackCount,
          confirmedTrackCount: result.confirmedTrackCount,
          errorMessage: null,
          lastFrameDurationMs: result.durationMs,
          nextFrameIndex,
          pendingFrameCount: pendingFrames.size,
          processedFrameCount: diagnostics.processedFrameCount + 1,
          trackedDetectionCount:
            diagnostics.trackedDetectionCount + result.assignments.length,
        };
        publishDiagnostics();
      }

      return {
        acceptedFrameCount,
        processedFrameCount: processedFrames.length,
        processedFrames,
      };
    } catch (error) {
      failedError =
        error instanceof Error ? error : new Error("Post-processing failed.");
      diagnostics = {
        ...diagnostics,
        errorMessage: failedError.message,
        pendingFrameCount: pendingFrames.size,
      };
      publishDiagnostics();
      throw failedError;
    }
  }

  function publishDiagnostics() {
    options.onDiagnostics?.({ ...diagnostics });
  }

  function assertActive() {
    if (destroyed) {
      throw new Error("Detection post-processing pipeline has been destroyed.");
    }
  }

  function assertHealthy() {
    if (failedError) {
      throw new Error(
        `Detection post-processing pipeline failed and must be reset: ${failedError.message}`,
      );
    }
  }
}

async function createTrackingExecution(
  processor: TrackingDetectionPostProcessor,
  options: DetectionPostProcessingPipelineOptions,
): Promise<TrackingExecution> {
  const mode = options.mode ?? DetectionPostProcessingMode.Auto;
  if (mode === DetectionPostProcessingMode.MainThread) {
    return createMainThreadExecution(processor);
  }

  let workerExecution: TrackingExecution | undefined;
  try {
    const workerFactory =
      options.workerFactory ??
      createDefaultDetectionPostProcessingWorkerFactory();
    workerExecution = createWorkerExecution(
      workerFactory.createWorker(),
      processor,
    );
    await workerExecution.reset();
    return workerExecution;
  } catch (error) {
    workerExecution?.destroy();
    if (mode === DetectionPostProcessingMode.Worker) throw error;
    return createMainThreadExecution(processor);
  }
}

function createMainThreadExecution(
  processor: TrackingDetectionPostProcessor,
): TrackingExecution {
  let tracker: TrackingTracker;
  switch (processor.algorithm) {
    case "bytetrack":
      tracker = createByteTrackTracker(processor.options);
      break;
    case "cbiou":
      tracker = createCBIoUTracker(processor.options);
      break;
    case "ocsort":
      tracker = createOCSortTracker(processor.options);
      break;
    default:
      tracker = createSortTracker(processor.options);
  }
  return {
    destroy() {},
    mode: "mainThread",
    async process(detections, frameIndex) {
      const startedAt = performance.now();
      const update = tracker.update(detections, frameIndex);
      return { ...update, durationMs: performance.now() - startedAt };
    },
    async reset() {
      tracker.reset();
    },
  };
}

function createWorkerExecution(
  worker: Worker,
  processor: TrackingDetectionPostProcessor,
): TrackingExecution {
  const client: WorkerRpcClient<TrackingWorkerRequest, TrackingWorkerResponse> =
    createWorkerRpcClient({
      defaultErrorMessage: "Detection post-processing worker failed.",
      isResponse: isTrackingWorkerResponse,
      worker,
    });
  let configured = false;

  const request = async (
    message: WorkerRpcRequestInput<TrackingWorkerRequest>,
  ) => {
    const response = await client.request(message);
    if (response.type === "error") throw new Error(response.message);
    return response;
  };

  return {
    destroy() {
      client.destroy();
    },
    mode: "worker",
    async process(detections, frameIndex) {
      if (!configured) {
        await request({ processor, type: "configure" });
        configured = true;
      }
      const response = await request({
        detections,
        frameIndex,
        type: "process",
      });
      return {
        activeTrackCount: response.activeTrackCount ?? 0,
        assignments: response.assignments ?? [],
        confirmedTrackCount: response.confirmedTrackCount ?? 0,
        durationMs: response.durationMs ?? 0,
      };
    },
    async reset() {
      if (!configured) {
        await request({ processor, type: "configure" });
        configured = true;
      } else {
        await request({ type: "reset" });
      }
    },
  };
}

function attachTrackerIds(
  frame: DetectionFrame,
  assignments: readonly TrackingAssignment[],
  mutateInput: boolean,
): DetectionFrame {
  const trackerIds = new Map(
    assignments.map(({ detectionIndex, trackerId }) => [
      detectionIndex,
      trackerId,
    ]),
  );

  for (const [detectionIndex, detection] of frame.detections.entries()) {
    if (mutateInput) {
      const trackerId = trackerIds.get(detectionIndex);
      if (trackerId === undefined) {
        Reflect.deleteProperty(detection, "trackerId");
      } else {
        detection.trackerId = trackerId;
      }
    }
  }

  if (mutateInput) {
    return frame;
  }

  return {
    ...frame,
    detections: frame.detections.map((detection, detectionIndex) => {
      const semanticDetection = { ...detection };
      Reflect.deleteProperty(semanticDetection, "trackerId");
      const trackerId = trackerIds.get(detectionIndex);
      return trackerId === undefined
        ? semanticDetection
        : { ...semanticDetection, trackerId };
    }),
  };
}

function validateProcessors(
  processors: readonly DetectionPostProcessingPipelineOptions["processors"][number][],
): TrackingDetectionPostProcessor {
  if (processors.length !== 1 || processors[0]?.kind !== "tracking") {
    throw new Error(
      "The first post-processing release requires exactly one tracking processor.",
    );
  }
  return processors[0];
}

function normalizePositiveInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function normalizeFrameIndex(value: number | undefined, label: string) {
  if (!Number.isInteger(value) || value === undefined || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}
