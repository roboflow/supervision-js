---
title: Masks
summary: Render compressed RLE masks with independent fill and outline styling.
---

# Masks

The mask annotation renderer keeps compressed RLE masks semantic in detection
frames. `BaseMaskStyle` controls the visible fill, global opacity, outline, and
render mode while the browser package privately prepares efficient artifacts.

<div class="supervision-layer-playground">
  <iframe
    data-supervision-playground-src="demo/?embed=annotation-renderer&amp;renderer=masks"
    loading="lazy"
    title="Interactive mask visualization playground"
  ></iframe>
</div>

## Add the mask renderer

```ts
session.setPresentation({
  renderers: [
    annotationRenderers.mask({
      style: new BaseMaskStyle({
        fillAlpha: 1,
        opacity: 0.72,
        stroke: { alpha: 1, width: 2 },
      }),
    }),
  ],
});
```

`opacity` applies to the complete mask layer and can be updated cheaply.
`fillAlpha` is part of prepared fill styling and remains separate so an outline
can stay opaque.

See [Detections And Rendering](../guides/detections-and-rendering.md) for the
semantic-mask and prepared-artifact boundary.
