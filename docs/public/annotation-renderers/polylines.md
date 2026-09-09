---
title: Polylines
summary: Draw open paths in media coordinates.
---

# Polylines

The polyline annotation renderer draws open paths with at least two media-pixel
points. Use `BasePolylineStyle` for guides, trajectories, and other paths that
must not close back to their first point.

<div class="supervision-layer-playground">
  <iframe
    data-supervision-playground-src="demo/?embed=annotation-renderer&amp;renderer=polylines"
    loading="lazy"
    title="Interactive polyline visualization playground"
  ></iframe>
</div>

The playground isolates one basketball from the frozen basketball fixture. Its
mask and center-point trajectory share the basketball class color, so the
visible path stays tied to the object it describes. The path is a deterministic
motion-gated derived field (`basketball-motion-track-v1`) on the committed
fixture: an untrackable observation breaks the path instead of creating a false
long segment. It is not a claim that a segmentation model emitted polylines
directly.

## Add the polyline renderer

```ts
session.setPresentation({
  renderers: [
    annotationRenderers.polyline({
      style: new BasePolylineStyle({
        shadowStroke: { alpha: 0.55, color: 0x000000, width: 6 },
        stroke: { width: 4 },
      }),
    }),
  ],
});
```

`shadowStroke` draws under the path so a thin class-colored line still reads
where the media beneath it shares that color, such as an orange ball trail over
a wooden court. The default polyline style carries one; pass `null` to draw the
path bare.

## Filter a path on the path

A confidence threshold applied to a trajectory is not the same filter it is
everywhere else. A path spans many frames, so one weak frame's score would erase
a path built from many strong ones, which a viewer reads as the trail blinking.
Measure the track, carry that number on the detection, and filter the polyline
layer on it while every other layer keeps filtering on `confidence`:

```ts
const polylineStyle = new BasePolylineStyle({
  shouldRender: (detection) =>
    Number(
      detection.metadata?.trajectoryConfidence ?? detection.confidence ?? 1,
    ) >= threshold,
});
```

Use a polygon instead when the path represents a closed region with fill.
