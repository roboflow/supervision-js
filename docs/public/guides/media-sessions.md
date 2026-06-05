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

## State

Session state reports whether the media is loading, ready, playing, paused,
buffering, processing, destroyed, or errored.

It also includes activity details such as media normalization, detection loading,
playback buffering, and render artifact preparation. Apps can use this to show
loading UI without wiring every internal subsystem manually.

`activities` are the host-facing loading contract. They distinguish media
normalization, detection buffering, playback gates, and render-artifact
preparation, so apps can choose a compact status chip, a media overlay, or a
debug panel without reading lower-level renderer internals.

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
