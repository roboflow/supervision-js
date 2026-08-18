import { EMBEDDED_TRACKING_WORKER_SOURCE } from "#post-processing/embedded-tracking-worker";
import type { DetectionPostProcessingWorkerFactory } from "#types/detection-post-processing";

const DEFAULT_WORKER_NAME = "supervision-detection-post-processing";
let defaultWorkerUrl: string | undefined;

export function createDefaultDetectionPostProcessingWorkerFactory(): DetectionPostProcessingWorkerFactory {
  return {
    createWorker() {
      defaultWorkerUrl ??= URL.createObjectURL(
        new Blob([EMBEDDED_TRACKING_WORKER_SOURCE], {
          type: "text/javascript",
        }),
      );

      return new Worker(defaultWorkerUrl, { name: DEFAULT_WORKER_NAME });
    },
  };
}
