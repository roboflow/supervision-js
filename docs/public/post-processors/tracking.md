---
title: Tracking
summary: Apply ordered SORT tracking to boxes, masks, or keypoints in a browser worker.
---

# Tracking

The tracking post processor assigns a numeric `trackerId` to each matched
`Detection`. It preserves `Detection.id`: `id` remains annotation and picking
identity, while `trackerId` is temporal identity produced by the selected
tracker. Like Python SORT, motion predictions remain internal tracker state and
are never emitted as synthetic detections.

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
confidence, and an association rectangle to its worker, and appends the
enriched semantic frame to browser cold storage. This comparison playground
sets `mutateInput: false` so it can retain a raw view. Switch among boxes,
masks, and keypoints to change both association input and the visible tracked
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
  output: detectionsSource,
  processors: [
    detectionPostProcessors.tracking({
      algorithm: "sort",
      frameRate: 30,
      geometry: TrackingGeometry.Mask,
      lostTrackBuffer: 30,
      minimumConsecutiveFrames: 3,
      minimumIouThreshold: 0.3,
      trackActivationThreshold: 0.25,
    }),
  ],
});

for await (const detectionFrame of inferenceStream) {
  // Arrival order may differ from frameIndex order.
  await pipeline.appendFrames([detectionFrame]);
}
```

`appendFrames()` mutates the derived `trackerId` field on the supplied
detections and returns the same frame references by default. Point `output` at
the application's only detection source when raw detections do not need to be
retained. Set `mutateInput: false` to produce cloned tracked frames when a host
uses immutable detections or explicitly needs both raw and tracked views, as
the playground does.

Await `appendFrames()` or otherwise apply upstream backpressure. If a missing
frame lets the pending set reach `maxPendingFrames`, the pipeline rejects the
new append instead of retaining an unbounded number of masks. Reset the
pipeline before replaying or revising frames behind its processed frontier.

## Geometry choices

- `Box` tracks detections that have `rect` geometry.
- `Mask` tracks detections that have masks. It reuses `rect` as the cheap mask
  extent when available and decodes RLE bounds only when necessary.
- `Keypoints` tracks detections that have keypoints using their point bounds.

The geometry choice affects association only. Observed boxes, masks, keypoints,
and metadata remain exact. When the detector misses a confirmed track, SORT
keeps its Kalman-predicted extent internally for later association. The output
frame remains observation-only: no box, mask, or keypoint is fabricated.

The defaults mirror the open-source Python
[`roboflow/trackers` SORT tracker](https://github.com/roboflow/trackers/blob/2.6.0/src/trackers/core/sort/tracker.py):
new tracks require `trackActivationThreshold`, receive a zero-based ID only
after `minimumConsecutiveFrames` successful observations, associate
class-agnostically at `minimumIouThreshold`, and survive gaps according to
`lostTrackBuffer` scaled by `frameRate`. Missing confidence is treated as `1`.

The browser implementation uses the Python tracker's default eight-dimensional
XYXY Kalman state. Its ordered `frameIndex` input is the fixed-rate integration
boundary; Python's optional wall-clock `timestamp` and injectable state/IoU
classes are not exposed in this first browser API. Both implementations return
only observed detections with derived tracker identity; unmatched live tracks
remain internal state.

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
