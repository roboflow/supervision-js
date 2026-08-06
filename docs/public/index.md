# supervision-js

The `supervision` npm package is a browser-native TypeScript library for interactive
computer vision media applications. It is the browser-focused subset of
[Roboflow Supervision](https://github.com/roboflow/supervision): focused on
media sessions, detection rendering, styles, interaction, and editing rather
than Python API parity.

The main API is `createMediaSession()`. It renders media and annotations in one
renderer-owned scene, so the visible media frame and its detections share the
same timing reference.

## Installation

The first npm release is still being prepared. Build the portable archive from
this repository and install it in a browser application:

```sh
# In this repository
npm install
npm run package:tarball

# In the consuming application
npm install ./vendor/supervision-0.1.0.tgz
```

The archive includes the internal core dependency. Consumers should import the
public browser package only:

```ts
import { createMediaSession } from "supervision";
import { createMaskBrushEditor } from "supervision/editing";
```

Read [Application Integration](guides/application-integration.md) for the
complete browser, lifecycle, and verification contract.

## Quick Start

```ts
import { createMediaSession } from "supervision";

const container = document.querySelector("#viewer");

if (!container) {
  throw new Error("Missing #viewer container.");
}

const session = await createMediaSession({
  container,
  media: fileOrUrl,
  renderer: { autoPlay: true, loop: true },
});

session.subscribe((state) => {
  console.log(state.status, state.activities);
});
```

## Capabilities

The supported browser surface covers images, video, and browser media streams;
static and streaming detections; boxes, masks, polygons, polylines, keypoints,
and labels; presentation styles; picking; and advanced annotation editing.

React Native is experimental and separately versioned. It is not a dependency
of the browser package or a compatibility promise.

## Learn More

- [Application Integration](guides/application-integration.md)
- [Media Sessions](guides/media-sessions.md)
- [Public API](guides/public-api.md)
- [Media Preparation](guides/media-preparation.md)
- [Detections And Rendering](guides/detections-and-rendering.md)
- [Presentation Styles](guides/presentation-styles.md)
- [React Integration](recipes/react-integration.md)
- [Static Detections](recipes/static-detections.md)
- [Streaming Detections](recipes/streaming-detections.md)
- [Interactive Picking](recipes/interactive-picking.md)
- [Session Lifecycle](recipes/session-lifecycle.md)
