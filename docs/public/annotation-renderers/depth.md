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
drawn with its own exact frame when those load fast enough to keep up, and
with its own preview frame otherwise, where the readout says it is an 8-bit
preview value with its step; once playback rests, the exact frame is drawn.
The readout's depth frame is always the frame on screen. Turn on **Paint pixels
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
frame index. A URL or file gets one the first time a clip asks: the session
reads the file's packet table, the way the web video engine reads its own, and
pairs each depth frame with the video frame of the same timestamp. While the
video plays, the session draws the exact frames, loaded ahead of the
playhead, when they keep up, and the manifest's 8-bit preview video, decoded
ahead the same way, when they do not; once playback rests, it draws the exact
frame for the video frame on screen:

```ts
import { annotationRenderers, createMediaSession } from "supervision";

const session = await createMediaSession({
  container,
  media: "left.mp4",
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

A map's `samples` may also be 8-bit `preview8` codes, as a clip's preview
carries them; `readDepthAt` and `getActiveDepth()` then report
`precision: "preview"`.

Every option is presentation, so changing one recolours the map without
reloading or re-uploading it:

- `colormap`: `"turbo"` (default), `"viridis"`, `"cividis"`, `"inferno"`,
  `"magma"` or `"grayscale"`. The near end is always the warm or bright end.
  Turbo separates the most depth steps; Viridis and Cividis keep their order in
  grayscale and for colour-blind viewers.
- `quantity`: `"disparity"` (default) colours inverse depth, which spends
  colour on near detail the way stereo measures it. `"depth"` colours metres
  and needs metric data or a `camera`; without one the renderer colours
  disparity and warns once. A metric map without a `camera` has no pixels of
  disparity, so its disparity is inverse depth in 1/m, the unit its `range`
  takes too.
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

| Media                                                         | Depth picture                                            | Depth video                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------- |
| A URL or file: the default path, through Mediabunny           | Yes                                                      | Yes. The first clip reads the file's packet table to index its frames |
| A file converted with `normalize: { stream: true }`           | Yes                                                      | No: while it converts, not all of its frames are known                |
| Web video engine: `createWebVideoEngineMediaRendererSource()` | Yes                                                      | Yes                                                                   |
| Still image                                                   | Yes                                                      | No video to pair it with                                              |
| `MediaStream` (camera): `createMediaStreamRendererSource()`   | Yes, the same map under every frame, not matched to them | No; live depth with timestamps is future work                         |

Media that cannot pair a clip refuses its manifest with a `RangeError` that
says why, and so does a clip whose frame count differs from the video's
without `frames.times_s`.

Depth video draws the same frames on the default path and on the web video
engine. What differs is how the video gets there:

- On the default path the video and the depth preview both decode in the
  page. On the engine the video decodes in the engine's worker.
- The default path keeps no decoded video frames, so a drag waits for a
  decode of the picture and of its preview at each stop.
- Opening a clip on the default path waits for the packet table to be read.
  For an MP4 with its index up front that is one small read; a fragmented MP4,
  or a WebM without cues, reads every fragment's header first.
- Frame stepping on the default path moves by the video's own timestamps, and
  `session.frameClock` stays `null` there.

## Depth during playback

A clip's `preview` is decoded beside the video, by one WebCodecs decoder in
the page, ahead of the playhead; each decoded frame's codes are copied out in
the session's render-preparation worker. Every presented video frame is drawn
with the preview frame of the same index, its texture uploaded before the
frame is presented. A frame whose preview has not been decoded
yet draws no depth rather than another frame's. When the session's playback
gate is on (the default), playback waits for the preview the way it waits for
masks: it holds while the decoded lead in front of the playhead is short and
resumes once it has caught up, and `maxWaitSeconds` bounds every wait. The
picture never waits for depth to open: a manifest loads after the first frame
is up, and until it has, the media plays without depth. Once it is open, a
preview frame still downloading or decoding holds playback like a mask still
cooking. Exact frames hold playback only while they are what plays (see
[Exact depth while playing](#exact-depth-while-playing)).

How far ahead the preview decodes follows how the playhead moves, read the way
the mask window reads it:

- Playing, it leads by `previewPrefetchSeconds`, stretched by how many frames
  each present moves above 1x. When every present moves the same number of
  frames (a 30 fps clip at 4x or 8x on a 60 Hz display), only the frames
  presents land on are copied out. On a looping clip the lead wraps, so the
  first frames are decoded before playback gets back to them.
- Dragged, it spends the same span both ways, three quarters of it the way the
  hand is heading, as the web video engine's own scrub window does. Dragged
  backwards, each run from a key frame keeps every frame up to the playhead,
  so a backward drag decodes each group of pictures once instead of once per
  move. Decoding follows the positions the hand asks for rather than the
  frames that land behind it. A jump far back waits for its group of pictures,
  and with the gate on, a decoder that cannot keep up shows as a picture
  trailing the hand.
- At rest it keeps a small margin, as the mask window does: one schedule
  batch past the frame on screen (`maskFrame.scheduleBatchSize`, so three
  frames on a renderer and seventeen in a session). A step backwards fills
  behind. A step at rest waits only for its own frame, and an exact frame
  already loaded is enough. Starting playback from rest at 4x or faster waits
  for the lead the gate asks for, since this margin is shorter than it.

While the page is hidden the preview decodes nothing and no exact frame is
loaded; both pick up from the playhead when the page shows again.

`renderPreparation.onDiagnostics` reports depth beside masks and polygons, in
one report: the preview window as a `depthFrame` artifact (frames held, the
lead in seconds, the hold in force and `gateHoldCount`) and the exact frames
as an `exactDepthFrame` artifact (frames kept and loading). A session's
activity text says "Waiting for depth" or "Catching depth up" when depth is
what holds playback. `renderer.getActiveDepth()` says which clip frame is
drawn and whether it is the preview or the exact map, and the frame timings
report depth's draw as `depthMs`.

When playback rests for 0.15 s, the exact PNG for the frame on screen is
fetched and replaces the preview, then its neighbours are fetched for
stepping, three in four the way the frame last moved. They load several at
once, nearest first, through a pool of decode workers sized the way the mask
workers are: `maskFrame.workerCount`, by default half the cores up to 4, with
`renderPreparation.mode` and `workerFactory` applying as they do for masks.
An exact frame that was already loaded for playback is there at once. A
preview value is within one preview step of the exact value, plus the video
codec's error; `readDepthAt` reports `precision: "preview"` and the `step`
for it.

`renderPreparation.depth` sets the budgets. By default a session keeps about
2.25 seconds of preview (twice the 1-second prefetch, plus a quarter second
behind the playhead) at the clip's resolution, at least 96 MiB and at most
512 MiB, the same span of exact frames for playback within the same bounds
(`maxExactPlaybackCacheBytes`), and 128 MiB of exact frames at rest, more for
clips too large to hold the frame at rest and its neighbours twice. A budget
under one frame still holds the frame on screen, so depth plays one decoded
frame at a time. The gate's `requiredAheadSeconds` caps the lead a stop waits
for, never how far depth decodes, as it does for masks:

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

A preview written in TV range (see [Writing the preview video](#writing-the-preview-video))
decodes exactly in Chrome, on its hardware decoder, and in Firefox. Safari
has not been measured. Once per page, before the first preview opens, the session still decodes a
small clip of every code through the browser's decoders, hardware first, and
keeps the first that returns the codes as written. Firefox hands decoded
frames over in RGB; the clip shows how it converted them, and the session
converts back, so every TV-range code arrives exact there too.

A full-range preview (`levels` `"full"`, or no `levels`) plays too, though
TV range is the one to write. Chrome's hardware decoder on macOS squeezes
full range into TV range (code 0 comes back as 16, 255 as 235), so for a
full-range preview the session asks Chrome for its software decoder.
Firefox's RGB conversion leaves 36 of its 256 codes one off, and the session
says so in the depth diagnostics `message` and in a console warning.

Some decoders hand frames back only once more input arrives or a flush asks
for them. The session flushes a decoder that sits on every frame it was
given, at the next key frame, so no frame is lost. Every wait on a decoder
has a deadline (3 s for a support check or a flush that returns nothing, 5 s
for the probe's first frame) that runs only while the page is visible;
downloading the preview never does, since a slow link is no fault. Where no decoder returns a frame of the probe, the
preview is left off without being fetched, and a decoder that stops while
playing is closed: the clip then plays exact frames, as a clip without a
preview does, or with `playback: "preview"` draws depth only while playback
rests. It says why in the diagnostics `message` and once in the console.

### Exact depth while playing

`renderPreparation.depth.playback` picks which depth plays:

| `playback`         | While playing                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `"auto"` (default) | Exact frames while they keep up, the preview otherwise. A clip without a preview plays exact frames.                                            |
| `"exact"`          | Exact frames only. The playback gate holds for them as it does for the preview, so a link or a machine that cannot keep up slows playback down. |
| `"preview"`        | The preview only. A clip without a preview draws no depth while it plays.                                                                       |

Exact frames for playback load ahead of the playhead through the same worker
pool, with the preview's lead, budget and drag rules: above 1x only the frames
presents land on are loaded. In `"auto"` both the preview and the exact frames
load ahead, and exact depth takes over once its unbroken lead in front of the
playhead reaches three quarters of what it loads ahead. It hands back to the
preview when that lead falls under a quarter or the frame about to show is
missing, then waits 1 s before trying again, doubling to at most 16 s with
each hand-back; ten seconds of steady exact playback earn the short wait
back. Starting playback, resuming after a drag, or a seek starts over on the
preview without counting against exact depth, and a drag always draws the
preview. Either way the depth drawn is
the frame on screen's own, never a neighbour's, and `readDepthAt` and
`getActiveDepth()` say `precision: "exact"` when it is exact. Exact frames
that fail to load hand playback to the preview for good, or leave a clip
without a preview with depth only at rest; a console warning and the
diagnostics `message` say so.

The diagnostics add a second `depthFrame` artifact with `precision: "exact"`
for the frames loaded for playback.

How to choose: leave `"auto"` unless you know the link and the machine. Pick
`"exact"` when every value has to be exact, such as for measuring while the
clip plays, and a stall is acceptable; pick `"preview"` to spend nothing on
exact frames while playing, on a metered link or a busy page. The depth
benchmark's findings (`benchmark/depth/findings.md`) have what each choice
cost on the Spring clip, locally and on a capped link.

Exact frames shown in a box smaller than they are go up smaller. When the
host gives `renderPreparation.maskFrame.display`, which masks use for the
same, exact depth that the box cannot show at least twice
over, at its pixel ratio capped as for masks, is decimated by that whole
factor in the decode workers, and that copy is what goes to the GPU; readouts
still read the full map. A 4K map in a 1920-wide box at 1x uploads 4 MiB a
frame instead of 16. The preview is not
decimated, so encode it at the size it is shown: it may be smaller than the
exact frames as long as it keeps their aspect ratio.

Hiding annotations with `presentation.visibility.annotationsHidden` hides
depth too: nothing draws, playback stops waiting for depth and nothing decodes
ahead, as when no `depth` renderer is set, and showing annotations again draws
it from what is already decoded. `hiddenClasses` and `hiddenDetectionIds` do
not touch depth, which belongs to no class or detection.

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
`fxPx * baselineM / (disparity + doffsPx)`. Where `disparity + doffsPx` is not
positive there are no metres: the readout has no `depthM`, and
`quantity: "depth"` paints the pixel as one without depth.
`computeDepthPercentileRange(map)` returns the range `"auto"` would use for
that map; pass it back as `range: { min, max }` to keep colours still while
the view changes.

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
`preview` video. Its `levels` is `"tv"` (codes 16 to 235) or `"full"` (0 to
255, the default when `levels` is missing). Preview code `c` above the
reserved codes `T` stands for `lo + (c - T - 1) / (top - T - 1) * (hi - lo)`
of its `range_px`, where `top` is 235 in TV range and 255 in full range; a
code above `top` reads as `hi`. In TV range `T` is at least 16, the code
written for no depth.

### Writing the preview video

The preview is H.264 with the codes in luma: one frame per depth frame, at the
video's frame times, `yuv420p` with every chroma sample 128, in TV (limited)
range. TV range is what every browser's hardware decoder returns as written.
Monochrome (`gray`, High 4:0:0) streams do not decode reliably in browsers.

Write no depth as 16 and reserve the codes above it as a guard band, so the
codec's error around holes stays no depth: with `"reserved_max": 31`, depth
runs from 32 (`range_px[0]`) to 235 (`range_px[1]`), 203 steps apart:

```text
code = 16                                                   no depth
code = clamp(32 + round((d - lo) / (hi - lo) * 203), 32, 235)   depth d
```

From raw `yuv420p` frames whose luma holds the codes, flag the range on the
input, so ffmpeg does not convert it, and on the stream:

```sh
TV="-color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709"
ffmpeg -f rawvideo -pix_fmt yuv420p $TV -s 1280x720 -r 24 -i preview.yuv \
  -c:v libx264 -crf 12 -tune psnr -g 24 -keyint_min 24 -sc_threshold 0 $TV \
  -bsf:v h264_metadata=video_full_range_flag=0 -movflags +faststart preview.mp4
