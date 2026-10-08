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
import { StrokeAlignment } from "supervision";

session.setPresentation({
  renderers: [
    annotationRenderers.mask({
      style: new BaseMaskStyle({
        fillAlpha: 1,
        opacity: 0.72,
        stroke: { alpha: 1, width: 2, alignment: StrokeAlignment.Outside },
      }),
    }),
  ],
});
```

`opacity` applies to the complete mask layer and can be updated cheaply.
`fillAlpha` is part of prepared fill styling and remains separate so an outline
can stay opaque.

`stroke.width` is the total outline width in CSS pixels. A width of `1` stays
one screen pixel across fitted media sizes and camera zoom; fractional coverage
can distribute that width over adjacent pixels. `stroke.alignment` defaults to
`Outside`, preserving the mask interior. Choose `Center` or `Inside` to split
the outline across the boundary or place it inside.

This corrects the previous behavior, where mask widths grew on both sides of
the boundary and scaled with the fitted media. Existing outlines can therefore
appear thinner and move outward. Browser rendering bounds the outline to 16
mask texels per side; very small fitted media can reach that limit and show a
narrower outline.

Set `annotationAntialiasing: true` to smooth mask boundaries alongside the other
annotation layers. Use `2` to preserve more mask detail up to the original
resolution before smoothing. Categorical picking continues to read exact
detection IDs. The 2× capture increases preparation work and cache bytes within
the configured budget. See
[Smooth Annotation Edges](../guides/presentation-styles.md#smooth-annotation-edges).

See [Detections And Rendering](../guides/detections-and-rendering.md) for the
semantic-mask and prepared-artifact boundary.
