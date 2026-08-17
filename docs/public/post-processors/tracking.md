---
title: Tracking
summary: Apply ordered SORT tracking to boxes, masks, or keypoints in a browser worker.
---

# Tracking

The tracking post processor assigns a numeric `trackerId` while preserving the
original `Detection.id`. `id` remains the annotation and picking identity;
`trackerId` is temporal identity produced by the selected tracker.

<div class="supervision-layer-playground supervision-post-processor-playground">
  <iframe
    data-supervision-playground-src="demo/?embed=post-processor&amp;processor=tracking"
    loading="lazy"
    title="Interactive tracking post-processor playground"
  ></iframe>
</div>

The playground uses the frozen basketball fixture. Click **Apply tracking** to
stream each one-second chunk in deliberately shuffled frame order. The
pipeline waits for the next known `frameIndex`, sends only detection index,
class, confidence, and an association rectangle to its worker, and appends the
enriched semantic frame to browser cold storage. Switch among boxes, masks,
and keypoints to change both association input and the visible tracked
annotation.

## Consume out-of-order inference

```ts
import {
  DetectionPostProcessingMode,
  TrackingGeometry,
  createDetectionPostProcessingPipeline,
  detectionPostProcessors,
} from "supervision";

const pipeline = createDetectionPostProcessingPipeline({
  mode: DetectionPostProcessingMode.Worker,
  maxPendingFrames: 90,
  output: trackedSource,
  processors: [
    detectionPostProcessors.tracking({
      algorithm: "sort",
      geometry: TrackingGeometry.Mask,
      iouThreshold: 0.3,
      maxAge: 30,
      minHits: 3,
      matchByClass: true,
    }),
  ],
});

for await (const detectionFrame of inferenceStream) {
  // Arrival order may differ from frameIndex order.
  await pipeline.appendFrames([detectionFrame]);
}
```

Await `appendFrames()` or otherwise apply upstream backpressure. If a missing
frame lets the pending set reach `maxPendingFrames`, the pipeline rejects the
new append instead of retaining an unbounded number of masks. Reset the
pipeline before replaying or revising frames behind its processed frontier.

## Geometry choices

- `Box` tracks detections that have `rect` geometry.
- `Mask` tracks detections that have masks. It reuses `rect` as the cheap mask
  extent when available and decodes RLE bounds only when necessary.
- `Keypoints` tracks detections that have keypoints using their point bounds.

The geometry choice affects association only. The processed frame retains the
complete original detection payload.

## Worker behavior

`Worker` mode is strict. `Auto` falls back to the main thread only if worker
creation or initial configuration fails before any frame changes tracker
state. A runtime failure after processing begins rejects the pipeline because
silently recreating state without replaying causal history would produce
incorrect IDs. Call `reset()` and replay from the new causal frontier before
appending more frames.

For strict Content Security Policies, host the self-contained worker exported
at `supervision/detection-post-processing-worker` and supply a
`DetectionPostProcessingWorkerFactory`. The worker message protocol remains
private.
