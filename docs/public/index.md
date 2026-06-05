# supervision-js

`supervision-js` is a browser-native computer vision media rendering library.
It owns media playback and annotation rendering in one Pixi-powered scene so
detections are selected from the same timing reference as the displayed frame.

The main API is `createMediaSession()`. Start there.

## Quickstart

Render media inside a container with the default renderer, media preparation,
playback state, and render-preparation behavior:

```ts
import { createMediaSession } from "supervision-js";

const container = document.querySelector("#viewer");

if (!container) {
  throw new Error("Missing #viewer container.");
}

const session = await createMediaSession({
  container,
  media: file,
  renderer: {
    autoPlay: true,
    loop: true,
  },
});

session.subscribe((state) => {
  console.log(state.status, state.activities);
});
```

That is enough to get a renderer-owned media scene. The session chooses the
default browser media path, Pixi renderer, playback loop, and render-preparation
settings.

## Add Detections Later

For model outputs that arrive after the media session starts, create an
appendable detection source. The session stores detections in a cold source,
hydrates a hot window near playback, prepares renderer-friendly artifacts, and
presents only the active frame.

```ts
const session = await createMediaSession({
  container,
  media: file,
  detections: {
    appendable: {
      datasetId: "upload-session-1",
    },
  },
  renderer: {
    autoPlay: true,
  },
});

await session.appendDetectionFrames([
  {
    frameIndex: 0,
    mediaTime: 0,
    detections: [
      {
        id: "person-1",
        className: "person",
        confidence: 0.92,
        rect: { x: 120, y: 80, width: 240, height: 420 },
      },
    ],
  },
]);
```

## What The Session Owns

- media preparation and optional normalization;
- Pixi scene lifecycle;
- playback, seek, pause, and loop behavior;
- cold detection storage;
- hot detection buffering around the current time;
- prepared render artifacts such as PNG ID-mask frames;
- presentation style updates;
- interaction and picking;
- loading, processing, buffering, and error state.

## What The Host App Owns

- user interface;
- file upload;
- model and API calls;
- authentication and API keys;
- business workflows;
- deciding when detections should be appended.

## Why Renderer-Owned Composition Matters

The media frame and detections are not split between a DOM `<video>` and a
separate overlay canvas. `supervision-js` presents media and annotations in the
same renderer-owned visual system. That keeps playback and detections tied to
one timing source and avoids drift caused by separate composition layers.

## Where To Go Next

- Read [Media Sessions](guides/media-sessions.md) for the working session model.
- Read [Detections And Rendering](guides/detections-and-rendering.md) for the
  cold, hot, prepared, and active render pipeline.
- Browse the generated API reference by domain. The Modules page groups exports
  into Media Sessions, Detections, Rendering, Styles, Interactions, and Media
  Preparation.
