---
title: Public API
group: Guides
summary: What the package surface is intended to promise at this prototype stage.
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
- `DetectionFrame`
- `Detection`
- `Rect`
- `DetectionMask`
- `BaseBoxStyle`
- `BoxShape`
- `BaseMaskStyle`
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
- render-preparation diagnostics and worker options.

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
- React components or hooks.

Prepared artifacts are runtime representations. Detections remain semantic data.
Apps should feed detections and styles into a session, not construct renderer
artifacts directly.

## React Boundary

React integration should be a separate thin adapter later. It should create and
destroy vanilla `MediaSession` instances, subscribe to session state, and pass
props into `session.setPresentation()` or session options.

It should not own media timing, render loops, detection buffering, inference
ingestion, worker orchestration, or Pixi composition.

The browser package remains vanilla TypeScript/JavaScript. React wrappers should
wrap `MediaSession`; they should not shape media timing, rendering, buffering,
or prepared artifact internals.

## React Native Boundary

React Native support is experimental and private. The future mobile package
should depend on the platform-neutral core concepts, not on the browser package.
Pixi, Mediabunny, DOM APIs, browser workers, and IndexedDB remain browser
implementation details.

Mobile apps may eventually feed detections from on-device inference engines, but
inference is outside the rendering package boundary. The library should render
and interact with detections regardless of how they were produced.

## Compatibility Posture

This is still a prototype. The strongest compatibility promise is around the
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
