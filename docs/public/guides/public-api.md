---
title: Public API
group: Guides
summary: The supported browser package surface and its advanced boundaries.
---

# Public API

`supervision-js` is session-first. The public API should make the common path
easy while keeping renderer internals replaceable.

This guide describes the current package boundary. It is intentionally smaller
than the implementation.

Today, `supervision-js` is the browser package. It is built on a
platform-neutral internal core package, but browser users should continue to
import from `supervision-js`:

```ts
import { createMediaSession } from "supervision-js";
```

The first npm release is still being prepared. Until then, install the portable
`supervision-js-0.1.0.tgz` archive built from this repository. See
[Application Integration](application-integration.md) for the supported
consumer workflow.

The split keeps detections, timelines, styles, retention policies, source
composition, and picking contracts reusable without making Pixi, Mediabunny,
workers, or browser storage part of those core concepts.

## Primary API

Start here for normal application code:

- `createMediaSession()`
- `MediaSession`
- `MediaSessionOptions`
- `MediaSessionState`
- `MediaSessionStatus`
- `MediaSessionActivity`
- media controls on `MediaSession`: `play`, `pause`, `seek`, frame stepping,
  playback rate, and current-presentation `refresh`;
- renderer source/frame readouts for timeline UI, including estimated frame
  rate, count, and current index while media timestamps remain canonical;
- `DetectionFrame`
- `Detection`
- `Rect`
- `DetectionMask`
- `PolygonGeometry`
- `PolylineGeometry`
- `KeypointGeometry`
- `BaseBoxStyle`
- `BoxShape`
- `BaseMaskStyle`
- `BasePolygonStyle`
- `BasePolylineStyle`
- `BaseKeypointStyle`
- `BaseLabelStyle`
- `BaseInteractionStyle`
- `BaseFocusStyle`
- `prepareMedia()`
- `prepareMediaProgressively()`
- `probeMedia()`

These are the concepts a user should be able to understand without knowing how
Pixi, Mediabunny, workers, or prepared mask artifacts are wired internally.

## Advanced Public API

These exports are public because serious integrations need them, but they are
not the first thing most users should reach for:

- `createMediaRenderer()` for lower-level renderer ownership;
- `createMediaStreamRendererSource()` for adapting a browser `MediaStream`
  without adding a second visible video layer; its bounded snapshot queue is
  latest-frame-wins, so a temporarily slow renderer resumes at the live edge
  instead of replaying stale frames;
- `DetectionFrameSource` for caller-owned range loading;
- `WritableDetectionFrameSource` and `createWritableDetectionFrameSource()` for
  streaming inference ingestion;
- `detections.sources`, `MediaSessionDetectionSourceOptions`, and
  `createCompositeDetectionFrameSource()` for composing model predictions,
  draft annotations, review overlays, or other app-owned detection streams over
  one media item;
- `session.setRenderQuality()` for runtime DPR/quality changes without
  rebuilding the media session;
- cold detection stores for custom persistence and testing;
- chunked detection sources for large static detection datasets;
- media normalization functions and options;
- interaction and picking options;
- polygons, polylines, keypoints, shared class-color helpers, and visibility
  controls;
- render-preparation diagnostics and worker options.

`RenderPreparationMode.Auto` uses the package's embedded Blob worker when the
browser supports it and falls back to main-thread preparation after a worker
failure. `RenderPreparationMode.Worker` is strict: worker creation or runtime
failures reject instead of silently changing execution modes.

Hosts whose Content Security Policy blocks Blob workers may supply a
`RenderPreparationWorkerFactory` and host the self-contained script exported at
`supervision-js/render-preparation-worker`. That subpath is a deployment asset,
not a JavaScript API; its message protocol is intentionally internal.

## Editing API

Annotation editing is a supported advanced API at the dedicated subpath:

```ts
import {
  createAnnotationEditingEngine,
  createEditableAnnotationFrameSession,
  createMaskBrushEditor,
} from "supervision-js/editing";
```

