---
title: Media Sessions
group: Guides
summary: The primary session API for one renderer-owned media item.
---

# Media Sessions

`MediaSession` is the primary library primitive. One media item maps to one
session.

A session gives host applications a small surface:

```ts
const session = await createMediaSession({ container, media });

await session.play();
session.pause();
await session.seek(12.5);
await session.stepForward();
session.setPlaybackRate(0.5);
session.setPresentation({
  renderers: [
    annotationRenderers.mask({ style: maskStyle }),
    annotationRenderers.box({ style: boxStyle }),
    annotationRenderers.label({ style: labelStyle }),
  ],
});
const state = session.getState();
session.destroy();
```

The host should not need to know how Pixi containers, mask textures, worker
queues, or detection chunks are wired internally.

What the host does need to know is where the browser stops: which codecs open,
what a browser without WebGPU costs per frame, that no session plays audio, and
the frame-count ceiling on a source. [Browser Support](./browser-support.md)
covers all four.

## Good Defaults

The default path is intentionally boring:

- media is opened through the default browser media adapter;
- visual composition is owned by the renderer;
- detections are optional;
- render preparation uses the built-in worker strategy when available;
- state is available through `getState()` and `subscribe()`;
- playback waits for annotations, so a frame and the marks that belong to it
  reach the screen together rather than the picture filling in afterwards;
- advanced buffering, retention, interaction, and diagnostics are opt-in.

Both gates are on by default. Pass `playbackGate: false` when starting quickly
matters more than annotations.
It turns off both the detection-coverage and the render-preparation gates; left
on, the session reports a buffering activity while it waits. The detection gate
applies to a session with appendable detections, and `playbackGate: true` turns
it on for any session. Both gates hold every frame. A source the renderer pulls
samples from waits between decoding and drawing. A source that presents its own
frames, which is what `openWebVideoEngineMediaSource` returns, is stopped when
detection coverage or prepared artifacts are missing and started again when the
wait settles.

Video files are opened through `createWebVideoEngineMediaRendererSource`, which
decodes, seeks and presents frames itself and reports the media time of the
frame it put on screen. Passing a URL or a `Blob` directly keeps the renderer
pulling samples instead.

## Reading The Resolved Defaults

`resolveMediaSessionDefaults()` reports the detection-buffer and
render-preparation configuration a session built from a given set of options
will actually run on:

```ts
import { MediaSessionMode, resolveMediaSessionDefaults } from "supervision";

const defaults = resolveMediaSessionDefaults({
  detections: { sync: { frameRate: 24 } },
  mode: MediaSessionMode.File,
});

defaults.detectionBuffer.bufferAheadSeconds;
defaults.renderPreparation.maskFrame?.prefetchFrameCount;
```

`createMediaSession()` resolves its own options through the same function, so a
host that surfaces these numbers is showing the ones the session uses rather
than a copy that can drift. Frame counts follow the detection frame rate, so
they answer differently for a 24Hz source than for a 30Hz one.

## Minimal Start

For a plain browser app, the smallest useful session is:

```ts
const session = await createMediaSession({
  container: document.querySelector("#viewer")!,
  media: fileOrUrl,
});
```

That creates one renderer-owned composition for the media. Pixi draws the media
frame and prediction layers in the same scene, so app code does not coordinate a
DOM media element with a separate overlay.

The container must already be attached and have a non-zero size. The renderer
appends its own canvas and tracks container resizing. In SSR applications,
create the session only on the client after mount.

## State

Session state reports whether the media is loading, ready, playing, paused,
buffering, processing, destroyed, or errored.

It also includes activity details such as media normalization, detection loading,
playback buffering, and render artifact preparation. Apps can use this to show
loading UI without wiring every internal subsystem manually.

`activities` are the host-facing loading contract. They distinguish opening
media, media normalization, playback buffering, detection loading and
buffering, render-artifact preparation, and errors, so apps can choose a compact
status chip, a media overlay, or a debug panel without reading lower-level
renderer internals.

For common UI decisions, use the aggregate flags first:

```ts
session.subscribe((state) => {
  controls.play.disabled = state.playbackBlocked;
  overlay.hidden = !state.presentationBlocked;
});
```

Use `activities` when the app needs to explain why playback or presentation is
blocked.

### Seeking

A seek moves the playhead at once and the picture follows when the frame
decodes. `playbackState` keeps reporting whatever playback settled on before the
seek, so it cannot stand in for that gap; read `seeking` on the renderer state
instead:

```ts
session.subscribe((state) => {
  spinner.hidden = !state.renderer?.seeking;
});
```

Every tick of a scrub sets it, so an app that draws it owes the viewer a delay
before it appears, or a drag will strobe.

## Streaming Detections

Use `detections.appendable` when predictions arrive over time:

```ts
const session = await createMediaSession({
  container,
  media,
  detections: {
    appendable: {
      datasetId: "camera-1",
    },
  },
});

await session.appendDetectionFrames(frames);
```

This keeps the public API focused on app-level behavior while the library owns
storage, buffering, and rendering mechanics.

Appended frames are validated as semantic detection data. Styling and prepared
render artifacts are not ingested here; the renderer derives those from the
current presentation and hot detection window.

Detection input has three preferred shapes:

- `frames` for static detections known at session creation;
- `source` for caller-owned range loading;
- `appendable` for streaming inference results written over time.

