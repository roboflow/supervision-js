# supervision-js

Browser-native computer vision media rendering and annotation engine.

`supervision-js` is an early TypeScript-first prototype for rendering computer
vision detections over browser media with high-performance, renderer-owned
composition. It is intended to become the JavaScript ecosystem counterpart to
Roboflow's Python `supervision` ecosystem.

This repository is prototype-stage. The public API is being shaped around the
rendering foundation first, not a large final annotation hierarchy.

## Why This Exists

Computer vision media UIs need more than a DOM `<video>` with a separate canvas
overlay. Dense boxes, masks, labels, tracks, and future temporal/3D overlays
need one timing and rendering system.

The core approach:

- media and annotations are composed in one renderer-owned scene;
- Mediabunny prepares and normalizes browser media;
- PixiJS v8 is the first 2D rendering backend;
- detections stay semantic and compact in cold storage;
- hot windows and prepared render artifacts keep playback responsive;
- styles define presentation without mutating detections.

## Quick Start

The primary primitive is one `MediaSession` per media item:

```ts
import { createMediaSession } from "supervision-js";

const session = await createMediaSession({
  container: document.querySelector("#viewer")!,
  media: fileOrUrl,
});

await session.play();
```

Add detections when you have them:

```ts
const session = await createMediaSession({
  container,
  media,
  detections: {
    appendable: {
      datasetId: "upload-1",
    },
  },
  normalize: { stream: true },
});

await session.appendDetectionFrames(frames);
```

Change rendering without rewriting detection data:

```ts
session.setPresentation({
  boxStyle,
  maskStyle,
  labelStyle,
});
```

## Docs And Demo

Run from the repository root:

```sh
npm install
npm run dev
```

Useful commands:

- `npm run demo:dev` runs the Vite demo.
- `npm run example:vanilla:dev` runs the minimal vanilla example.
- `npm run example:react-native:dev` runs the experimental Expo mobile proof.
- `npm run docs:dev` builds and serves the generated docs.
- `npm run docs:build` builds the TypeDoc site.
- `npm run pages:build` assembles the static GitHub Pages artifact.
- `npm run verify` runs the full local verification suite.

The public POC is deployed on
[Render](https://supervision-js-demo.onrender.com/):

- the fixture demo is served at the project root;
- generated docs are served at
  [`/docs/`](https://supervision-js-demo.onrender.com/docs/);
- the vanilla example is served at
  [`/examples/vanilla/`](https://supervision-js-demo.onrender.com/examples/vanilla/).

The same static artifact is deployed to the repository-authenticated
[GitHub Pages mirror](https://roboflow.github.io/supervision-js/). Both hosted
demos intentionally offer fixture selection only. Upload media and SAM3
inference remain available locally through the Vite proxy:

```sh
npm run demo:dev
```

Start with:

- [Application Integration](docs/public/guides/application-integration.md)
- [Media Sessions](docs/public/guides/media-sessions.md)
- [Public API](docs/public/guides/public-api.md)
- [Media Preparation](docs/public/guides/media-preparation.md)
- [Detections And Rendering](docs/public/guides/detections-and-rendering.md)
- [Presentation Styles](docs/public/guides/presentation-styles.md)

Recipes:

- [React Integration](docs/public/recipes/react-integration.md)
- [Static Detections](docs/public/recipes/static-detections.md)
- [Streaming Detections](docs/public/recipes/streaming-detections.md)
- [Progressive Upload Normalization](docs/public/recipes/progressive-upload-normalization.md)
- [Session Lifecycle](docs/public/recipes/session-lifecycle.md)

The minimal vanilla example is served locally and on both hosted artifacts at
`/examples/vanilla/`.

## Installable Tarball

The repository is private, so consumers install a packed archive instead of a
published package:

```sh
npm run package:tarball
```

That builds the core and browser packages and writes one
`artifacts/supervision-js-<version>.tgz`. A website installs it by path:

```sh
npm install ./supervision-js-0.0.0.tgz
```

Both `supervision-js` and `supervision-js/editing` then resolve normally, and
the private core package travels inside the archive. See
[Tarball Packaging](docs/internal/tarball-packaging.md) for the mechanism and
for `npm run package:tarball:smoke`, which verifies the artifact from a clean
temporary consumer. For consumer-side instructions and integration rules, use
[Application Integration](docs/public/guides/application-integration.md).

## Current Status

Implemented foundation:

- session-first API with media preparation, playback, detections, state, and
  presentation updates;
- progressive browser media normalization;
- cold detection storage, hot buffering, and appendable detection ingestion;
- worker-backed prepared mask artifacts with PNG ID-mask rendering;
- box, mask, and label styles;
- interaction and picking;
- focus highlights and runtime render-quality controls;
- decision-oriented mask rendering benchmarks;
- generated API docs.

Still intentionally evolving:

- package publishing and ownership;
- React wrapper packages;
- additional annotation shapes beyond boxes, masks, and labels;
- long-term 3D renderer direction.

## License

Apache-2.0
