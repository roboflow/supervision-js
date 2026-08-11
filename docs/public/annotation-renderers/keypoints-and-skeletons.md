---
title: Keypoints and Skeletons
summary: Style pose markers and the edges that connect them.
---

# Keypoints and Skeletons

The keypoint annotation renderer draws pose markers and skeleton edges from one
semantic geometry and one `BaseKeypointStyle`. Marker radius, marker fill, edge
stroke, and edge shadow can change independently without rewriting predictions.

<div class="supervision-layer-playground">
  <iframe
    data-supervision-playground-src="demo/?embed=annotation-renderer&amp;renderer=keypoints"
    loading="lazy"
    title="Interactive keypoint and skeleton visualization playground"
  ></iframe>
</div>

## Add the keypoint renderer

```ts
session.setPresentation({
  renderers: [
    annotationRenderers.keypoints({
      style: new BaseKeypointStyle({
        edgeStroke: { width: 2 },
        markerFill: { alpha: 1 },
        radius: 5,
      }),
    }),
  ],
});
```

COCO-compatible visibility distinguishes absent, occluded, and visible points.
Class-specific skeleton definitions may override individual vertex or edge
colors while retaining the same style contract.

The basketball fixture attaches pose keypoints to the matching segmentation
detections, so boxes, masks, labels, polygons, and pose stay aligned on one
media timeline.
