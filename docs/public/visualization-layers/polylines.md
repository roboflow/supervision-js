---
title: Polylines
summary: Draw open paths in media coordinates.
---

# Polylines

Polylines are open paths with at least two media-pixel points. Use
`BasePolylineStyle` for guides, trajectories, and other paths that must not
close back to their first point.

> **Fixture status:** the browser renderer supports polylines, but the
> committed basketball fixture has no semantic open-path data. This page does
> not fabricate an overlay solely for the docs. A focused playground will ship
> with a frozen, reproducible fixture that contains real polyline input.

## Add a polyline layer

```ts
session.setPresentation({
  polylineStyle: new BasePolylineStyle({
    stroke: { width: 4 },
  }),
});
```

Use a polygon instead when the path represents a closed region with fill.
