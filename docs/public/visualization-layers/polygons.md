---
title: Polygons
summary: Draw closed media-space geometry with independent fill and stroke.
---

# Polygons

Polygons are closed paths with at least three media-pixel points.
`BasePolygonStyle` controls their fill, stroke, and visibility independently
from boxes or masks on the same detection.

<div class="supervision-layer-playground">
  <iframe
    data-supervision-playground-src="demo/?embed=visualization-layer&amp;layer=polygons"
    loading="lazy"
    title="Interactive polygon visualization playground"
  ></iframe>
</div>

## Add a polygon layer

```ts
session.setPresentation({
  polygonStyle: new BasePolygonStyle({
    fill: { alpha: 0.16 },
    stroke: { width: 3 },
  }),
});
```

The basketball fixture keeps its source masks beside deterministic,
mask-derived polygons. That makes it possible to compare the two layers without
recovering geometry from rendered pixels.

See [Detections And Rendering](../guides/detections-and-rendering.md) for the
complete detection geometry contract.
