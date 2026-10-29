---
title: Labels
summary: Resolve class, confidence, and custom text next to detections.
---

# Labels

The label annotation renderer derives display text from semantic detections.
`BaseLabelStyle` can use a class name, caller metadata, or a custom resolver and
can include confidence without storing presentation strings in model output.

<div class="supervision-layer-playground">
  <iframe
    data-supervision-playground-src="demo/?embed=annotation-renderer&amp;renderer=labels"
    loading="lazy"
    title="Interactive label visualization playground"
  ></iframe>
</div>

## Add the label renderer

```ts
session.setPresentation({
  renderers: [
    annotationRenderers.label({
      style: new BaseLabelStyle({
        background: { alpha: 0.9 },
        includeConfidence: true,
        textStyle: { fontSize: 14 },
      }),
    }),
  ],
});
```

Labels need a resolvable detection rectangle for placement, but the box layer
does not need to be visible. Use placement and offset options to move text
without changing the geometry.

Labels round all four corners unless an edge touches a displayed detection box.
The corners along that attachment stay square: a label above a box has square
bottom corners, and a label below it has square top corners. Offsets that detach
the label restore all four rounded corners. Set `background.topCornersOnly` to
`true` to always round only the top pair, or `false` to always round all four,
and choose the radius with `background.cornerRadius`.

A custom `LabelStyle` can return an optional `layout(bounds, viewportScale)`
callback on its draw instruction. Web and React Native call it after measuring
text and padding and applying placement. `bounds` is a readonly rectangle in
media pixels; return finite `{ x, y }` coordinates to translate the label while
preserving its measured size. The translated rectangle drives both drawing and
reported label bounds on web, including picking. Return
`background: { topCornersOnly: false }` to round all corners at a detached
position, or `true` to round only the top pair. React Native honors
`background.topCornersOnly` on the instruction even without a layout callback,
and retains its default all-corner rounding when the flag is omitted.

The callback runs again for changed text, styles, scale, and editing geometry.
Use the supplied measured rectangle rather than previously reported bounds;
those describe the previous rendered position.

See [Interactive Picking](../recipes/interactive-picking.md) for hover-only
labels and selection-aware presentation.
