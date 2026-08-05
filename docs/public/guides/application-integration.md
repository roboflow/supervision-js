---
title: Application Integration
group: Guides
summary: The installation, runtime, data, and lifecycle contract for integrating supervision-js into another web application.
---

# Application Integration

Use this page as the integration contract for humans and coding agents adding
`supervision-js` to another web application.

## Installation Before The First npm Release

`supervision-js` is not published to the npm registry yet, and there is no CDN,
UMD, or `<script>` build. Build a portable archive from this public repository
until the first npm release is available.

Build the portable archive from the `supervision-js` repository:

```sh
npm install
npm run package:tarball
```

The archive is written to:

```text
artifacts/supervision-js-0.1.0.tgz
```

Copy that archive into a stable path in the consuming application, then install
it from there:

```text
my-app/
├── package.json
└── vendor/
    └── supervision-js-0.1.0.tgz
```

```sh
npm install ./vendor/supervision-js-0.1.0.tgz
```

Keeping the archive at a stable project-relative path is important:
`package-lock.json` records the local package location, and later `npm ci` runs
must be able to read it. Commit the archive when the consuming repository allows
vendored dependencies; otherwise store it in the team's artifact system and
make retrieval part of the build.

The archive contains the internal `supervision-js-core` package. Consumers must
not install `supervision-js-core` separately.

## Supported Consumer

Use:

- a browser application;
- Node.js 20.19 or newer for install and build tooling;
- an npm-compatible package manager;
- an ESM-aware bundler such as Vite, webpack, Parcel, or esbuild.

The renderer requires browser APIs. In an SSR application, create sessions only
on the client after the container element exists. The package can be imported by
build tooling, but `createMediaSession()` must not run during server rendering.

Do not import Pixi, Mediabunny, worker files, or internal core modules. Import the
supported entrypoints:

```ts
import { createMediaSession } from "supervision-js";
import { createMaskBrushEditor } from "supervision-js/editing";
```

## Minimal Browser Integration

Give the viewer a non-zero size. The renderer appends and resizes its own canvas
inside this element:

```html
<div id="viewer"></div>
```

```css
#viewer {
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #020617;
  overflow: hidden;
}

#viewer canvas {
  display: block;
}
```

Create one session for one media item:

```ts
import {
  BaseBoxStyle,
  BaseLabelStyle,
  createMediaSession,
  type MediaSession,
} from "supervision-js";

const container = document.querySelector<HTMLElement>("#viewer");

if (!container) {
  throw new Error("Missing #viewer container.");
}

let session: MediaSession | null = await createMediaSession({
  container,
  media: "/media/example.mp4",
  presentation: {
    boxStyle: new BaseBoxStyle(),
    labelStyle: new BaseLabelStyle({ includeConfidence: true }),
  },
  renderer: {
    autoPlay: false,
    loop: true,
  },
});

const unsubscribe = session.subscribe((state) => {
  console.log(state.status, state.playbackBlocked, state.errorMessage);
});

await session.play();

// Run when the view unmounts or another media item replaces this one.
unsubscribe();
session.destroy();
session = null;
```

`media` accepts a URL string, `File`/`Blob`, or an advanced
`MediaRendererSource`.

## Add Static Detections

Pass semantic detection frames at session creation:

```ts
import type { DetectionFrame } from "supervision-js";

const frames: DetectionFrame[] = [
  {
    frameIndex: 0,
    mediaTime: 0,
    endTime: 1 / 30,
    detections: [
      {
        id: "person-1",
        className: "person",
        confidence: 0.92,
        rect: {
          x: 240,
          y: 290,
          width: 240,
          height: 420,
        },
      },
    ],
  },
];

const session = await createMediaSession({
  container,
  media: "/media/example.mp4",
  detections: { frames },
});
```

Geometry uses media pixels, not CSS pixels:

- `rect.x` and `rect.y` are the rectangle center;
- `width` and `height` must be positive;
- polygon, polyline, and keypoint points use `{ x, y }` media coordinates;
- `mediaTime` and `endTime` are seconds;
- confidence is between `0` and `1`;
- styles belong in `presentation`, not in detection records.

## Append Detections From Inference

The host application owns model calls. The session can own appendable detection
storage and rendering:

```ts
const session = await createMediaSession({
  container,
  media: uploadedFile,
  normalize: { stream: true },
  detections: {
    appendable: {
      datasetId: "upload-123",
    },
  },
});

for await (const batch of inferenceResults) {
  await session.appendDetectionFrames(batch);
}
```

Use a stable, app-owned `datasetId`. Do not pass rendered canvases, Pixi
objects, or prepared mask textures. Append `DetectionFrame` values.

## Host And Library Ownership

The host application owns:

- UI components and framework state;
- authentication, uploads, and inference requests;
- persistence and business workflow;
- converting model output into `DetectionFrame` values;
- calling `destroy()` when a viewer is removed.

`supervision-js` owns:

- media probing, optional normalization, and playback;
- the renderer canvas and Pixi scene;
- detection buffering and frame selection;
- prepared mask artifacts and browser workers;
- presentation, picking, and renderer state;
- resources scoped to the session.

## Choose The Right Detection Input

Use exactly one of these for a normal single-source session:

| Input                   | Use when                                                                 |
| ----------------------- | ------------------------------------------------------------------------ |
| `detections.frames`     | All detections are already available.                                    |
| `detections.source`     | The app loads time ranges through a custom source.                       |
| `detections.appendable` | Results arrive after the session starts.                                 |
| `detections.sources`    | Separate app-owned streams need independent writes, ordering, or styles. |

Do not combine `detections.sources` with the three single-source inputs.

## Lifecycle Rules

- Create one session per media item and viewer element.
- Destroy the old session before creating a replacement in the same element.
- Retain and call the unsubscribe function returned by `subscribe()`.
- Treat a destroyed session as terminal.
- Keep API keys and inference logic outside the library.
- In React or another component framework, create the session after mount and
  destroy it in the effect cleanup.

See [React Integration](../recipes/react-integration.md) for a complete
component pattern.

## Verification Checklist

Before considering an integration complete:

1. `npm ci` succeeds in a fresh checkout of the consuming application.
2. The production bundler resolves both `supervision-js` and the packaged
   render-preparation worker.
3. The viewer element has a non-zero width and height.
4. Media renders from the same URL/File type used in production.
5. At least one known detection appears at the expected media coordinate.
6. Session state and errors are surfaced to the host UI.
7. Navigating away destroys the session without leaving a canvas or active
   playback behind.

## Common Integration Mistakes

- Installing `supervision-web` instead of `supervision-js`.
- Installing `supervision-js-core` separately.
- Deleting or moving the tarball after committing a local `file:` dependency.
- Running `createMediaSession()` during SSR.
- Mounting into a zero-height container.
- Treating rectangle `x` and `y` as top-left coordinates.
- Storing colors or canvas objects in detections instead of using styles.
- Creating a second session without destroying the first.
- Importing internal worker, Pixi, Mediabunny, or prepared-artifact modules.
