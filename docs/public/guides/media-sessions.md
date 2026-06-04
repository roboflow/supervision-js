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
session.setPresentation({ maskStyle, boxStyle, labelStyle });
const state = session.getState();
session.destroy();
```

The host should not need to know how Pixi containers, mask textures, worker
queues, or detection chunks are wired internally.

## Good Defaults

The default path is intentionally boring:

- media is opened through the default browser media adapter;
- visual composition is owned by the renderer;
- detections are optional;
- render preparation uses the built-in worker strategy when available;
- state is available through `getState()` and `subscribe()`;
- advanced buffering, retention, interaction, and diagnostics are opt-in.

## State

Session state reports whether the media is loading, ready, playing, paused,
buffering, processing, destroyed, or errored.

It also includes activity details such as media normalization, detection loading,
playback buffering, and render artifact preparation. Apps can use this to show
loading UI without wiring every internal subsystem manually.

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
