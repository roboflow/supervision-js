---
title: Post Processors
children:
  - ./post-processors/tracking.md
---

# Post Processors

Post processors transform semantic `DetectionFrame` data before it enters the
normal hot render window. They do not draw annotations and they do not depend
on which frames the viewer happens to play.

The browser pipeline accepts frames from streaming inference in any arrival
order, holds a bounded set while a frame-index gap is open, and applies
stateful processors serially from the causal frontier. It updates derived
detection fields in place by default, so a cold `WritableDetectionFrameSource`
can contain only the post-processed truth consumed by the media session.

The first built-in post processor is [Tracking](./post-processors/tracking.md).
It runs SORT in a dedicated browser worker and associates boxes, masks, or
keypoints through lightweight rectangle projections. The original masks,
polygons, keypoints, annotation IDs, and metadata never cross that worker
boundary. Motion predictions remain internal to SORT and are used only to
associate later observed detections.

## Pipeline shape

```text
SSE inference -> ordered post processor -> tracked cold source -> hot render window
```

Hosts that need comparison or audit views may opt out of mutation and keep
separate raw and processed sources.

Stateful processors such as tracking are intentionally serial for one media
sequence. Different videos or cameras may use independent pipelines. A future
stateless processor may use parallel execution without changing this causal
contract.
