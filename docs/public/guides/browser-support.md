---
title: Browser Support
group: Guides
summary: What the browser video path does not do, which browsers it costs, and how each limit surfaces to an application.
---

# Browser Support

Four things this release does not do. Each is a limit of the browser path as
shipped, not a defect, and each surfaces the same way every time.

## Firefox Does Not Decode HEVC

Firefox refuses every HEVC profile. Firefox 154 plays an HEVC file in its own
`<video>` element while its `VideoDecoder` reports both `hvc1` and `hev1`
configurations unsupported, so the same file that plays in the browser fails to
open here.

The failure is at load, not at a frame. Opening the source asks the browser
whether it can decode the track, and a refusal raises `DecodeUnsupported` with
the codec string in the message before any frame is presented. An application
that accepts arbitrary uploads should handle that error and offer H.264 or VP9
instead.

This is that decoder rather than a rule about non-Chromium browsers. Safari 18.6
reports `hvc1` and `hev1` supported alongside `avc1`, `vp8`, `vp09` and `av01`,
and plays the same file.

There is no software decoder in the package to fall back to. The engine decodes
through WebCodecs only, and nothing ships a WebAssembly build of an HEVC
decoder. A route exists in principle, because the demuxer accepts a registered
custom decoder, but the engine worker is a classic script spawned from a Blob
with its own copy of the demuxer bundled in, so a decoder an application
registers in the page is registered against a different copy and the worker
never sees it. Reaching it means changing how the worker is built, which is its
own piece of work and is not in this release.

## A Video Without WebGPU Pays A Staging Canvas Per Frame

Where WebGPU is available and its queue converts a decoded frame, the frame goes
straight into the texture the scene samples. Where it is not, every presented
frame is drawn into a media-sized 2D canvas and that whole canvas is uploaded
into the sprite's texture.

Two browsers take the second path today, for different reasons:

- **Safari** exposes no WebGPU at all, in the page or in a worker, so the scene
  finds no device to ask.
- **Firefox** exposes WebGPU whose queue takes only `ImageBitmap`,
  `HTMLImageElement`, `HTMLCanvasElement` and `OffscreenCanvas`, and rejects a
  decoded frame. The scene asks once when it is built and routes the frames
  through the staging canvas rather than letting each present fail.

The cost is real. On the demo's default clip in Safari the staging route runs
once per presented frame at 24.8 ms, about seven tenths of the wall clock during
playback. The same frames uploaded straight into a WebGL texture in the same
browser take 0.6 ms. It is not the pixels: part of the gap is per-pixel work,
and part is that the staging surface is media-sized whatever the decode
delivers, so a decode below media size is drawn back up before it is uploaded.

Nothing is lost, and no application has to opt in or out. What it costs is
headroom, so a heavy annotation load on a large clip has less of it in these
browsers than in Chrome.

## There Is No Audio

Nothing in the package decodes or plays audio, on any source. The engine walks
video tracks only, and normalization discards audio by default
(`audio.discard`).

`MediaSessionRendererOptions.muted` is deprecated because nothing reads it. It
is still accepted, and setting it changes nothing either way. Media that
carries an audio track still opens and plays; the track is ignored.

The media clock carries a documented seam for a future audio-bearing consumer
that needs sample-accurate sync. Nothing is wired to it in this release.

## A Source Is Capped At One Million Frames

Opening a source walks its packets metadata-only to build the table that gives
every frame an identity, and that walk is eager: it finishes before the first
frame is presented. Past one million frames the load fails with
`DecodeUnsupported` rather than playing without frame identity.

At 30 fps the cap is about nine hours of video, so an ordinary file never
reaches it. What reaches it is an endless stream or a heavily fragmented
container. For scale, a 70-second 30 fps source walks 2113 packets in a measured
5.7 ms.

An application that needs to render sources longer than the cap needs a
different frame-addressing scheme than the one this release provides.
