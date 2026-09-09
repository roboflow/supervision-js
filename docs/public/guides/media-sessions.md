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
- playback gates can wait for annotations before advancing, so a playing frame
  and the marks that belong to it reach the screen together;
- advanced buffering, retention, interaction, and diagnostics are opt-in.

Opening a session does not wait for annotations that will arrive later. The
factory returns after the media is ready to show, so its initial poster/frame
can be bare even when autoplay is waiting behind a gate. That makes it safe to
mount controls and begin an inference stream immediately; the gate still
protects subsequent playback while required annotations are unavailable.

The render-preparation gate is on by default. The detection-coverage gate is on
by default for appendable detections and off for other detection inputs unless
explicitly enabled. Pass `playbackGate: false` when advancing quickly matters
more than annotations. It turns off both gates; while either enabled gate waits,
the session reports a buffering activity. A source the renderer pulls samples
from waits between decoding and drawing. A source that presents its own frames,
which is what `openWebVideoEngineMediaSource` returns, is stopped when detection
coverage or prepared artifacts are missing and started again when the wait
settles.

For indexed file playback, explicitly create a
`createWebVideoEngineMediaRendererSource`. It decodes and seeks frames, then
hands each selected frame and its media time to the renderer. The renderer
composites matching annotations and acknowledges the frame once displayed.
Passing a URL or a `Blob` directly keeps the renderer pulling samples instead.

The default finite-media pull path can overlap decoders when playback, seeking,
or stepping hands off between sample reads. The indexed web video engine owns a
separate single-playback-decoder lifecycle.

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

Destroy the session when that mounted viewer goes away. It removes the
renderer-owned canvas and releases its media resources without removing other
children of the container:

```ts
import { createMediaSession } from "supervision";

const session = await createMediaSession({ container, media: fileOrUrl });

function unmountViewer() {
  session.destroy();
}
```

## State

Session state reports whether the media is loading, ready, playing, paused,
buffering, processing, destroyed, or errored.

During opening, the state passed to `onState` has `status: "loading"` and a
null `renderer`; the session controller does not exist until the creation
promise resolves. If opening fails, the promise rejects and `onState` receives
the terminal error state. An opening promise has no cancellation method. A host
that unmounts or swaps media while it is pending should mark that request
disposed, then destroy the session immediately if it later resolves. The
[React Integration](../recipes/react-integration.md) recipe shows that cleanup
pattern.

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

Frame presentation requires a visible document. When the document is hidden,
presentation-wait budgets pause and resume when it becomes visible. The decoder
watchdog is separate; its deadlines do not pause with presentation waits.

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

Use `presentedTime` for the timestamp of the pixels on screen. `currentTime`
can already name a newer playhead position while those pixels are still being
fetched or decoded:

```ts
const displayedTime =
  document.querySelector<HTMLOutputElement>("#displayed-time")!;
const seekIndicator = document.querySelector<HTMLElement>("#seeking")!;
const scrubIndicator = document.querySelector<HTMLElement>("#scrubbing")!;
const sourceReadIndicator =
  document.querySelector<HTMLElement>("#source-reading")!;
const incompleteAnnotations = document.querySelector<HTMLElement>(
  "#incomplete-annotations",
)!;

session.subscribe((state) => {
  const renderer = state.renderer;

  displayedTime.value =
    renderer?.presentedTime === null || renderer?.presentedTime === undefined
      ? "No frame"
      : `${renderer.presentedTime.toFixed(3)} s`;
  seekIndicator.hidden =
    renderer?.seeking !== true || renderer.scrubbing === true;
  scrubIndicator.hidden = renderer?.scrubbing !== true;
  sourceReadIndicator.hidden = renderer?.source.awaitingRead !== true;
  incompleteAnnotations.hidden =
    renderer?.renderPreparationGateAbandoned !== true;
});
```

