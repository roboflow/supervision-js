---
title: Heatmaps
summary: Colour scalar model scores over media without turning them into a binary mask.
---

# Heatmaps

A heatmap is a scalar raster, not a colour image or a binary segmentation mask.
Attach one to a detection with media-space `bounds`, raster `width` and `height`,
row-major `values`, and the model's optional `threshold`. The renderer colours
it when that detection's frame is presented. It does not infer, track, or decide
which detections should exist.

<div class="supervision-layer-playground">
  <iframe
    data-supervision-playground-src="demo/?embed=heatmap"
    loading="lazy"
    title="Interactive anomaly heatmap visualization playground"
  ></iframe>
</div>

This playground uses Patrick's frozen FoundAD inference and temporally confirmed
bolt and stick detections. Unconfirmed hot spots are not sent to the renderer.
The fixture's heatmap values are 16-bit integer scores with
`valueScale: 1 / 65535`; a caller with a raw `anomaly_map[y][x]` can instead
flatten it directly as floats with the default scale of 1.

```ts
const heatmap = {
  bounds: {
    x: imageWidth / 2,
    y: imageHeight / 2,
    width: imageWidth,
    height: imageHeight,
  },
  width: imageWidth,
  height: imageHeight,
  values: anomaly_map.flat(),
  threshold: anomaly_threshold,
};

// Put this semantic heatmap on a Detection in a DetectionFrame.
session.setPresentation({
  renderers: [annotationRenderers.heatmap()],
});
```

`thresholdScale`, `minimumAlpha`, `opacity`, and `colorStops` are presentation
choices. The default cutoff is the score's own `threshold`; lower it only when
you want to show weaker evidence. In the pebbles demo, the cutoff is 75% of the
model threshold and only tracker-confirmed detections are displayed.