The host creates and owns the editing engine, commits semantic detections to
its own source or persistence layer, and owns undo/redo. Pass the engine through
`createMediaSession({ renderer: { editingEngine } })` so the session routes
pointer gestures and renders previews. `maskBrush` and `previewOverlay` use the
same session renderer options. The renderer never writes application data.

The generated API reference has a separate Editing module for this entrypoint.

`Rect` is center-based: `x` and `y` are the media-pixel center, while `width`
and `height` are its extent. `TopLeftRect` is only for explicit canvas/layout
boundaries. There is no legacy top-left rectangle mode.

Advanced APIs should remain renderer-neutral. They may expose timing,
diagnostics, and data-flow contracts, but they should not expose Pixi containers,
textures, shaders, or Mediabunny objects.

## Not Public Yet

These are implementation details, even when they are important to performance:

- Pixi scene layers;
- Mediabunny adapter internals;
- worker message protocols;
- PNG ID-mask artifact payloads;
- shader palette formats;
- prepared render-window cache internals;
- demo-only Roboflow or SAM3 request code;
- React components or hooks in the browser package. The private experimental
  React Native package has a separate `./react` entrypoint.

Prepared artifacts are runtime representations. Detections remain semantic data.
Apps should feed detections and styles into a session, not construct renderer
artifacts directly.

## React Boundary

React integration should be a separate thin adapter later. It should create and
destroy vanilla `MediaSession` instances, subscribe to session state, and pass
props into `session.setPresentation()` or session options.

It should not own media decoding, media timing, frame stepping, render loops,
detection buffering, inference ingestion, worker orchestration, or Pixi
composition. Timeline UI should consume session state and `renderer.onFrame`,
then call session navigation methods.

The browser package remains vanilla TypeScript/JavaScript. React wrappers should
wrap `MediaSession`; they should not shape media timing, rendering, buffering,
or prepared artifact internals.

## React Native Boundary

React Native support is experimental and private. The current mobile package
depends on the platform-neutral core concepts, not on the browser package.
Pixi, Mediabunny, DOM APIs, browser workers, and IndexedDB remain browser
implementation details.

The private package now has a generic `createMediaSession()` core, a
package-owned `MediaSessionView` and `useMediaSession()` hook at
`supervision-js-react-native/react`, and platform adapter subpaths. These are
mobile experiments, not exports from `supervision-js` and not part of the
stable browser-package promise.

Mobile apps can feed detections from on-device inference engines, but inference
is outside the rendering package boundary. The library renders and interacts
with detections regardless of how they were produced.

The experimental iOS saved-video path is analysis-paced: it processes each
decoded frame as quickly as inference permits rather than trying to match wall
clock playback. It reports explicit capabilities; pause, resume, and stop are
available, while seeking is intentionally unsupported until native decoding can
reposition accurately. New package code should use
`REACT_NATIVE_FILE_SESSION_DEFAULTS`; `REACT_NATIVE_VIDEO_SESSION_DEFAULTS`
remains only as a deprecated compatibility alias.

The experimental saved-video session is analysis-paced: it processes each
decoded frame as quickly as inference permits rather than trying to match wall
clock playback. It reports explicit capabilities; pause, resume, and stop are
available, while seeking is intentionally unsupported until native decoding can
reposition accurately.

React Native currently shares editing geometry, picking, and gesture semantics
through `createReactNativeAnnotationGestureAdapter`. Native hosts own drawing
editing affordances from `AnnotationOverlayStyle` until a native overlay
renderer is introduced.

The remaining mobile work is integration, not a second session abstraction:
move the saved-video compatibility factory and the example-owned live lane onto
the generic source/processor/renderer contracts, and add an Android saved-video
source before claiming cross-platform file support.

## Compatibility Posture

The package is pre-1.0. The strongest compatibility promise is around the
session-first model:

1. one media item maps to one session;
2. detections are semantic input;
3. styles define presentation;
4. the renderer owns visual composition;
5. prepared artifacts stay internal.

When adding exports, prefer one of these outcomes:

- add to the primary API because most apps need it;
- add to advanced API because integrations need it;
- keep it internal until a real second use case appears.
