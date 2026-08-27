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
    title="Interactive blur, pixelate, and spotlight playground"
  ></iframe>
</div>

The playground uses a frozen person-segmentation fixture. Switch between blur
and pixelation, then adjust the strength to update both the rendered media and
the minimal `session.setPresentation()` snippet. Both controls are expressed in
media pixels, so their meaning remains stable when the viewport fits or zooms
the media.

## Blur or pixelate a semantic region

```ts
session.setPresentation({
  renderers: [
    annotationRenderers.region({
      id: "person-pixelate",
      target: { className: "person" },
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

## Spotlight is focus, not a second region effect

The third playground mode is deliberately shown alongside privacy effects, but
uses the existing `BaseFocusStyle` contract. Dimming the scene while preserving
selected semantic targets belongs to focus composition, not to a second region
descriptor that would duplicate its interaction and transition behavior.

```ts
session.setPresentation({
  focusStyle: new BaseFocusStyle({
    targetMode: FocusTargetMode.Ambient,
    fill: { color: 0x020617, alpha: 0.55 },
  }),
  renderers: [],
});
```
