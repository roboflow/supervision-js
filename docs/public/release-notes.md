---
title: Release Notes
summary: What the 0.2.0 browser release lets an application do, what changed underneath, and what it still cannot do.
---

# Release Notes

## 0.2.0

The browser package `supervision` is at `0.2.0-next.0`, a prerelease on the `next`
tag. This release replaces the
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

### The Engine Ships Inside `supervision`

The video engine is a subpath of the one published package rather than a package
of its own, so nothing extra has to be installed to open a video source:

```ts
import { createVideoEngineMediaRendererSource } from "supervision/web-video-engine";
```

`supervision` reaches it through a dynamic import, so an application that only
annotates images never downloads the engine or its decode worker.

### Files Whose Groups Do Not Start With A Keyframe Now Play

Most encoders emit open GOPs by default. In such a file, some of the entry
points the container advertises cannot legally be decoded from, because the
picture after them refers back to pictures a fresh decoder never had. Opening at
one produced a black player that still reported it was playing.

An entry point is now resolved rather than assumed. When a decoder rejects the
container's, the engine resolves it again from the bitstream, lands on the
enclosing keyframe, and walks forward to the frame that was asked for. A failed
entry point condemns itself rather than the session, and a decode failure the
runtime has given up on is terminal, so nothing afterwards reports the source as
healthy. A file whose entry points are all usable decodes with no extra probing.

### A Video Recorded In Portrait Plays The Right Way Up

Any clip carrying rotation metadata played wrong, which is every portrait
recording from a phone. At 90 and 270 degrees the reported size was portrait
while the landscape picture was painted into it unturned, so the orientation and
the aspect were both wrong. At 180 the size was right and the picture was upside
down. Clips with no rotation metadata were always correct.

Two places dropped the turn. The decode session drew a decoded frame without
applying it, and a frame converted back for the GPU loses it on every path,
including the demuxer's own, because turning the pixels there would cost a copy
per frame. The turn now reaches the session's draw, and it travels with the
frame for the renderers to apply, so a rotated clip paints the same on both and
an unrotated one pays nothing.

A frame handed to a host presenting its own frames carries its rotation, so a
host compositing for itself is not given pixels that contradict the dimensions
beside them.

### Stepping Moves One Frame On A Variable-Rate Clip

On a clip whose frames are not evenly spaced, a step forward sometimes did not
move the picture and the next one moved it by two, seeks landed up to two frames
past the frame asked for, and the reported frame count counted packets rather
than frames the clip presents.

The frame table recorded one entry per packet, and such files carry several
packets sharing a presentation timestamp with no time between them, so two
entries named an instant that can only ever produce one picture. Entries naming
the same instant now collapse when the table is built. A clip with no coincident
timestamps is unchanged, down to the same allocations.

### A Looping Clip Opens Its Next Lap On The First Frame

On a heavy clip the lap after a loop started a few frames in, and those frames
were decoded and discarded before anything reached the screen. Playback starts
its clock before the walk reopens at the loop point, so the replay's opening
frames arrive behind it and the rule that discards frames the clock has outrun
dropped them. That rule now waits until the session has painted once, since
before that there is no picture for the clock to have outrun.

### A Seek Made Before The First Frame Lands Where It Was Aimed

Seeking as the very first thing a session does was accepted and then silently
reverted to the start. A pending seek records the frame it aimed at, so a frame
decoded for something else is not mistaken for its answer.

### Composed Detections Keep Their Own Frame

A session composing detections from more than one source rebuilt each slot's
media time from a nominal frame rate, which put the marks on the neighbouring
frame for any clip not running at exactly that rate. Sources are paired by the
frame index both sides already carry, so a clip's real rate cannot walk the
pairing off.

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
reported. [Browser Support](./guides/browser-support.md) carries the same four
with the detail an integration needs.

- **Firefox will not decode HEVC.** Firefox 154 plays an HEVC file in its own
  media element while its `VideoDecoder` reports both `hvc1` and `hev1`
  configurations unsupported, so an HEVC source fails at load with
  `DECODE_UNSUPPORTED` rather than at a frame. This is that decoder and not a
  rule about non-Chromium browsers: Safari 18.6 reports `hvc1` and `hev1`
  supported alongside `avc1`, `vp8`, `vp09`, and `av01`, and plays the same
  file. Nothing in the package decodes HEVC in software, and Firefox is not
  fixed by anything in this release. The demuxer would accept a registered
  custom decoder, but the engine worker is a classic script spawned from a
  Blob with its own copy of the demuxer bundled in, so a decoder registered in
  the page is registered against a different copy. Reaching it means changing
  how the worker is built.
- **A scene without usable WebGPU pays a staging canvas per presented frame.**
  This is the generic fallback, not a Safari path: the scene takes it whenever
  there is no WebGPU device, or the device's queue refuses a decoded frame.
  Every present then draws the frame into a media-sized 2D canvas and uploads
  that whole canvas into the sprite's texture. Safari exposes no WebGPU in the
  page or in a worker and takes it for the first reason; Firefox's queue
  accepts only `ImageBitmap`, `HTMLImageElement`, `HTMLCanvasElement` and
  `OffscreenCanvas`, and takes it for the second. Measured in Safari on the
  demo's default clip, that is 24.8 ms per presented frame and about seven
  tenths of the wall clock during playback. The same frames uploaded straight
  into a WebGL texture in the same browser take 0.6 ms.
- **There is no audio path.** Nothing decodes or plays audio on any source,
  normalization discards audio by default, and
  `MediaSessionRendererOptions.muted` is deprecated because nothing reads it.
  Media carrying an audio track still opens and plays with the track ignored.
  The clock carries a documented seam for an audio-bearing consumer and
  nothing is wired to it.
- **A source is capped at one million frames.** The metadata walk that builds
  the frame table is eager, so an endless or heavily fragmented source is
  refused at load rather than being played without frame identity. At 30 fps
  the cap is about nine hours of video.

## Upgrading

[Breaking Changes](./breaking-changes.md) lists every removal and behavior
change, and how it was derived.
