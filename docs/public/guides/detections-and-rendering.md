---
title: Detections And Rendering
group: Guides
summary: How semantic detections move through cold storage, hot windows, prepared artifacts, and active renderer frames.
---

# Detections And Rendering

The rendering pipeline separates semantic detection data from renderer-owned
runtime artifacts.

## Pipeline

1. **Cold detection source**
   Stores semantic detections such as boxes, class names, confidence values, and
   compressed RLE masks.
2. **Hot detection window**
   Keeps a bounded range of detection frames near the current playback time.
3. **Prepared render window**
   Converts hot detections into renderer-friendly artifacts. Masks and polygons
   rasterize into frame-level ID-mask artifacts by default; boxes, polylines,
   and keypoints have nothing to prepare and draw from the detection data.
4. **Active render frame**
   Presents the one media frame and matching annotation artifacts selected from
   the current playback reference.

## What The Two Playback Gates Wait For

Both gates are on by default. The two gates are not annotations against masks. A mask is one geometry a
detection can carry, beside boxes, polygons, polylines, and keypoints, so both
gates are about detections. They differ in which stage above they wait on.

- The detection-coverage gate, `detections.playbackGate`, waits for **arrival**:
  whether this frame's detections have reached the source at all, or are still
  being fetched, or are still being written by a producer that is running. It
  cannot tell one geometry from another, because a frame with no data carries
  none of them.
- The render-preparation gate, `renderer.renderPreparation.playbackGate`, waits
  for **preparation**: whether the geometries that need rasterizing have become
  the ID-mask artifact that draws them. Masks and polygons take that step. The
  other geometries have nothing to rasterize, so this gate never waits on them.

Both gates hold every frame on either kind of media source. A source the
renderer pulls samples from waits between decoding and drawing. On a source
that presents its own frames, the renderer stops the producer when detection
coverage or prepared artifacts are missing and starts it again when the wait
settles. See
[Media Sessions](./media-sessions.md) for the defaults and the single switch
that answers for both.

## Detection Contract

Detection frames are app/model data:

- `mediaTime` is seconds on the renderer media timeline;
- `endTime` is exclusive when present;
- `frameIndex` is optional and only used by frame-grid synchronization;
- rectangles, polygons, polylines, and keypoints are media-pixel geometry;
- rectangle `x` and `y` identify its center, not its top-left corner;
- polygon paths need at least three points and polylines need at least two;
- keypoint visibility uses COCO-compatible `NotLabeled`, `Occluded`, and
  `Visible` values;
- masks are compressed RLE semantic masks;
- confidence values are normalized from `0` to `1`;
- styling belongs to styles, not detections.

The library validates incoming frames before storing or buffering them. Invalid
geometry, mask dimensions, confidence values, or frame timing fail early instead
of becoming renderer behavior later.

## Source Provenance

When detections are composed from multiple sources, copied detections can carry
two renderer-neutral provenance fields:

- `sourceId` identifies the source entry that produced the copied detection;
- `sourceDetectionIndex` identifies the detection's index inside that source
  frame before composition.

These fields are intentionally generic. A product may decide that one source is
model output and another is ephemeral user drawing state, but the library only
uses provenance to support deterministic ordering, source-aware styling, and
host callbacks.

Advanced integrations can compose sources directly:

```ts
const source = createCompositeDetectionFrameSource({
  sources: [
    { frames: modelFrames, id: "model" },
    { frames: overlayFrames, id: "overlay", order: 10 },
  ],
});
```

## Which Pixels Geometry Is In

A box, a label anchor, a polygon, a polyline, and a keypoint are absolute media
pixels. The numbers reach the scene whose unit is one media pixel. Present the
same detections against a raster of a different size and every one of them is
drawn at the wrong fraction of the picture, far enough off that objects near an
edge take their labels off the canvas entirely.

Masks are the exception. A `DetectionMask` carries the pixel size its `counts`
are encoded against, and the mask layer stretches the sprite onto whatever the
media is, so a mask lands correctly at any raster. That difference is why a
rescaled source shows correct masks beside misplaced boxes.

Vector geometry is reconciled by declaring where it came from.
`DetectionFrame.coordinateSpace` names the pixel space a frame's geometry was
produced in. The media renderer wraps every detection source in
`createProjectedDetectionFrameSource`, which scales that geometry onto the
presented frame and leaves masks alone so the ratio is never applied twice.

It is opt-in, and that is the trap: a frame that declares nothing is taken at
its word as already being in the presented frame's pixels. Any source whose
geometry was computed against a different raster than the one being played has
to declare its space, or the annotations are silently wrong rather than
visibly broken.

## Why Not Draw Every RLE Mask Every Frame?

Compressed RLE is good cold semantic storage. It is not the best thing to loop
over in the active video render path.

For dense masks, the library prepares a frame-level ID mask artifact. Each pixel
stores background or detection identity. Pixi renders that artifact with shader
palette styling, so changing class colors and opacity can stay cheap.

## Styling

In Python `supervision`, visual behavior is usually expressed through
annotators. In `supervision-js`, the equivalent shape is:

- **styles** define how detections should look;
- **annotation renderers** select boxes, masks, labels, paths, and keypoints;
- the browser backend draws those renderers efficiently;
- prepared artifacts stay internal to the renderer.

This keeps detection data clean and keeps rendering performance decisions inside
the engine.

Styles are small objects with a `resolve(detection, context)` method. They return
renderer-neutral draw instructions or `undefined` to skip a detection. The
default styles are intentionally practical, but custom styles can change class
colors, opacity, labels, confidence filtering, and shape choices without
changing the stored detections.

The built-in base styles accept static values for simple global styling and
resolver functions for per-detection behavior:

```ts
const boxStyle = new BaseBoxStyle({
  cornerRadius: (detection) => (detection.className === "basketball" ? 999 : 8),
  shape: BoxShape.RoundedRect,
  shouldRender: (detection) => (detection.confidence ?? 0) >= 0.5,
  stroke: (detection) => ({
    color: detection.className === "person" ? 0x22c55e : 0xa855f7,
    width: 3,
  }),
});

session.setPresentation({
  renderers: [annotationRenderers.box({ style: boxStyle })],
});
```

Use a custom style object when the base classes are not expressive enough. The
contract stays the same: detections remain semantic data, and styles resolve how
that data should be presented.

Continue to [Annotation Renderers](../annotation-renderers.md) for focused box,
mask, label, polygon, polyline, and keypoint examples backed by the frozen
basketball fixture.

## Geometry Shapes

One detection may carry any supported semantic geometry:

```ts
import { KeypointVisibility, type Detection } from "supervision";

const detection: Detection = {
  id: "pose-1",
  className: "person",
  rect: { x: 320, y: 240, width: 180, height: 360 },
  polygon: {
    points: [
      { x: 230, y: 60 },
      { x: 410, y: 60 },
      { x: 420, y: 420 },
      { x: 220, y: 420 },
    ],
  },
  keypoints: {
    points: [
      { x: 320, y: 100 },
      { x: 280, y: 180 },
      { x: 360, y: 180 },
    ],
    edges: [
      [0, 1],
      [0, 2],
    ],
    visibility: [
      KeypointVisibility.Visible,
      KeypointVisibility.Visible,
      KeypointVisibility.Occluded,
    ],
  },
};
```

The corresponding `boxStyle`, `polygonStyle`, and `keypointStyle` independently
decide which layers render. Geometry remains reusable app/model data.
