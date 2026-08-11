---
title: Boxes
summary: Draw and style axis-aligned detection bounds.
---

# Boxes

The box annotation renderer visualizes a detection's center-based `rect`
geometry. Use `BaseBoxStyle` to control shape, corner radius, fill, stroke,
visibility, and per-detection styling without changing the detection data.

<div class="supervision-layer-playground">
  <iframe
    data-supervision-playground-src="demo/?embed=annotation-renderer&amp;renderer=boxes"
    loading="lazy"
    title="Interactive box visualization playground"
  ></iframe>
</div>

## Add the box renderer

```ts
session.setPresentation({
  renderers: [
    annotationRenderers.box({
      style: new BaseBoxStyle({
        fill: { alpha: 0.12 },
        stroke: { width: 3 },
      }),
    }),
  ],
});
```

Rectangle `x` and `y` are the center in media pixels. Shape and opacity belong
to the style; they should not be stored on the detection.

Omit `annotationRenderers.box()` from the authoritative renderer list to disable
boxes while preserving every rectangle in the detection data.

See [Presentation Styles](../guides/presentation-styles.md) for dynamic class
colors and confidence predicates, or the `BaseBoxStyle` API reference for all
options.
