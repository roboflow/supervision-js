---
title: Polygons
summary: Draw closed media-space geometry with independent fill and stroke.
---

# Polygons

The polygon annotation renderer draws closed paths with at least three
media-pixel points. `BasePolygonStyle` controls their fill, stroke, and
visibility independently from boxes or masks on the same detection.

<div class="supervision-layer-playground">
  <iframe
    data-supervision-playground-src="demo/?embed=annotation-renderer&amp;renderer=polygons"
    loading="lazy"
    title="Interactive polygon visualization playground"
  ></iframe>
</div>

## Add the polygon renderer

```ts
session.setPresentation({
  renderers: [
    annotationRenderers.polygon({
      style: new BasePolygonStyle({
        fill: { alpha: 0.16 },
        stroke: { width: 3 },
      }),
    }),
  ],
});
```

Overlapping polygons each keep their whole fill and stroke. Where one covers
part of another, the lower polygon's outline stays complete and its fill shows
through the translucent polygon above, as if each were drawn on its own in
detection order.

The basketball fixture keeps its source masks beside deterministic,
mask-derived polygons. That makes it possible to compare the two layers without
recovering geometry from rendered pixels.

See [Detections And Rendering](../guides/detections-and-rendering.md) for the
complete detection geometry contract.

When an editing engine is attached, polygons share detection stacking order
with retained boxes and other vector geometry. See the [editing contract](../guides/public-api.md#editing-api)
for ordering and the opt-in topmost picking policy.