Use only one of those shapes per session.

## Live Browser MediaStreams

Use `createMediaStreamRendererSource()` when a host already receives live media
from `getUserMedia()`, WebRTC, or another browser `MediaStream` producer:

```ts
import {
  createMediaSession,
  createMediaStreamRendererSource,
  DetectionFrameRetentionMode,
  MediaSessionMode,
} from "supervision";

const mediaStream = await navigator.mediaDevices.getUserMedia({ video: true });
const media = createMediaStreamRendererSource(mediaStream, {
  maxBufferedFrames: 8,
  timestampOrigin: "first-frame",
});

const session = await createMediaSession({
  container,
  media,
  mode: MediaSessionMode.Stream,
  detections: {
    appendable: {
      datasetId: "camera-1",
      retention: {
        mode: DetectionFrameRetentionMode.MemoryOnly,
        windowSeconds: 60,
      },
    },
  },
  renderer: {
    autoPlay: true,
    loop: false,
  },
});
```

The adapter uses an internal video element as a browser decode clock, snapshots
presented frames into a bounded queue, and gives the renderer each frame's media
presentation timestamp. Pixi remains the only visible composition surface, so
media and detections share one rendering clock.

By default, timestamps preserve the browser's MediaStream clock. Use
`timestampOrigin: "first-frame"` when detections arrive over a separate channel
whose PTS values are also rebased to their first result. Both timelines then
start at zero while preserving the real gaps between later frames.

The host owns the supplied `MediaStream` and its transport lifecycle by default.
Destroying the session releases snapshots and the internal decoder but does not
stop the stream tracks. Set `stopTracksOnDispose: true` only when the session
should own those tracks. A live source cannot seek or loop; ending every video
track ends playback.

## Renderer Quality

By default the renderer rasterizes at the display's pixel ratio up to a ceiling
of 2. Apps that need to reduce GPU memory or fill-rate pressure can lower it:

```ts
const session = await createMediaSession({
  container,
  media,
  renderer: {
    maxDevicePixelRatio: 1.5,
  },
});
```

Lower values trade some sharpness for smoother playback on constrained devices
or busy browsers. Leaving the option unset takes the ceiling of 2, which is what
keeps the picture, the masks drawn onto it, and the decode under both on one
pixel grid; a mask raster carries one detection per pixel and can only be
sampled nearest, so a grid it does not share shows as stair-stepped edges. Pass
`window.devicePixelRatio` to rasterize at the display's full ratio.

Quality can also change at runtime without rebuilding the media session:

```ts
session.setRenderQuality({
  maxDevicePixelRatio: 2,
});
```

The session keeps playback time, prepared detections, interaction state, and
media buffers alive while the renderer resizes to the new resolution.

## Multiple Detection Sources

Use `detections.sources` when an app needs to render more than one semantic
detection stream over the same media. The library does not assign product
meaning to those streams; it only composes them in order and tags copied
detections with `sourceId` and `sourceDetectionIndex`.

```ts
const session = await createMediaSession({
  container,
  media,
  detections: {
    sources: [
      {
        frames: modelFrames,
        id: "model",
      },
      {
        appendable: { datasetId: "transient-drawing" },
        id: "drawing",
        order: 10,
        presentation: {
          boxStyle: drawingBoxStyle,
          maskStyle: null,
        },
      },
    ],
  },
});

await session.appendDetectionFrames(drawingFrames, { sourceId: "drawing" });
```

Source order is ascending by `order`, then declaration order. Later detections
render on top. Source-level presentation can override `boxStyle`, `maskStyle`,
`polygonStyle`, `polylineStyle`, `keypointStyle`, and `labelStyle`; `undefined`
falls back to the global presentation and `null` disables that layer for the
source.

Do not combine `detections.sources` with legacy single-source inputs such as
`frames`, `source`, or `appendable`.

For a fuller “model predictions plus draft annotations” walkthrough, see
[Multiple Detection Sources](../recipes/multiple-detection-sources.md).

## Runtime Updates

After creation, the same session remains the consumer API:

```ts
await session.appendDetectionFrames(frames);
await session.seek(4.2);
await session.stepForward();
await session.stepBackward();
session.setPlaybackRate(1.5);

session.setPresentation({
  renderers: [
    annotationRenderers.box({ style: boxStyle }),
    annotationRenderers.mask({ style: maskStyle }),
    annotationRenderers.label({ style: labelStyle }),
  ],
});

session.destroy();
```

For an editor backed by a caller-owned `DetectionFrameSource`, update that
source and call `session.refresh()`. The session re-reads semantic data and
re-presents its retained media sample; the app must not decode the frame again,
copy pixels into a canvas, or fake a seek to trigger a redraw.

Video times are absolute presentation timestamps. `renderer.onFrame` reports
the canonical `mediaTime`, `frameDuration`, `firstTimestamp`, and decoded media
dimensions after each newly presented sample. Use those values for timeline
and frame-key UI rather than maintaining a second decoder clock in the app.

This is the intended integration shape for apps: create one session per media
item, feed it detections as they become available, navigate through the session,
update presentation styles without rewriting detections, and destroy the
session when the media item leaves the UI.

Framework users should follow the same ownership rule. See
[React Integration](../recipes/react-integration.md) for an async-safe effect
cleanup pattern.