`scrubbing` means the viewer is still leading the playhead with a gesture;
`seeking` means a requested position has not reached the screen yet.
`source.awaitingRead` is true only while a required source read is pending.
It is source-wide, not a fetch/decode stage for an individual engine seek; see
[URL seek feedback and responsiveness](application-integration.md#url-seek-feedback-and-responsiveness).
`renderPreparationGateAbandoned` means its bounded wait expired and playback
continued without an unavailable prepared annotation.

## Streaming Detections

Choose one detection input per session:

| Input                   | Ownership and writes                                                                                      | Detection gate default                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `detections.frames`     | Static frames supplied at creation.                                                                       | Off unless explicitly enabled.                                           |
| `detections.source`     | Borrowed readable or writable source. Write through the session for automatic refresh.                    | Off unless explicitly enabled.                                           |
| `detections.appendable` | Session-owned writable source. Append through the session.                                                | On, with 2 s of required coverage and a 10 s wait bound.                 |
| `detections.sources`    | Several ordered entries; each can supply frames, a borrowed source, or a session-owned appendable source. | On when an entry is appendable; otherwise off unless explicitly enabled. |

The render-preparation gate is on for every session by default and has a 2 s
wait bound. Top-level `playbackGate: false` disables both gates; each gate's
own `enabled` value can override that choice.

`detections.source` and `detections.sources[].source` are borrowed, not
owned. The application remains responsible for their lifetime, including
calling `destroy()` when its source offers it. Sources created with
`appendable` are session-owned instead.

Use `detections.appendable` when predictions arrive over time and the session
should own the source:

```ts
import { createMediaSession } from "supervision";

const session = await createMediaSession({
  container,
  media,
  detections: {
    appendable: {
      datasetId: "camera-1",
    },
  },
});

await session.appendDetectionFrames([{ mediaTime: 0, detections: [] }]);
```

This keeps the public API focused on app-level behavior while the library owns
storage, buffering, and rendering mechanics.

### Start Streaming After Opening

An application can provide its own writable source before opening, then start
streaming as soon as the session is available. Write through the session so it
can update the displayed frame and any enabled playback gate:

```ts
import {
  createMediaSession,
  createMemoryColdDetectionFrameStore,
  createWritableDetectionFrameSource,
} from "supervision";

const source = createWritableDetectionFrameSource({
  datasetId: "camera-1",
  store: createMemoryColdDetectionFrameStore(),
});

const session = await createMediaSession({
  container,
  media,
  detections: { source },
});

async function consumePredictions() {
  for await (const frame of predictionFrames) {
    await session.appendLiveDetectionFrame(frame);
  }
  await session.finalizeDetectionCoverage();
}

void consumePredictions();
```

`autoRefresh` defaults to `true` and applies to writes made through the
session: it redraws when a write can change the displayed result. Set
`detections.autoRefresh: false` when the host will call `session.refresh()` at
the times it chooses. If the application mutates an external source directly,
it must call `session.refresh()` itself when that change should be visible.

When the viewer and external source have the same lifetime, dispose them in
that order after stopping the producer:

```ts
session.destroy();
source.destroy();
```

Appended frames are validated as semantic detection data. Styling and prepared
render artifacts are not ingested here; the renderer derives those from the
current presentation and hot detection window.

## Exact Frame Navigation

Indexed media sources expose exact presentation timing as `session.frameClock`
and `session.renderer.frameClock`. It is `null` when the source has no frame
index, so applications should keep their existing time-based controls as a
fallback. Its companion, `session.frameNavigation`, is available when that
indexed source can also present indexed moves; it is `null` otherwise.

Use a frame index when the product already knows the exact frame it wants. Use
a media time when the input is time-based: `moveToTime()` chooses the frame
covering that time, then resolves only once that exact frame is presented.

```ts
const clock = session.frameClock;
const navigation = session.frameNavigation;

if (clock && navigation) {
  const inspectionFrame = 240;
  await navigation.moveToFrame(inspectionFrame);

  const frameAtClick = clock.indexAtOrBefore(12.5);
  await navigation.moveToTime(clock.timeAt(frameAtClick));

  const presentedTime = session.getState().renderer?.presentedTime;
  if (presentedTime !== null && presentedTime !== undefined) {
    const currentFrame = clock.indexAtOrBefore(presentedTime);
    const nextFrame = Math.min(clock.frameCount - 1, currentFrame + 1);
    await navigation.moveToFrame(nextFrame);
  }
}
```

`frameCount`, `firstTimestamp`, `endTimestamp`, and `duration` describe the
presentation timeline. `timeAt(index)` and `durationAt(index)` use exact frame
boundaries, including variable frame rate and a final frame with a distinct
duration. `indexAtOrBefore(mediaTime)` finds the covering frame and clamps a
finite media time to the indexed ends. `duration` is the span from
`firstTimestamp` to `endTimestamp`; it is not necessarily the same value as
the final timestamp when a source begins at a nonzero media time.

`scrubToFrame()` and `scrubToTime()` are for a moving pointer. They return the
resolved target immediately and a `settled` promise. Scrubs are latest-wins: a
new scrub resolves the earlier promise with `{ status: "superseded" }`; it does
not reject it. On release, make one `moveToTime()` call for the final exact
landing. Call the scrub method for every pointer position; do not add a host
debounce because the navigation capability already supersedes older targets.
Sharing the final promise makes pointer-up and cancellation termination
idempotent. A final move can reject when a later operation supersedes it, so an
event handler should consume `AbortError` and report other failures. While the
gesture is active, display its returned target before falling back to
`presentedTime`; this keeps the timeline knob under the pointer while the
picture catches up:

```ts
let finishDrag: Promise<unknown> | null = null;
let scrubTargetTime: number | null = null;
let gesture = 0;

function reportNavigationError(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return;
  console.error(error);
}

function onTimelineMove(seconds: number) {
  const scrub = session.frameNavigation?.scrubToTime(seconds);
  scrubTargetTime = scrub?.target.mediaTime ?? seconds;
  void scrub?.settled.catch(reportNavigationError);
}

function finishTimelineDrag(seconds: number) {
  finishDrag ??=
    session.frameNavigation?.moveToTime(seconds) ?? Promise.resolve();
  return finishDrag;
}

function beginTimelineDrag() {
  gesture += 1;
  finishDrag = null;
  scrubTargetTime = null;
}

function timelineKnobTime() {
  return (
    scrubTargetTime ??
    session.getState().renderer?.presentedTime ??
    session.getState().renderer?.currentTime ??
    0
  );
}

async function onTimelinePointerUp(seconds: number) {
  const finishingGesture = gesture;
  const finishing = finishTimelineDrag(seconds);
  try {
    await finishing;
  } catch (error) {
    reportNavigationError(error);
  } finally {
    if (finishingGesture === gesture && finishing === finishDrag) {
      scrubTargetTime = null;
    }
  }
}

function onTimelinePointerCancel(seconds: number) {
  void onTimelinePointerUp(seconds);
}
```

For complete pointer, lost-capture, and keyboard event wiring with cleanup, see
[Timeline Scrubbing](../recipes/timeline-scrubbing.md).

## Web Video Engine Sources

Use the web video engine source when the application needs its indexed file
playback and frame navigation. It accepts a URL or an uploaded `Blob`; pass the
visible box and the same DPR ceiling used by the renderer so decoding matches
the pixels the viewer can show:

```ts
import {
  createMediaSession,
  createWebVideoEngineMediaRendererSource,
} from "supervision";
import { SourceKind } from "supervision/web-video-engine";

const maxDevicePixelRatio = 2;
const media = createWebVideoEngineMediaRendererSource({
  source: {
    kind: SourceKind.Url,
    url: "/media/inspection.mp4",
  },
  display: {
    boxWidth: container.clientWidth,
    boxHeight: container.clientHeight,
    devicePixelRatio: window.devicePixelRatio,
    maxDevicePixelRatio,
  },
});

const session = await createMediaSession({
  container,
  media,
  renderer: { maxDevicePixelRatio },
});
```

When the viewer's box changes, update this same display-box source through the
optional `session.setDisplay()` method. It changes the output for this session;
it does not require a new session or a new media source. Web video engine
sources expose this method, but resizing rejects unless the source uses a
display-box decode strategy, as configured with `display` above. Other media
sources may omit the method.

```ts
const resizeOutput = session.setDisplay;
let resizeObserver: ResizeObserver | undefined;

if (resizeOutput) {
  resizeObserver = new ResizeObserver(() => {
    const { height, width } = container.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;

    void resizeOutput({
      boxWidth: width,
      boxHeight: height,
      devicePixelRatio: window.devicePixelRatio,
      maxDevicePixelRatio,
    }).catch((error) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.error(error);
    });
  });
  resizeObserver.observe(container);
}

function unmountViewer() {
  resizeObserver?.disconnect();
  session.destroy();
}
```

Rapid box changes keep only the newest resize; a superseded call rejects with
`AbortError`. Repeating the current box resolves without a replacement frame.
When dimensions change, the call resolves after its resized frame is presented,
while the already-visible frame remains until that replacement arrives.

For an uploaded file, replace the `source` value with
`{ kind: SourceKind.Blob, blob: file }`. A `ReadableStream` is not accepted by
this renderer source; use the engine directly if the application must consume
one.

Handle open failures through the stable media error kind rather than matching
decoder text:

```ts
import {
  createMediaSession,
  getMediaErrorKind,
  MediaErrorKind,
} from "supervision";

try {
  await createMediaSession({ container, media });
} catch (error) {
  if (getMediaErrorKind(error) === MediaErrorKind.UnsupportedFormat) {
    showUnsupportedVideoMessage();
  } else {
    showMediaOpenError();
  }
}
```

`renderer.muted` is deprecated and has no effect. Sessions are video-only, so
do not use it to control application audio.

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

Video times are absolute presentation timestamps. For pull sources,
`renderer.onFrame` reports the canonical `mediaTime`, `frameDuration`,
`firstTimestamp`, and decoded media dimensions. Push-presented indexed sources
should use `session.frameClock`, `session.frameNavigation`, and
`state.renderer.presentedTime` instead.

This is the intended integration shape for apps: create one session per media
item, feed it detections as they become available, navigate through the session,
update presentation styles without rewriting detections, and destroy the
session when the media item leaves the UI.

Framework users should follow the same ownership rule. See
[React Integration](../recipes/react-integration.md) for an async-safe effect
cleanup pattern.
