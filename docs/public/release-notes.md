---
title: Release Notes
summary: What the 0.2.0 browser release lets an application do, what changed underneath, and what it still cannot do.
---

# Release Notes

## 0.2.0

The browser package `supervision` is at `0.2.0`. This release replaces the
video path.

### Play A Video And Land On The Frame You Asked For

Video files now open through the Roboflow video engine, a WebCodecs decoder
that runs off the main thread and addresses frames by identity rather than by
timestamp.

```ts
import {
  createMediaSession,
  createVideoEngineMediaRendererSource,
} from "supervision";
import { SourceKind } from "supervision-js-web-video-engine";

const session = await createMediaSession({
  container,
  media: createVideoEngineMediaRendererSource({
    source: { blob: file, kind: SourceKind.Blob },
  }),
});
```

The engine owns the playhead and presents frames to the session, rather than
the session pulling samples out of a decoder on a ticker. What that buys an
application is exactness: a step moves one real source frame in presentation
order, a committed seek resolves once the producer has landed on the frame
that was named, and a scrub in flight is latest-wins so a drag does not queue
up seeks it will not use. See
[Media Preparation](./guides/media-preparation.md) for the source options and
[Media Sessions](./guides/media-sessions.md) for how a session consumes them.

### A Preview Opens Annotated

A session now holds the picture until the frame it is about to show has both
its detections and the prepared artifacts that draw them. A viewer comparing
predictions sees a frame and the marks that belong to it together, instead of
a picture that fills in a moment later.

This is on by default and `playbackGate: false` turns it off for a host that
cares about cadence more than overlays. It is a behavior change for an
existing application; [Breaking Changes](./breaking-changes.md) describes what
it holds and for how long.

`PlaybackGateReach` reports which wait a session actually did: no gate, a
wait at the start of playback only, or a wait at every frame.

### Annotations Survive Fast Playback

Readiness is now two facts about a frame rather than one about the session.
`PreparedAnnotationWindowSnapshot` reports which detection frame a media time
draws, and separately which enabled layers hold a prepared artifact for it. A
layer still owing its artifact skips its own draw while the layers with
nothing to cook draw that frame anyway, which is what keeps boxes and labels
on screen above 1x, where mask cooking cannot match the demand.

### A Host Can Present Its Own Frames

`PresentedFrameSource` and `PresentedFrameChannel` are the contract the video
engine speaks, and they are public. An application that already decodes or
composites video can hand the session a source that owns its own playhead and
presents frames to it, and get the same annotation timing the engine gets.

### A Session Says What It Will Run On

`resolveMediaSessionDefaults` returns the detection-buffer and
render-preparation configuration a session created with a given set of options
will actually use, so a host can read, show, or log those numbers without
restating the defaults itself.

```ts
import { resolveMediaSessionDefaults } from "supervision";

const defaults = resolveMediaSessionDefaults({ mode, detections });
```

### The Engine Installs Separately

The video engine ships as `supervision-js-web-video-engine` at `0.1.0`, versioned
independently. `supervision` declares it as an optional peer and loads it
through a dynamic import, so installing `supervision` does not install it:

```sh
npm install supervision-js-web-video-engine
```

The engine also stands alone. Nothing in it depends on `supervision`, so an
application that wants frame-accurate decoding, scrubbing, or offline frame
extraction without the annotation stack can use it on its own.

## What Changed Underneath

- **Presentation is push, not pull.** The producer presents a frame and the
  renderer draws it. Every render answers something that changed: a presented
  frame, the prepared window advancing, a layer toggled, restyling, hover or
  selection, a viewport move, a resize. A paused, untouched scene issues zero
  renders, and that is asserted rather than assumed.
- **Frame identity comes from a table built at load.** Opening a source walks
  its packets metadata-only and records each timestamp in the container's own
  integer grain, sorted into presentation order. That table is what lets a
  seek name a frame instead of a time.
- **Masks are cooked at the size they are shown**, cached without a compress
  and decompress on every frame, and downscaled on the GPU rather than the
  main thread.
- **A rebuilt detection window stops copying the frames it already holds**,
  and a file session rebuilds it less often, because a file's detections do
  not change underneath it.

## Known Limits

These are the things this release does not do. None of them is a bug to be
reported.

- **There is no audio path.** The engine decodes video only, a session reports
  zero audio tracks, and `MediaSessionRendererOptions.muted` is deprecated
  because nothing reads it. The clock carries a documented seam for an
  audio-bearing consumer and nothing is wired to it.
- **Firefox will not decode HEVC.** Firefox 154 plays an HEVC file in its own
  media element while its `VideoDecoder` reports both `hvc1` and `hev1`
  configurations unsupported, so an HEVC source fails at load with
  `DECODE_UNSUPPORTED` rather than at a frame. This is that decoder and not a
  rule about non-Chromium browsers: Safari 18.6 reports `hvc1` and `hev1`
  supported alongside `avc1`, `vp8`, `vp09`, and `av01`, and plays the same
  file.
- **Safari pays a staging canvas per presented frame.** It exposes no WebGPU
  in the page or in a worker, so every present draws the decoded frame into a
  media-sized 2D canvas and uploads that whole canvas into the sprite's
  texture. On the demo's default clip that is 24.8 ms per presented frame and
  about seven tenths of the wall clock during playback. The same frames
  uploaded straight into a WebGL texture in the same browser take 0.6 ms.
- **A source is capped at one million frames.** The metadata walk that builds
  the frame table is eager, so an endless or heavily fragmented source is
  refused at load rather than being played without frame identity. At 30 fps
  the cap is about nine hours of video.

## Upgrading

[Breaking Changes](./breaking-changes.md) lists every removal and behavior
change, and how it was derived.
