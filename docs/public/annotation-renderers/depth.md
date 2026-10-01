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

<div class="supervision-layer-playground">
  <iframe
    data-supervision-playground-src="demo/?embed=depth"
    loading="lazy"
    title="Interactive depth map playground"
  ></iframe>
</div>

The playground plays eight seconds of a rendered stereo shot, Spring sequence
0021, with two disparity layers for its left view:

- **Stereo matcher (OpenCV SGBM)** is what OpenCV's semi-global block matcher
  finds on the stereo pair: the kind of map a matcher or depth model hands the
  renderer, with its holes (the leftmost 64 columns, occlusions, rejected
  matches) and its errors.
- **Ground truth (Spring)** is the disparity the dataset rendered for the same
  frames. Only the sky has no depth.

Each layer is a clip `depth.json`: an exact 16-bit PNG per frame and an 8-bit
preview video of the same frames. While the clip plays, each video frame is
drawn with its own preview frame, and the readout says it is an 8-bit preview
value with its step; once playback rests, the exact frame replaces it. The
readout's depth frame is always the frame on screen. Turn on **Paint pixels
without depth** to see where the matcher found nothing.

The clip is adapted from the Spring dataset by Mehl et al. (CVPR 2023,
[doi:10.18419/darus-3376](https://doi.org/10.18419/darus-3376)) and the Spring
open movie by Blender Foundation, both under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The fixture's
`demo/fixtures/spring_stereo_depth/README.md` lists the changes made and how
each layer was computed.

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

The session does not wait for a manifest. The media shows and plays as soon
as it can, and depth joins it when its files arrive, redrawing the frame on
screen; on a slow link that can be well after the video starts. A manifest
that fails to load leaves the media playing without depth, with a console
warning and the reason in the depth diagnostics `message`. To show that
depth is still loading, or to catch its error, open the session without
`depth` and call `session.setDepth()`, which resolves once the renderer has
it:

```ts
setStatus("Loading depth…");
session
  .setDepth?.({ manifest: "sgbm/depth.json" })
  .then(() => setStatus(null))
  .catch((error) => setStatus(`Depth did not load: ${error}`));
```

A clip manifest names one PNG per video frame, so its media must come with a
frame index: the web video engine source. While the video plays, the session
draws the manifest's 8-bit preview video, decoded ahead of the playhead, frame
for frame; once playback rests, it draws the exact frame for the video frame
on screen:

```ts
import {
  annotationRenderers,
  createMediaSession,
  createWebVideoEngineMediaRendererSource,
} from "supervision";
import { SourceKind } from "supervision/web-video-engine";

const session = await createMediaSession({
  container,
  media: createWebVideoEngineMediaRendererSource({
    source: { kind: SourceKind.Url, url: "left.mp4" },
  }),
  depth: { manifest: "sgbm/depth.json" },
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

## Where depth works

A depth picture is one map drawn under every frame: `depth: { map }`, or a
manifest with `image`. Depth video is a clip manifest (`frames`), one map per
video frame.

| Media                                                         | Depth picture                                            | Depth video                                                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| A URL or file: the default path, through Mediabunny           | Yes                                                      | No, by design: playing depth decodes a second video beside the clip, which this path does not support |
| Web video engine: `createWebVideoEngineMediaRendererSource()` | Yes                                                      | Yes                                                                                                   |
| Still image                                                   | Yes                                                      | No video to pair it with                                                                              |
| `MediaStream` (camera): `createMediaStreamRendererSource()`   | Yes, the same map under every frame, not matched to them | No; live depth with timestamps is future work                                                         |

## Depth during playback

A clip's `preview` is decoded beside the video, by one WebCodecs decoder in
the page, ahead of the playhead; each decoded frame's codes are copied out in
the session's render-preparation worker. Every presented video frame is drawn
with the preview frame of the same index, its texture uploaded before the
frame is presented. A frame whose preview has not been decoded
yet draws no depth rather than another frame's. When the session's playback
gate is on (the default), playback waits for the preview the way it waits for
masks: it holds while the decoded lead in front of the playhead is short and
resumes once it has caught up, and `maxWaitSeconds` bounds every wait.
`renderPreparation.onDiagnostics` reports the preview window as a
`depthFrame` artifact: frames held, the lead in seconds, the hold in force and
`gateHoldCount`.

When playback rests for 0.15 s, the exact PNG for the frame on screen is
fetched and replaces the preview, then its neighbours are fetched for
stepping. A preview value is within one preview step of the exact value, plus
the video codec's error; `readDepthAt` reports `precision: "preview"` and the
`step` for it.

`renderPreparation.depth` sets the budgets. By default the session keeps about
2.25 seconds of preview (twice the 1-second prefetch, plus a quarter second
behind the playhead) at the clip's resolution, at least 96 MiB and at most
512 MiB, and 128 MiB of exact frames, more for clips too large to hold the
frame at rest and its neighbours twice:

```ts
const session = await createMediaSession({
  // ...
  renderer: {
    renderPreparation: {
      depth: {
        maxPreviewCacheBytes: 256 * 1024 * 1024,
        previewPrefetchSeconds: 2,
      },
    },
  },
});
```

Browsers decode the same H.264 differently. Once per page, before the first
preview opens, the session decodes a small clip of all 256 codes with each
decoder the browser offers and keeps the one that returns them as written.
Chrome's hardware decoder on macOS returns full-range luma squeezed into video
range (code 0 comes back as 16, 255 as 235), so Chrome decodes previews in
software, where every code is exact. Firefox hands decoded frames over in RGB,
which leaves 36 of the 256 codes one off; the session says so in the depth
diagnostics `message` and in a console warning.

Some decoders hand frames back only once more input arrives or a flush asks
for them. The session flushes a decoder that sits on every frame it was
given, at the next key frame, so no frame is lost. Every wait on a decoder
has a deadline (3 s for a support check or a flush that returns nothing, 5 s
for the probe's first frame); downloading the preview never does, since a
slow link is no fault. Where no decoder returns a frame of the probe, the
preview is left off without being fetched, and a decoder that stops while
playing is closed: the clip then draws exact depth while playback rests and
none while it plays, and says why in the diagnostics `message` and once in
the console.

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

`depthColormapColors(colormap, stops)` returns CSS colours from the same table
the renderer draws with, far end first, so a legend matches the picture:

```ts
import { depthColormapColors } from "supervision";

legend.style.background = `linear-gradient(to right, ${depthColormapColors(
  "turbo",
).join(", ")})`;
```

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

### Writing the preview video

The preview is H.264 with the codes in luma: one frame per depth frame, at the
video's frame times, `yuv420p` with every chroma sample 128, and the full-range
flag set so the codes keep their values. Monochrome (`gray`, High 4:0:0)
streams do not decode reliably in browsers. From raw `yuv420p` frames whose
luma holds the codes:

```sh
ffmpeg -f rawvideo -pix_fmt yuv420p -s 1280x720 -r 24 -i preview.yuv \
  -c:v libx264 -crf 18 -tune psnr -g 24 -keyint_min 24 -sc_threshold 0 \
  -bsf:v h264_metadata=video_full_range_flag=1 -movflags +faststart preview.mp4
```

Opening the clip checks the preview against the video: a different frame
count, or a frame whose time differs from its video frame's by more than half
a millisecond, counted from each one's first frame, rejects the depth with a
`RangeError` that names the frame and both times. A preview that starts its
clock at another time but keeps the frames in step is accepted.

### Writing depth PNGs that decode fast

The depth PNG is a standard 16-bit grayscale PNG, not interlaced, with 0 where
there is no depth. Browsers decode it in JavaScript on top of their own zlib,
and the PNG row filter the writer picks decides how much JavaScript work that
is. Up and Sub rows undo in one addition per byte; Paeth rows need a
three-way comparison per byte and take 1.7 to 2.3 times as long. Some writers
choose a filter per row by default: Pillow picks mostly Paeth rows for depth
maps. The depth benchmark in `benchmark/depth/` has the numbers.

A writer that lets you choose should write every row with one simple filter:
OpenCV's `cv2.imwrite(path, depth, [cv2.IMWRITE_PNG_FILTER, cv2.IMWRITE_PNG_FILTER_UP])`,
or libpng's `png_set_filter(png, 0, PNG_FILTER_UP)`. The file stays a standard
PNG that every tool opens; on a synthetic test scene it came out 6% (Up) to
12% (Sub) larger than Pillow's per-row choice at the same compression level.

## Limits

- A clip manifest (`frames`) pairs one PNG with each video frame, so it needs
  media with a frame index: `createWebVideoEngineMediaRendererSource()`. Other
  media refuse it with a `RangeError`, and so does a clip whose frame count
  differs from the video's without `frames.times_s`.
- A clip without a `preview`, or on a browser that cannot decode it, draws
  no depth while it plays. With one, the preview's precision is what plays:
  one 8-bit step of `range_px`, plus the codec's error. Exact depth needs
  playback to rest for 0.15 s.
- A preview decodes at the browser's pace. Where that is slower than the
  rate asks for (in a benchmark, Firefox decoded a 4K preview at about 51
  frames a second, so 8x of a 24 fps clip outran it), the playback gate
  stops playback until the decoded lead catches up, each stop bounded by
  `maxWaitSeconds`; with the gate off, frames the decoder has not reached
  draw no depth.
- On WebGL a map whose width is odd goes up with one padding texel per row,
  padded by the worker while it decodes a manifest's PNG; WebGPU uploads the
  samples as they are.
- A map wider or taller than the GPU's largest texture (asked of the backend
  once; commonly 16384 on WebGL and 8192 on WebGPU) is drawn from a
  nearest-decimated copy that fits. Readouts still read every sample.
- React Native reports the depth renderer as unsupported.
