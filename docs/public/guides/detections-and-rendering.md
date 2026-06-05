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
   Converts hot detections into renderer-friendly artifacts. Masks use prepared
   frame-level PNG ID-mask artifacts by default.
4. **Active render frame**
   Presents the one media frame and matching annotation artifacts selected from
   the current playback reference.

## Detection Contract

Detection frames are app/model data:

- `mediaTime` is seconds on the renderer media timeline;
- `endTime` is exclusive when present;
- `frameIndex` is optional and only used by frame-grid synchronization;
- rectangles are media-pixel geometry;
- masks are compressed RLE semantic masks;
- confidence values are normalized from `0` to `1`;
- styling belongs to styles, not detections.

The library validates incoming frames before storing or buffering them. Invalid
geometry, mask dimensions, confidence values, or frame timing fail early instead
of becoming renderer behavior later.

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
- **renderer layers** draw boxes, masks, labels, and interactions efficiently;
- prepared artifacts stay internal to the renderer.

This keeps detection data clean and keeps rendering performance decisions inside
the engine.

Styles are small objects with a `resolve(detection, context)` method. They return
renderer-neutral draw instructions or `undefined` to skip a detection. The
default styles are intentionally practical, but custom styles can change class
colors, opacity, labels, confidence filtering, and shape choices without
changing the stored detections.
