---
title: Labels
summary: Resolve class, confidence, and custom text next to detections.
---

# Labels

Labels derive display text from semantic detections. `BaseLabelStyle` can use a
class name, caller metadata, or a custom resolver and can include confidence
without storing presentation strings in model output.

<div class="supervision-layer-playground">
  <iframe
    data-supervision-playground-src="demo/?embed=visualization-layer&amp;layer=labels"
    loading="lazy"
    title="Interactive label visualization playground"
  ></iframe>
</div>

## Add a label layer

```ts
session.setPresentation({
  labelStyle: new BaseLabelStyle({
    background: { alpha: 0.9 },
    includeConfidence: true,
    textStyle: { fontSize: 14 },
  }),
});
```

Labels need a resolvable detection rectangle for placement, but the box layer
does not need to be visible. Use placement and offset options to move text
without changing the geometry.

See [Interactive Picking](../recipes/interactive-picking.md) for hover-only
labels and selection-aware presentation.
