---
title: Ellipse
summary: Draw an elliptical footprint arc under each detection.
---

# Ellipse

The ellipse annotation renderer draws an ellipse or elliptical arc per
detection in media coordinates. Its default look matches the Python
Supervision `EllipseAnnotator`: a footprint arc swept from -45&deg; to
235&deg; under the detection box, in the class color — the broadcast-style
marker familiar from sports footage.

<div class="supervision-layer-playground">
  <iframe
    data-supervision-playground-src="demo/?embed=annotation-renderer&amp;renderer=ellipse"
    loading="lazy"
    title="Interactive ellipse visualization playground"
  ></iframe>
</div>

The playground pins one fixed arc color so the snippet below is exactly what
renders; omit the `style` entirely to use the canonical class-colored default.
Ellipses are presentation only: they are never pickable and never become
editable annotations.

## Add the ellipse renderer

```ts
session.setPresentation({
  renderers: [
    annotationRenderers.ellipse({
      style: {
        resolve: (detection) => {
          if (!detection.rect) return undefined;
          const radiusX = detection.rect.width / 2;
          const radiusY = radiusX * 0.35;
          return {
            center: {
              x: detection.rect.x,
              y: detection.rect.y + detection.rect.height / 2 - radiusY,
            },
            endAngle: (235 * Math.PI) / 180,
            radiusX,
            radiusY,
            startAngle: (-45 * Math.PI) / 180,
            stroke: { color: 0x8b5cf6, width: 2 },
          };
        },
      },
    }),
  ],
});
```

`EllipseStyle.resolve` receives each semantic detection and returns the
`EllipseDrawInstruction` to draw for it, or `undefined` to skip the
detection. Omitting both `startAngle` and `endAngle` draws a closed ellipse;
`rotation` spins the ellipse around its center. `fill` and `stroke` reuse the
box fill and stroke contracts, including per-detection functions.
