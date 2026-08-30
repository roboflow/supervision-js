---
title: Media Preparation
group: Guides
summary: Probe uploaded media and normalize it into a browser-renderable profile.
---

# Media Preparation

`supervision-js` treats media preparation as part of the rendering foundation.
For uploaded files, the browser may not be able to decode the input efficiently
or consistently. The preparation APIs probe the file, choose a supported target,
and normalize the video before rendering or inference workflows depend on it.

Normalization does not close every gap. Which codecs a browser will decode, and
what a browser without WebGPU costs to present a frame, are limits of the
browser itself. [Browser Support](./browser-support.md) lists them.

## Probe First

Use `probeMedia()` when the app wants to inspect browser support and explain
problems before starting normalization:

```ts
const probe = await probeMedia(file);

if (probe.status === MediaProbeStatus.Unsupported) {
  console.warn(probe.issues);
}
```

## Full Preparation

Use `prepareMedia()` when the app can wait for a complete normalized blob:

```ts
const prepared = await prepareMedia(file);

const objectUrl = URL.createObjectURL(prepared.normalizedMedia.blob);
```

This path is simple and useful for short files, export workflows, and tests.

## Progressive Preparation

Use `prepareMediaProgressively()` when the app wants a renderer source as bytes
are produced:

```ts
const prepared = await prepareMediaProgressively(file, {
  normalization: {
    video: { frameRate: 30 },
  },
});

const session = await createMediaSession({
  container,
  media: prepared.normalizedMedia.rendererSource,
});
```

The progressive result also exposes `completion`, which resolves to the final
normalized blob when conversion finishes.

## Session Shortcut

For the common viewer path, `createMediaSession()` can perform progressive
normalization directly:

```ts
const session = await createMediaSession({
  container,
  media: file,
  normalize: { stream: true },
});
```

This keeps media decoding and annotation rendering in the same renderer-owned
composition while the normalized media becomes available.

## What The Session Shortcut Gives Up

`normalize` makes the session build its own renderer source: an object URL for a
full transcode, a streaming pull source for a progressive one. Neither is the
video-engine source, so this route has no presented-frame channel, and an
enabled render-preparation gate holds every frame the renderer pulls rather than
only the start of playback.

Normalized bytes reach the engine perfectly well; there is simply no option that
asks `createMediaSession()` for both. A host that wants both normalizes first
and passes the result as an engine blob source:

```ts
import {
  createMediaSession,
  createWebVideoEngineMediaRendererSource,
  prepareMedia,
} from "supervision";
import { SourceKind } from "supervision/web-video-engine";

const prepared = await prepareMedia(file);

const session = await createMediaSession({
  container,
  media: createWebVideoEngineMediaRendererSource({
    source: { blob: prepared.normalizedMedia.blob, kind: SourceKind.Blob },
  }),
});
```

## Normalization Defaults

Normalization is opt-in, and every field below is optional. Left unset, a
session normalizes to this profile:

| Option                           | Default                            |
| -------------------------------- | ---------------------------------- |
| `container`                      | `MediaNormalizationContainer.WebM` |
| `video.codec`                    | VP9 for `WebM`, AVC for `Mp4`      |
| `video.frameRate`                | `30`                               |
| `video.keyFrameInterval`         | `1` second                         |
| `video.forceTranscode`           | `true`                             |
| `video.width` / `video.height`   | the source's display size          |
| `video.bitrate`                  | unset, so the encoder chooses      |
| `audio.discard`                  | `true`                             |
| `stream` (session shortcut only) | `false`                            |

The frame rate is the one to watch. A variable-rate input normalizes onto a
constant 30Hz grid, which is what makes `frameIndex` a usable address for
detections computed against the normalized media.

`video.forceTranscode` defaults to `true`, so an input that already matches the
target profile is still re-encoded. Set it to `false` when a compatible stream
should be copied through instead.

`audio.discard` defaults to `true` because nothing in the package plays audio.
Keeping the track only makes the output larger.
