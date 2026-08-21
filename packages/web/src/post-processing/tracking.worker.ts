import {
  createByteTrackTracker,
  createCBIoUTracker,
  createOCSortTracker,
  createSortTracker,
  type TrackingTracker,
} from "supervision-js-core";
import type {
  TrackingWorkerRequest,
  TrackingWorkerResponse,
} from "#post-processing/tracking-worker-protocol";

let tracker: TrackingTracker | undefined;

self.addEventListener(
  "message",
  (event: MessageEvent<TrackingWorkerRequest>) => {
    const request = event.data;

    try {
      let response: TrackingWorkerResponse;

      if (request.type === "configure") {
        switch (request.processor.algorithm) {
          case "bytetrack":
            tracker = createByteTrackTracker(request.processor.options);
            break;
          case "cbiou":
            tracker = createCBIoUTracker(request.processor.options);
            break;
          case "ocsort":
            tracker = createOCSortTracker(request.processor.options);
            break;
          default:
            tracker = createSortTracker(request.processor.options);
        }
        response = { requestId: request.requestId, type: "success" };
      } else if (request.type === "reset") {
        tracker?.reset();
        response = { requestId: request.requestId, type: "success" };
      } else {
        if (!tracker) {
          throw new Error("Tracking worker is not configured.");
        }
        const startedAt = performance.now();
        const update = tracker.update(request.detections, request.frameIndex);
        response = {
          ...update,
          durationMs: performance.now() - startedAt,
          requestId: request.requestId,
          type: "success",
        };
      }

      self.postMessage(response);
    } catch (error) {
      self.postMessage({
        message:
          error instanceof Error ? error.message : "Tracking worker failed.",
        requestId: request.requestId,
        type: "error",
      } satisfies TrackingWorkerResponse);
    }
  },
);
