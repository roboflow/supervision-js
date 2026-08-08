---
title: Boxes
summary: Draw and style axis-aligned detection bounds.
---

# Boxes

Boxes visualize a detection's center-based `rect` geometry. Use
`BaseBoxStyle` to control shape, corner radius, fill, stroke, visibility, and
per-detection styling without changing the detection data.

<div class="supervision-layer-playground">
  <iframe
    data-supervision-playground-src="demo/?embed=visualization-layer&amp;layer=boxes"
    loading="lazy"
    title="Interactive box visualization playground"
  ></iframe>
</div>

## Add a box layer

```ts
session.setPresentation({
  boxStyle: new BaseBoxStyle({
    fill: { alpha: 0.12 },
    stroke: { width: 3 },
  }),
});
```

Rectangle `x` and `y` are the center in media pixels. Shape and opacity belong
to the style; they should not be stored on the detection.

Use `null` to disable boxes while preserving every rectangle:

```ts
session.setPresentation({ boxStyle: null });
```

See [Presentation Styles](../guides/presentation-styles.md) for dynamic class
colors and confidence predicates, or the `BaseBoxStyle` API reference for all
options.
