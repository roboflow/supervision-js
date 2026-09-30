---
title: Depth maps
summary: Colour a depth or disparity map over media and read exact values under the pointer.
---

# Depth maps

A depth map holds a distance for every pixel of the media: stereo disparity in
pixels, metric depth in metres, or relative inverse depth from a monocular
model. It is its own channel beside detections, not a detection field. The
session receives it through its `depth` option, and
`annotationRenderers.depth()` colours it under every detection layer. The map
is stretched over the whole media rectangle, like a mask, so it may be smaller
than the media as long as it keeps the media's aspect ratio (within 1%).

This page has no live playground yet. A playground needs a committed stereo
fixture with real model output, and that fixture is still pending.

A producer's `depth.json` and 16-bit PNG load with `depth: { manifest }`. The
session fetches the PNG, decodes it in its render-preparation worker, and
draws it; relative file names resolve against the manifest's URL:

```ts
import { annotationRenderers, createMediaSession } from "supervision";

const session = await createMediaSession({
  container,
  media: "left.png",
  depth: { manifest: "depth/depth.json" },
  presentation: { renderers: [annotationRenderers.depth()] },
});
```

A map you already hold in memory goes in as `depth: { map }`:

```ts
import {
  annotationRenderers,
  createMediaSession,
  type DepthMap,
} from "supervision";

const depth: DepthMap = {
  kind: "disparity_px",
  width: 1280,
  height: 720,
  // Stored value / scale is disparity in pixels; 0 means no depth.
  samples: { encoding: "scaled16", values: disparity, scale: 256 },
  camera: { fxPx: 1050.3, baselineM: 0.12 },
  displayRange: { min: 4.2, max: 118.7 },
};

const session = await createMediaSession({
  container,
  media: "left.mp4",
  depth: { map: depth },
});

session.setPresentation({
  renderers: [annotationRenderers.depth({ colormap: "turbo" })],
});
```

Every option is presentation, so changing one recolours the map without
reloading or re-uploading it:

- `colormap`: `"turbo"` (default), `"viridis"`, `"cividis"`, `"inferno"`,
  `"magma"` or `"grayscale"`. The near end is always the warm or bright end.
  Turbo separates the most depth steps; Viridis and Cividis keep their order in
  grayscale and for colour-blind viewers.
- `quantity`: `"disparity"` (default) colours inverse depth, which spends
  colour on near detail the way stereo measures it. `"depth"` colours metres
  and needs metric data or a `camera`; without one the renderer colours
  disparity and warns once.
- `range`: `"clip"` (default) uses the map's `displayRange`, `"auto"` uses this
  frame's own 2nd to 98th percentile, and `{ min, max }` fixes the range in the
  quantity's unit. Values outside the range clamp to its ends. `"clip"` behaves
  as `"auto"` for a map without a display range.
- `opacity` from 0 to 1 (default 1), and `wipe`, the share of the media width
  from the left that shows depth (default 1).
- `sampling`: `"auto"` (default) shows the nearest map pixel when the map is at
  least media size and filters edge-aware when it is smaller, so a foreground
  edge never blends into the background. `"nearest"` and `"edge-aware"` force
  one or the other.
- `noDepthColor`: `null` (default) leaves pixels without depth unpainted, and
  `0xRRGGBB` paints them.

Two depth renderers with distinct ids can share one map, for example two
colormaps split by `wipe`. `session.setDepth()` swaps or removes the map without
reopening the media; it takes a map or a manifest, and a call made while a
manifest is still loading wins over it.

## Reading depth under the pointer

`session.renderer.getActiveDepth()` returns the map on screen and the media
size it is stretched over. `readDepthAt` reads the pixel under a media-space
point from the map's own arrays, so the answer is the stored value, not a
colour.

```ts
import { readDepthAt } from "supervision";

container.addEventListener("pointermove", (event) => {
  const active = session.renderer.getActiveDepth?.();
  if (!active) return;

  const box = container.getBoundingClientRect();
  const point = session.renderer.screenToMedia({
    x: event.clientX - box.left,
    y: event.clientY - box.top,
  });
  const readout = readDepthAt(active.map, point, {
    width: active.mediaWidth,
    height: active.mediaHeight,
  });

  // readout?.valid, readout?.disparityPx, readout?.depthM, readout?.step,
  // readout?.confidence (0 to 1, when the map has a confidence plane)
});
```

With a `camera`, disparity converts to metres as
`fxPx * baselineM / (disparity + doffsPx)`. `computeDepthPercentileRange(map)`
returns the range `"auto"` would use for that map; pass it back as
`range: { min, max }` to keep colours still while the view changes.

## Data format

Exact maps are 16-bit: `values[i] / scale` is the value in the kind's unit, and
a stored 0 is no depth. A scale of 256 keeps 1/256-pixel disparity steps up to
255 pixels. Producers describe a map in a snake_case `depth.json`, which
`parseDepthManifest` checks and converts, rejecting a bad field with a
`RangeError` that names it:

```json
{
  "schema": "supervision.depth-manifest",
  "version": 1,
  "kind": "disparity_px",
  "view": "left",
  "width": 1280,
  "height": 720,
  "storage": { "format": "png16", "scale": 256, "no_depth": 0 },
  "camera": { "fx_px": 1050.3, "baseline_m": 0.12, "doffs_px": 0 },
  "display_range_px": [4.2, 118.7],
  "image": { "file": "depth.png" }
}
```

`display_range` is the display range in the kind's unit; `display_range_px` is
its name for disparity. `image.confidence_file` names an optional 8-bit
grayscale PNG of the same size, 0 to 255 per pixel, which readouts report as
`confidence` from 0 to 1. A clip manifest replaces `image` with `frames` (a
frame count and an `exact/{index:06}.png` pattern) and may add an 8-bit
`preview` video. Preview code `c` above the reserved codes `T` stands for
`lo + (c - T - 1) / (254 - T) * (hi - lo)` of its `range_px`.

### Writing depth PNGs that decode fast

The depth PNG is a standard 16-bit grayscale PNG, not interlaced, with 0 where
there is no depth. Browsers decode it in JavaScript on top of their own zlib,
and the PNG row filter the writer picks decides how much JavaScript work that
is. Up and Sub rows undo in one addition per byte; Paeth rows need a
three-way comparison per byte and take about 1.7 times as long, and most
writers choose filters per row, mostly Paeth, by default (Pillow does; see the
depth benchmark in `benchmark/depth/` for the numbers).

A writer that lets you choose should write every row with one simple filter:
OpenCV's `cv2.imwrite(path, depth, [cv2.IMWRITE_PNG_FILTER, cv2.IMWRITE_PNG_FILTER_UP])`,
or libpng's `png_set_filter(png, 0, PNG_FILTER_UP)`. The file stays a standard
PNG that every tool opens; on the research scene it was up to 15% larger than
Pillow's per-row choice.

## Limits

- The session draws still depth: a `map`, or a manifest with an `image`. It
  does not yet play depth video; a clip manifest (`frames`) is refused with a
  `RangeError`.
- On WebGL a map whose width is odd goes up with one padding texel per row,
  padded by the worker while it decodes a manifest's PNG; WebGPU uploads the
  samples as they are.
- A map wider or taller than the GPU's largest texture (asked of the backend
  once; commonly 16384 on WebGL and 8192 on WebGPU) is drawn from a
  nearest-decimated copy that fits. Readouts still read every sample.
- React Native reports the depth renderer as unsupported.
