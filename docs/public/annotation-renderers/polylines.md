---
title: Polylines
summary: Draw open paths in media coordinates.
---

# Polylines

The polyline annotation renderer draws open paths with at least two media-pixel
points. Use `BasePolylineStyle` for guides, trajectories, and other paths that
must not close back to their first point.

<div class="supervision-layer-playground">
  <iframe
    data-supervision-playground-src="demo/?embed=annotation-renderer&amp;renderer=polylines"
    loading="lazy"
    title="Interactive polyline visualization playground"
  ></iframe>
</div>

The playground isolates one basketball from the frozen basketball fixture. Its
mask and center-point trajectory share the basketball class color, so the
visible path stays tied to the object it describes. The path is a deterministic
motion-gated derived field (`basketball-motion-track-v1`) on the committed
fixture: an untrackable observation breaks the path instead of creating a false
long segment. It is not a claim that a segmentation model emitted polylines
directly.

## Add the polyline renderer

```ts
session.setPresentation({
  renderers: [
    annotationRenderers.polyline({
      style: new BasePolylineStyle({
        stroke: { width: 4 },
      }),
    }),
  ],
});
```

Use a polygon instead when the path represents a closed region with fill.
