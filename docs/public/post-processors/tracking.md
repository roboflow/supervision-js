---
title: Tracking
summary: Apply ordered SORT tracking to boxes, masks, or keypoints in a browser worker.
---

# Tracking

The tracking post processor assigns a numeric `trackerId` to each observed
`Detection` and, by default, emits synthetic detections while confirmed tracks
cross short observation gaps. It preserves the `id` of observed detections:
`id` remains annotation and picking identity, while `trackerId` is temporal
identity produced by the selected tracker.

Every tracked detection exposes explicit provenance. `trackerState` is
`observed` or `predicted`, and `trackerAge` is zero for observations or the
number of frames since the last observation for predictions. Synthetic
detections use a stable `tracking-prediction:<trackerId>` ID.

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
enriched semantic frame to browser cold storage. This comparison playground
sets `mutateInput: false` so it can retain a raw view. Switch among boxes,
masks, and keypoints to change both association input and the visible tracked
annotation. Dashed boxes show motion-model predictions across detector gaps.

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
      emitPredictions: true,
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

`appendFrames()` mutates the derived tracker fields on the supplied detections
and returns the same frame references by default. Point `output` at the
application's only detection source when raw detections do not need to be
retained. Gap predictions are appended to the supplied frame's mutable
`detections` array. Set `mutateInput: false` to produce cloned tracked frames
when a host uses immutable detections or explicitly needs both raw and tracked
views, as the playground does.

Await `appendFrames()` or otherwise apply upstream backpressure. If a missing
frame lets the pending set reach `maxPendingFrames`, the pipeline rejects the
new append instead of retaining an unbounded number of masks. Reset the
pipeline before replaying or revising frames behind its processed frontier.

## Geometry choices

- `Box` tracks detections that have `rect` geometry.
- `Mask` tracks detections that have masks. It reuses `rect` as the cheap mask
  extent when available and decodes RLE bounds only when necessary.
- `Keypoints` tracks detections that have keypoints using their point bounds.

The geometry choice affects association. Observed boxes, masks, keypoints, and
metadata remain exact. When the detector misses a confirmed track, the
post-processor emits its Kalman-predicted extent as a synthetic box. It does
not pretend to know an unobserved mask bitmap or keypoint pose. Set
`emitPredictions: false` when an application wants identity assignment without
gap filling.

The defaults mirror the open-source Python
[`roboflow/trackers` SORT tracker](https://github.com/roboflow/trackers/blob/2.6.0/src/trackers/core/sort/tracker.py):
new tracks require `trackActivationThreshold`, receive a zero-based ID only
after `minimumConsecutiveFrames` successful observations, associate
class-agnostically at `minimumIouThreshold`, and survive gaps according to
`lostTrackBuffer` scaled by `frameRate`. Missing confidence is treated as `1`.
Only confirmed tracks emit predictions. This avoids turning one-frame false
positives into persistent synthetic objects.

The browser implementation uses the Python tracker's default eight-dimensional
XYXY Kalman state. Its ordered `frameIndex` input is the fixed-rate integration
boundary; Python's optional wall-clock `timestamp` and injectable state/IoU
classes are not exposed in this first browser API. `emitPredictions` is a
browser extension that materializes the Python tracker's confirmed live-track
view into synthetic detections.

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
