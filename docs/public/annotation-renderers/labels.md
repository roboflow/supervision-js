---
title: Labels
summary: Resolve class, confidence, and custom text next to detections.
---

# Labels

The label annotation renderer derives display text from semantic detections.
`BaseLabelStyle` can use a class name, caller metadata, or a custom resolver and
can include confidence without storing presentation strings in model output.

<div class="supervision-layer-playground">
  <iframe
    data-supervision-playground-src="demo/?embed=annotation-renderer&amp;renderer=labels"
    loading="lazy"
    title="Interactive label visualization playground"
  ></iframe>
</div>

## Add the label renderer

```ts
session.setPresentation({
  renderers: [
    annotationRenderers.label({
      style: new BaseLabelStyle({
        background: { alpha: 0.9 },
        includeConfidence: true,
        textStyle: { fontSize: 14 },
      }),
    }),
  ],
});
```

Labels need a resolvable detection rectangle for placement, but the box layer
does not need to be visible. Use placement and offset options to move text
without changing the geometry.

Labels round all four corners unless an edge touches a displayed detection box.
The corners along that attachment stay square: a label above a box has square
bottom corners, and a label below it has square top corners. Offsets that detach
the label restore all four rounded corners. Set `background.topCornersOnly` to
`true` to always round only the top pair, or `false` to always round all four,
and choose the radius with `background.cornerRadius`.

See [Interactive Picking](../recipes/interactive-picking.md) for hover-only
labels and selection-aware presentation.
