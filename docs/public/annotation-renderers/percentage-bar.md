---
title: Percentage Bar
summary: Visualize confidence scores or custom metrics as proportional progress bars anchored to detections.
---

# Percentage Bar

The percentage-bar annotation renderer draws proportional progress indicators
anchored to a detection's rectangle bounds. It is ideal for visualizing model
confidence scores, tracking probabilities, or custom progression values
directly on detections.

<div class="supervision-layer-playground">
  <iframe
    data-supervision-playground-src="demo/?embed=annotation-renderer&amp;renderer=percentage-bar"
    loading="lazy"
    title="Interactive percentage bar visualization playground"
  ></iframe>
</div>

The playground uses the frozen basketball fixture's existing detection bounds
and confidence scores. Percentage bars are presentation only: they do not change
the source detection, picking, or editing behavior.

## Add the percentage-bar renderer

```ts
session.setPresentation({
  renderers: [
    annotationRenderers.percentageBar({
      style: new BasePercentageBarStyle({
        height: 8,
        placement: PercentageBarPlacement.Top,
      }),
    }),
  ],
});
```

`BasePercentageBarStyle` normalizes detection confidence scores into proportional
progress indicators. Configure `height`, `placement` (such as `Top`, `Bottom`,
`InsideTop`, or `InsideBottom`), `background`, and `fill` colors to customize
the display for your use case.
