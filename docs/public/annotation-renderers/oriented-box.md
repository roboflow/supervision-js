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

`createOrientedBoxGeometry()` from `supervision/editing` constructs ordered
rectangle corners from a center-based `Rect` and a clockwise angle in radians.
It does not fit a rectangle to a mask, polygon or arbitrary quadrilateral.
Detectors that emit corners can supply `detection.orientedBox` directly. Frame validation requires exactly four points
with finite coordinates. Producers must supply a convex quadrilateral in
clockwise perimeter order. `BaseOrientedBoxStyle` also skips zero-area geometry;
it does not repair invalid vertex ordering.

The renderer reuses the existing closed-path fill and stroke drawing that
polygons use; it does not introduce a second rasterization path. The renderer
only controls presentation. An editable session can select and move the whole
detection, translating its OBB vertices along with its other geometry. OBB
creation, rotation and local-axis resizing are available through the editing
entrypoint for OBB-only rectangles. General quadrilaterals retain whole-shape
movement without rectangle handles. If the detection also has an editable
`rect`, its existing resize handles change only that independent rectangle.
Both geometries remain visible in the editing preview.

## Edit oriented rectangles

```ts
import {
  AnnotationGeometryKind,
  createAnnotationEditingEngine,
  createOrientedBoxGeometry,
  getOrientedRectangleGeometry,
} from "supervision/editing";

const box = createOrientedBoxGeometry(
  { x: 200, y: 120, width: 80, height: 40 }, // x/y are the center
  Math.PI / 4, // clockwise radians in image coordinates
);
const rectangle = getOrientedRectangleGeometry(box);
// { x, y, width, height, rotation }, or null for a non-rectangle.

const engine = createAnnotationEditingEngine({
  onCommit(detection, previous) {
    // Persist one previous/next pair in the host undo history.
  },
});
engine.setCreationTool({
  geometry: AnnotationGeometryKind.OrientedBox,
  createDetection(points) {
    return { orientedBox: { points: points as typeof box.points } };
  },
});
```

Pass the caller-owned engine as `renderer.editingEngine` to a media session.
Drag creation supplies four clockwise local corners to `createDetection` and
`shouldCommit`. It needs no accompanying `rect`. The selected rectangle has
eight local-axis resize controls and a compact rotation control on a short
stem. Handle rendering and hit testing share `engine.getHandles()`: the
rotation glyph has a 4 CSS-pixel radius and a separate circular 20 CSS-pixel
hit diameter; by default, its center sits 24 CSS pixels outside the first edge. Sizes stay
constant while zooming.

Rotation uses the center and the initial press angle, preserving pointer grab
offset. Resizing fixes the opposite edge or corner and clamps at a positive
one-pixel extent on crossing. Neither operation swaps width and height or
reorders corners, including squares and half/full turns. The returned angle
may wrap at pi; the physical local axes and corner identities are preserved.

Creation is bounded by supplied media dimensions. Rotation and local-axis
resize may extend beyond the image and never clip or refit a rectangle; hosts
choose their own admission policy. Escape, tool changes and pointer
interruption discard continuous edits. A completed edit emits one `onCommit`,
with its original detection for host-owned undo. Rotation reports
`AnnotationGestureStateKind.Rotating`.

### Configure rotation constraints and handle placement

Rotation is free by default. Hosts can constrain the candidate angle with
`resolveRotation`, for example to snap to 15-degree increments while Shift is held:

```ts
const step = Math.PI / 12;
const engine = createAnnotationEditingEngine({
  resolveRotation(radians, { detection, initialRotation, input }) {
    return input.shiftKey ? Math.round(radians / step) * step : radians;
  },
  // Ordered edges: 0 top, 1 right, 2 bottom, 3 left.
  rotationHandle: { edgeIndex: 1, offset: 32 },
  onCommit(detection, previous) {
    // Persist the result and record the previous detection for undo.
  },
});
```

The resolver receives an absolute clockwise angle in radians, the original
detection, its initial rotation, and the latest pointer input with modifiers.
Each preview and commit is resolved once from the original geometry and raw
pointer position; previous constrained previews never accumulate into the next
candidate. Return finite radians. The engine normalizes the result to the
geometry helper's `[-PI, PI]` convention and preserves the original center,
ordered width/height, corner identities, id and metadata. The resolver applies
only to rotation; it does not constrain movement, resizing or creation.

`rotationHandle` can also be `(detection) => ({ edgeIndex, offset })` for
annotation-specific placement. The default is edge `0` with a `24` CSS-pixel
outward offset; offset must be finite and nonnegative. Placement changes only
the control and its stem. It does not change corner ordering or infer a heading.

The browser renderer routes modifier press and release events during rotation,
so Shift snapping updates immediately while the pointer is stationary. Hosts
routing input directly can call `engine.setModifiers({ shiftKey: true })` and
`engine.setModifiers({})` on release. Omitted modifier keys are released. This
updates only an active rotation that has already crossed the drag threshold;
it neither starts movement nor commits. The final `pointerUp(input)` modifier
snapshot is authoritative. Window blur interrupts the active contact.

Use `engine.getHandles(detection, viewportScale)` when drawing or picking
controls yourself. The scale is CSS pixels per media pixel; omit it to use the
engine's `viewportScale` callback (or `1`). The pure helper remains backward
compatible and accepts the same placement configuration as a third argument:
`getAnnotationHandles(detection, viewportScale, { rotationHandle })`.
`getHandles` and `setModifiers` remain optional on the published
`AnnotationEditingEngine` and `BuiltInAnnotationEditingEngine` interfaces.
The factory returns the narrower `ConfiguredAnnotationEditingEngine`, which
guarantees both methods. Adapters fall back to the default pure helper for
older engines.

Run the self-contained [vanilla editing example](../../../examples/vanilla/oriented-box.html)
with `npm run example:vanilla:dev` and open
`/examples/vanilla/oriented-box.html`. It demonstrates creation, rotation,
resize, zoom, cancellation and undo/redo using the public package.

The playground's basketball fixture pairs its real SAM3-derived basketball
detections with a hand-authored oriented box: a fixed rotation of the
already-committed ball rectangle, applied once when the fixture was prepared,
not produced by any oriented-box model. See
[Detections And Rendering](../guides/detections-and-rendering.md) for the
complete detection geometry contract.
