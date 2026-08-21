---
title: Box corners
summary: Draw four open corner segments around each detection.
---

# Box corners

The box-corners annotation renderer draws four short open paths around a
detection's rectangle. It is useful when full boxes would obscure the media,
while still making the detection bounds easy to read.

<div class="supervision-layer-playground">
  <iframe
    data-supervision-playground-src="demo/?embed=annotation-renderer&amp;renderer=box-corners"
    loading="lazy"
    title="Interactive box corners visualization playground"
  ></iframe>
</div>

The playground uses the frozen basketball fixture's existing detection bounds.
Box corners are presentation only: they do not change the source detection,
picking, or editing behavior.

## Add the box-corners renderer

```ts
session.setPresentation({
  renderers: [
    annotationRenderers.boxCorners({
      style: new BaseBoxCornerStyle({
        length: 20,
        stroke: { color: 0x8b5cf6, width: 2 },
      }),
    }),
  ],
});
```

`BaseBoxCornerStyle` supplies the normal detection rectangle lowering. Its
`length` is expressed in screen pixels, so corners remain legible while the
viewport changes scale. Use `shouldRender` or a resolver-valued `stroke` for
per-detection visibility and appearance.
