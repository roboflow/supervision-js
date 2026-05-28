# Milestone 1 Pixi Media Proof

## What This Proves

This completed proof checks the smallest renderer-first claim: decoded video frames can be
presented inside a renderer-owned Pixi scene without a visible DOM media element.
Mediabunny owns media source reading, container parsing, and video-frame decode.
Pixi owns the visible composition surface: one canvas appended to the
caller-provided container, with decoded frames uploaded as a texture-backed
sprite.

This is not an annotation API and not a general renderer abstraction. It is only
enough code to prove media ownership, frame upload, sizing, playback lifecycle,
and basic source/timing/container diagnostics.

## Media And Composition Ownership

The proof does not create an `HTMLVideoElement`, and Pixi `VideoSource` is not
used. Mediabunny reads the URL through `Input` and `UrlSource`, selects the
primary video track, and retrieves decoded frames with `VideoSampleSink`.

Decoded samples are drawn into an internal staging canvas. That canvas is not a
visual composition surface and is never appended to the DOM; it only gives Pixi
a stable texture upload resource. The user should see one renderer-owned Pixi
canvas.

The first frame is read through a one-shot `VideoSampleSink.samples(...)`
iterator. Playback then uses `requestAnimationFrame` as a small proof-grade media
clock and asks `VideoSampleSink.getSample(...)` for the sample corresponding to
the current clock time. This is intentionally not the final playback or
synchronization model.

## Done Criteria

- The library exports one narrow experimental factory for creating the proof.
- The factory creates a PixiJS v8 application using WebGL preference.
- Mediabunny reads the media URL with a narrow video-oriented format list:
  `MP4`, `QTFF`, `WEBM`, and `MATROSKA`.
- A primary decoded video frame is drawn into an internal staging canvas and
  uploaded to a Pixi canvas texture.
- Playback advances by clock-driven Mediabunny sample retrieval, not browser
  video callbacks.
- The sprite resizes to fit the renderer canvas with `contain` or `cover`.
- The proof exposes small source probe and timing diagnostics and disposes the
  Mediabunny input during cleanup.
- The React demo consumes the package export, uses a local MP4 fixture to avoid
  remote CORS instability, and cleans up the proof on unmount.

## Known Limitations

- This is video-only; audio playback and audio/video synchronization are
  deferred.
- Codec support depends on browser WebCodecs support and Mediabunny support for
  the input format and codec.
- Unsupported containers, unsupported codecs, or unreadable sources should
  produce a clear proof error state rather than introducing fallback paths before
  we have measured need.
- The playback loop is intentionally simple: a browser clock computes media
  time, then `VideoSampleSink.getSample(...)` retrieves the frame for that time.
  This is not a final media scheduler.
- Looping restarts from the first decoded timestamp and may need more precise
  handling for unusual files.
- No benchmark paths, annotations, bounding boxes, masks, labels, tracks, keypoints, interactions,
  persistence, WebGPU, or 3D work are included.
