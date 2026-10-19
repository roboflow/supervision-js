---
title: Oriented Box
summary: Draw an explicit rotated quadrilateral with independent fill and stroke.
---

# Oriented Box

The oriented-box annotation renderer draws one explicit quadrilateral per
detection from `Detection.orientedBox`. `BaseOrientedBoxStyle` controls its
fill, stroke, and visibility independently from boxes, masks, or polygons on
the same detection.

<div class="supervision-layer-playground">
  <iframe
    data-supervision-playground-src="demo/?embed=annotation-renderer&amp;renderer=oriented-box"
    loading="lazy"
    title="Interactive oriented-box visualization playground"
  ></iframe>
</div>

## Add the oriented-box renderer

```ts
session.setPresentation({
  renderers: [
    annotationRenderers.orientedBox({
      style: new BaseOrientedBoxStyle({
        fill: { alpha: 0.16 },
        stroke: { width: 3 },
      }),
    }),
  ],
});
```

## Geometry contract

`Detection.orientedBox` carries four explicit media-pixel vertices, ordered
clockwise starting from the box's own top-left corner (its top-left before any
rotation was applied):

```ts
detection.orientedBox = {
  points: [
    { x: topLeftX, y: topLeftY },
    { x: topRightX, y: topRightY },
    { x: bottomRightX, y: bottomRightY },
    { x: bottomLeftX, y: bottomLeftY },
  ],
};
```

This is a separate field from `rect`. `Rect` stays axis-aligned and
center-based; it never gains a rotation field, and this renderer never
reinterprets an axis-aligned `rect` as rotatable. A detection may carry both a
`rect` (or `mask`/`polygon`) and an `orientedBox` at the same time, for example
when a host wants an axis-aligned box and a separately computed rotated
minimum-area box for the same object.

Nothing in `supervision-js` computes an oriented box from a mask or a plain
`rect`. A producer that only has one of those, such as an oriented-object
detector that emits four corner coordinates directly, supplies
`detection.orientedBox` itself. Frame validation requires exactly four points
with finite coordinates. Producers must supply a convex quadrilateral in
clockwise perimeter order. `BaseOrientedBoxStyle` also skips zero-area geometry;
it does not repair invalid vertex ordering.

The renderer reuses the existing closed-path fill and stroke drawing that
polygons use; it does not introduce a second rasterization path. The renderer
only controls presentation. An editable session can select and move the whole
detection, translating its OBB vertices along with its other geometry. OBB
rotation and individual vertex editing are not supported. If the detection
also has an editable `rect`, its resize handles change only that rectangle,
not the independent OBB. Both geometries remain visible in the editing preview.

The playground's basketball fixture pairs its real SAM3-derived basketball
detections with a hand-authored oriented box: a fixed rotation of the
already-committed ball rectangle, applied once when the fixture was prepared,
not produced by any oriented-box model. See
[Detections And Rendering](../guides/detections-and-rendering.md) for the
complete detection geometry contract.
