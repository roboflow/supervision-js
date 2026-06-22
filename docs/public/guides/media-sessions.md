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

For common UI decisions, use the aggregate flags first:

```ts
session.subscribe((state) => {
  controls.play.disabled = state.playbackBlocked;
  overlay.hidden = !state.presentationBlocked;
});
```

Use `activities` when the app needs to explain why playback or presentation is
blocked.

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

## Renderer Quality

By default the renderer uses the browser's device pixel ratio. Apps that need
to reduce GPU memory or fill-rate pressure can cap it:

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
or busy browsers. Leaving the option unset preserves native device resolution.

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
and `labelStyle`; `undefined` falls back to the global presentation and `null`
disables that layer for the source.

Do not combine `detections.sources` with legacy single-source inputs such as
`frames`, `source`, or `appendable`.

For a fuller “model predictions plus draft annotations” walkthrough, see
[Multiple Detection Sources](../recipes/multiple-detection-sources.md).

## Runtime Updates

After creation, the same session remains the consumer API:

```ts
await session.appendDetectionFrames(frames);
await session.seek(4.2);

session.setPresentation({
  boxStyle,
  maskStyle,
  labelStyle,
});

session.destroy();
```

This is the intended integration shape for apps: create one session per media
item, feed it detections as they become available, update presentation styles
without rewriting detections, and destroy the session when the media item leaves
the UI.
