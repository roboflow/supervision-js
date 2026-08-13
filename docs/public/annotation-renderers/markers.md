---
title: Markers
summary: Draw one anchored geometric marker for each detection.
---

# Markers

The marker annotation renderer draws one semantic marker per detection. The
default `BaseMarkerStyle` uses the detection rectangle center; a custom
`center` resolver can anchor it to a keypoint, centroid, or domain-specific
metadata location. Circle, square, triangle, and cross are style choices on
the same renderer rather than separate rendering systems.

<div class="supervision-layer-playground">
  <iframe
    data-supervision-playground-src="demo/?embed=annotation-renderer&amp;renderer=markers"
    loading="lazy"
    title="Interactive marker visualization playground"
  ></iframe>
</div>

The playground uses the frozen basketball fixture's existing detection bounds.
Markers are presentation only and do not replace the detection geometry used by
picking or editing.

## Add a marker renderer

```ts
session.setPresentation({
  renderers: [
    annotationRenderers.marker({
      style: new BaseMarkerStyle({
        shape: MarkerShape.Triangle,
        size: 14,
        stroke: { color: 0x8b5cf6, width: 2 },
      }),
    }),
  ],
});
```

`sizeSpace: MarkerSizeSpace.Screen` keeps the marker legible while zooming;
use `MarkerSizeSpace.Media` for media-relative geometry. The marker style
accepts the same renderer-neutral fill, stroke, rotation, and resolver patterns
as the rest of the presentation API.