```

and describe it in `depth.json`:

```json
"preview": {
  "file": "preview.mp4",
  "levels": "tv",
  "reserved_max": 31,
  "range_px": [1.562, 37.25]
}
```

Pick `range_px` from the depth the clip actually has, not from 0 to its
largest value, so outliers do not stretch every step: the Spring previews
span the 0.1st to 99.9th percentile of each layer's valid disparity, which
keeps the matcher's outliers up to 63 px out and one step at 0.18 px. Depth
outside the range clamps to its ends in the preview only. At CRF 12, 98.5 %
of decoded codes come back within one of the code written and 99.9 % within
three; CRF 18 makes files half to two thirds that size but leaves blocks you
can see while the clip plays.

On the Spring clip at CRF 18, a 16-code guard lets 0.04 % of hole pixels
read as depth, and a guard of 8 lets 0.16 % through. Each code of guard
costs one step of depth precision.

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

- On WebGL a map whose width is odd goes up with one padding texel per row,
  padded by the worker while it decodes a manifest's PNG; WebGPU uploads the
  samples as they are.
- A map wider or taller than the GPU's largest texture (asked of the backend
  once; commonly 16384 on WebGL and 8192 on WebGPU) is drawn from a
  nearest-decimated copy that fits. Readouts still read every sample.
- React Native reports the depth renderer as unsupported.
