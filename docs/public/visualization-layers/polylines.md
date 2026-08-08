---
title: Polylines
summary: Draw open paths in media coordinates.
---

# Polylines

Polylines are open paths with at least two media-pixel points. Use
`BasePolylineStyle` for guides, trajectories, and other paths that must not
close back to their first point.

<div class="supervision-layer-playground">
  <iframe
    data-supervision-playground-src="demo/?embed=visualization-layer&amp;layer=polylines"
    loading="lazy"
    title="Interactive polyline visualization playground"
  ></iframe>
</div>

The playground uses a frozen CC0 pedestrian video. Its paths are an explicit
`ByteTrack`-derived center trace, not a claim that an object detector emitted
polylines directly. The fixture README records the source, model, tracker, and
derivation policy.

## Add a polyline layer

```ts
session.setPresentation({
  polylineStyle: new BasePolylineStyle({
    stroke: { width: 4 },
  }),
});
```

Use a polygon instead when the path represents a closed region with fill.
