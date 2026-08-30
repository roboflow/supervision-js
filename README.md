# supervision-js

Browser-native tools for building interactive computer vision applications.

`supervision-js` is the TypeScript-first, browser-focused subset of
[Roboflow Supervision](https://github.com/roboflow/supervision). It provides
renderer-owned media sessions, detection rendering, styling, interaction, and
editing for images, video, and browser media streams.

It does not aim for one-to-one API parity with Python Supervision. Python
Supervision remains the broad toolkit for computer vision workflows; this
package focuses on the browser runtime needed to build rich CV media UIs.

## What You Can Build

- media viewers where playback and annotations share one timing source;
- interactive boxes, masks, polygons, polylines, keypoints, and labels;
- model demos, review tooling, and browser-native CV applications;
- streaming or static detection overlays with app-owned data and persistence.

## Quick Start

The primary primitive is one `MediaSession` per media item:

```ts
import { annotationRenderers, createMediaSession } from "supervision";

const session = await createMediaSession({
  container: document.querySelector("#viewer")!,
  media: fileOrUrl,
});

await session.play();
```

Add detections as semantic data, then change their presentation independently:

```ts
const session = await createMediaSession({
  container,
  media,
  detections: { appendable: { datasetId: "upload-1" } },
  normalize: { stream: true },
});

await session.appendDetectionFrames(frames);

session.setPresentation({
  renderers: [
    annotationRenderers.box({ style: boxStyle }),
    annotationRenderers.mask({ style: maskStyle }),
    annotationRenderers.label({ style: labelStyle }),
  ],
});
```

## Installation

```sh
npm install supervision
```

The next browser release is published as `0.2.0-next.0` on npm's `next` tag first, so an
application can try the web video engine before it reaches `latest`.
Its package includes the private core dependency. Consumers import
only the public browser entrypoints:

```ts
import { createMediaSession } from "supervision";
import { createMaskBrushEditor } from "supervision/editing";
import { createWebVideoEngineMediaRendererSource } from "supervision/web-video-engine";
```

The web video engine is one of those entrypoints, so opening a video file takes
nothing further to install and every install carries the engine. `supervision`
loads it through a dynamic import at the moment a video source opens, so an
application that only annotates still images emits none of its code.

## Documentation And Demo

The public demo and generated API reference are hosted on Render:

- [Documentation](https://supervision-js-demo.onrender.com/)
- [Demo](https://supervision-js-demo.onrender.com/demo/)
- [Vanilla example](https://supervision-js-demo.onrender.com/examples/vanilla/)

Hosted surfaces deliberately use public fixtures only. Media upload and SAM3
inference flows remain local development features because they require the Vite
proxy and app-owned credentials.

Run everything locally from the repository root:

```sh
npm install
npm run dev
```

Useful commands:

- `npm run demo:dev` runs the browser demo.
- `npm run example:vanilla:dev` runs the minimal vanilla integration.
- `npm run docs:dev` runs the generated docs and the embedded demo playground.
- `npm run pages:build` assembles the deployable site.
- `npm run verify` runs the full repository validation suite.

Start with [Application Integration](docs/public/guides/application-integration.md),
[Media Sessions](docs/public/guides/media-sessions.md), and the
[Public API guide](docs/public/guides/public-api.md).

For what the browser path does not do, read
[Browser Support](docs/public/guides/browser-support.md): HEVC in Firefox, the
cost of presenting a frame without WebGPU, audio, and the frame-count ceiling.

## Current API Status

**Supported browser APIs** include `createMediaSession`, media preparation and
playback controls, detections, the renderer-first `annotationRenderers` API,
boxes, box corners, ellipses, markers, masks, mask halos, polygons, polylines,
keypoints, labels, asset- and media-backed regions, presentation styles, picking, and the
advanced editing subpath.

**Advanced browser APIs** expose lower-level renderer construction, detection
sources, streaming ingestion, normalization, interaction, and diagnostics for
serious integrations.

**Experimental APIs** include React Native support. It is not part of the
browser package promise and may change independently.

## Contributing

We welcome issues, documentation improvements, examples, and code
contributions. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull
request, and follow the [Code of Conduct](CODE_OF_CONDUCT.md) in all project
spaces.

## License

MIT. See [LICENSE](LICENSE).
