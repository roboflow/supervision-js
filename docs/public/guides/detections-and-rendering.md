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
