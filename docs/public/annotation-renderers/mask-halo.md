---
title: Mask Halo
summary: A GPU glow that follows the exact mask silhouette at any spread.
---

# Mask Halo

The mask halo annotation renderer draws a soft glow around each detection's
segmentation mask. The browser package maps the prepared id mask through a
per-detection color palette and blurs that coverage on the GPU, so the glow
hugs the exact silhouette with no per-frame CPU work and without invalidating
prepared mask artifacts. Detections may request different spreads; each spread
renders in its own blur pass.

<div class="supervision-layer-playground">
  <iframe
    data-supervision-playground-src="demo/?embed=annotation-renderer&amp;renderer=mask-halo"
    loading="lazy"
    title="Interactive mask halo visualization playground"
  ></iframe>
</div>

## Add the mask halo renderer

```ts
session.setPresentation({
  renderers: [
    annotationRenderers.maskHalo({
      style: {
        resolve: (detection) =>
          detection.mask
            ? { alpha: 0.6, color: 0x8b5cf6, spread: 12 }
            : undefined,
      },
    }),
  ],
});
```

Listing `maskHalo` without an explicit style uses the canonical class-colored
glow. The halo composes with the mask renderer but does not require it:
listing only `maskHalo` renders the glow alone while the browser package
prepares the required mask coverage internally.

`spread` is the blur radius in screen pixels and is honored per detection.
Halos are presentation only: they are never pickable or editable, and hidden
classes and detections never glow.

See [Masks](./masks.md) for the mask renderer this halo builds on.
