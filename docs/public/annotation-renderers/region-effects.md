---
title: Region Effects
summary: Blur or pixelate exact semantic regions without leaving the media scene.
---

# Region Effects

Region effects transform a crop of the renderer-owned current media frame
before that crop is composited over its semantic detection region. They are a
capability of the multi-instance [region renderer](./asset-regions.md), not a
separate detection format or a PixiJS API.

Use mask coverage whenever segmentation is available. It keeps the effect inside
the exact detected silhouette, and the renderer omits a detection without a
usable mask rather than falling back to an unsafe rectangle.

<div class="supervision-layer-playground">
  <iframe
    data-supervision-playground-src="demo/?embed=annotation-renderer&amp;renderer=region-effects"
    loading="lazy"
    title="Interactive blur and pixelate playground"
  ></iframe>
</div>

The playground uses the committed, pre-normalized basketball fixture. Choose one
team class, switch between blur and pixelation, then adjust the strength to
update both the rendered media and the minimal `session.setPresentation()`
snippet. Limiting an effect to one semantic class keeps the example focused and
bounds the number of active effect regions. Both controls are expressed in media
pixels, so their meaning remains stable when the viewport fits or zooms the
media.

## Blur or pixelate a semantic region

```ts
session.setPresentation({
  renderers: [
    annotationRenderers.region({
      id: "yellow-team-player-pixelate",
      target: { className: "yellow team player" },
      source: {
        kind: "media",
        region: { kind: "bounds" },
        coverage: { kind: "mask" },
        effect: { kind: "pixelate", size: 12 },
      },
      region: { kind: "bounds" },
      compose: { mode: "over" },
    }),
  ],
});
```

`effect: { kind: "blur", strength }` and `effect: { kind: "pixelate", size }`
are the supported bounded media effects. They reuse the presented media texture
and prepared coverage; they do not start a second decoder or read a composited
canvas through the CPU.
