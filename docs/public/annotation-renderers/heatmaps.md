---
title: Heatmaps
summary: Colour scalar model scores over media without turning them into a binary mask.
---

# Heatmaps

A heatmap is a scalar raster, not a colour image or a binary segmentation mask.
Attach one to a detection with media-space `bounds`, raster `width` and `height`,
row-major `values`, and the model's optional `threshold`. The renderer colours
small maps when their frame is presented and prepares larger maps ahead of
playback when a worker is available. A large map may appear after its frame if
preparation has not finished yet. It does not infer, track, or decide which
detections should exist.

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
  width: anomaly_map[0].length,
  height: anomaly_map.length,
  values: anomaly_map.flat(),
  threshold: anomaly_threshold,
};

// Put this semantic heatmap on a Detection in a DetectionFrame.
session.setPresentation({
  renderers: [annotationRenderers.heatmap()],
});
```

`thresholdScale`, `minimumAlpha`, `opacity`, `maximumScore`, and `colorStops` are
presentation choices. The default cutoff is the score's own `threshold` and
colours use the same fixed 0-to-1 score scale across frames, while the cutoff
controls transparency. Set `maximumScore` if the model uses a different range;
lower the cutoff only when you want to show weaker evidence. In the pebbles
demo, the cutoff is 75% of the model threshold and only tracker-confirmed
detections are displayed. A lower-resolution `anomaly_map` can cover full-image
`bounds` without making a full-resolution texture.

When focus is enabled, the undimmed region follows the visible heatmap samples
rather than the detection's rectangular bounds. Changing the cutoff or opacity
updates both the heatmap and its focus cutout.

Each map is limited to 16,777,216 raster pixels, and the visible maps across
all heatmap renderers share that same per-frame pixel budget. Maps beyond the
budget are skipped with a console warning. The prepared raster cache is bounded
and does not retain heatmaps for the whole video. For large maps, leave worker
render preparation enabled; a main-thread-only setup may pause while it
prepares a raster.
