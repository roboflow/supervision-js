---
title: Public API
group: Guides
summary: The supported browser package surface and its advanced boundaries.
---

# Public API

The `supervision` browser package is session-first. The public API should make the common path
easy while keeping renderer internals replaceable.

This guide describes the current package boundary. It is intentionally smaller
than the implementation.

Today, `supervision` is the browser package. It is built on a
platform-neutral internal core package, but browser users should continue to
import from `supervision`:

```ts
import { createMediaSession } from "supervision";
```

Install the current browser release with `npm install supervision`. See
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
- `session.captureFrame()` when a host needs an encoded JPEG `Blob` for the
  raw media frame currently presented by the renderer. The result includes that
  frame's media timestamp and dimensions; it never exposes a renderer canvas
  or composited annotations;
- renderer source/frame readouts for timeline UI, including estimated frame
  rate, count, and current index while media timestamps remain canonical;
- `DetectionFrame`
- `DetectionFrame.coordinateSpace` when detections were produced against a
  differently sized copy of the media; the renderer projects vector geometry
  into media space for every detection input, so static frames, caller-owned
  sources, composite sources, and appended frames all behave the same. A
  composite composes children that were each inferred at a different size, and
  every child is projected from its own space before composition
- `Detection`
- `Detection.trackerId` for identity assigned by a tracking post-processor
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
- `annotationRenderers`
- `annotationRendererKinds`
- `AnnotationRenderer`
- `AnnotationRendererKind`
- `RegionAnnotationRenderer`
- `detectionPostProcessors`
- `createDetectionPostProcessingPipeline()`
- `TrackingGeometry`
- `DetectionPostProcessingMode`
- `prepareMedia()`
- `prepareMediaProgressively()`
- `probeMedia()`
- `MediaErrorKind` and `MediaSourceError` for branching on media failures

These are the concepts a user should be able to understand without knowing how
Pixi, Mediabunny, workers, or prepared mask artifacts are wired internally.

## Annotation Renderers

`MediaRendererPresentation.renderers` is the unified presentation surface for
annotation visualization. An annotation renderer consumes semantic detections
and contributes to the renderer-owned scene. The built-ins retain the
established draw order and backend paths for masks, boxes, vectors, and labels.

```ts
import { annotationRenderers, BaseBoxStyle, BaseLabelStyle } from "supervision";

session.setPresentation({
  renderers: [
    annotationRenderers.box({
      style: new BaseBoxStyle({
        stroke: { color: 0x8b5cf6, width: 2 },
      }),
    }),
    annotationRenderers.label({
      style: new BaseLabelStyle(),
    }),
  ],
});
```

The current built-ins are `box`, `box-corners`, `ellipse`, `marker`, `mask`,
`maskHalo`, `polygon`, `polyline`, `keypoints`, `label`, and the
multi-instance `region` renderer for asset overlays and current-frame media
crops;
`annotationRendererKinds` enumerates that vocabulary and
`AnnotationRendererKind` names it in application code. When supplied, the list
is authoritative: omitted built-ins are
disabled, and `renderers: []` disables every built-in layer. For a listed
renderer, an explicit `style` wins; otherwise its matching legacy style field
provides the default. A source-specific override can refine a selected layer,
but cannot re-enable an omitted layer. The existing `boxStyle`, `maskStyle`,
and related presentation fields remain supported for compatibility and
source-specific style overrides. New global presentation code should prefer
the renderer list.
`region` carries its target, source, anchor, transform, and composition
configuration directly because it does not lower into one of the legacy style
fields. Its browser backend supports URL-based assets and crops of the existing
renderer-owned media texture. Media crops may request exact mask coverage,
which reuses the renderer's prepared GPU ID-mask artifact, or polygon coverage
for canonical closed polygons. Asset transforms may use an
explicit media- or screen-space size; screen-space assets stay the same visible
size across differently sized detections and viewport zoom. Multiple region
descriptors may coexist when each has a unique `id`.
Media sources may also request bounded `blur` or `pixelate` effects through
`source.effect`; those semantic settings stay independent of the browser filter
implementation and operate on the renderer-owned current frame.
Do not pass Pixi display objects or custom drawing callbacks: the public API
describes semantic renderer configuration while the browser backend owns
composition and resource lifetime.

## Advanced Public API

These exports are public because serious integrations need them, but they are
not the first thing most users should reach for:

- `createMediaRenderer()` for lower-level renderer ownership;
- `createMediaStreamRendererSource()` for adapting a browser `MediaStream`
  without adding a second visible video layer; its bounded snapshot queue is
  latest-frame-wins, so a temporarily slow renderer resumes at the live edge
  instead of replaying stale frames. Its `onPresentedFrame` option reports
  `MediaStreamPresentedFrame` metadata — media time plus, where the browser
  supplies them, RTP timestamp, dimensions, presentation time, and expected
  display time — so a host can correlate transport-side results with what is on
  screen without opening a second hidden video. No DOM element or vendor object
  crosses that boundary, and every field beyond `mediaTime` is optional;
- `createVideoEngineMediaRendererSource()` and `openVideoEngineMediaSource()`
  for video presented by the web video engine, which owns the playhead and
  announces each frame it puts on screen while the renderer composites it with
  annotations drawn from that frame's own timestamp. Both are also exported from
  `supervision/web-video-engine`, alongside the engine's own types; the subpath
  and the root give the same two functions. The engine is loaded dynamically at
  the moment one of these opens a source, so an application that never opens one
  pays nothing in its bundle to import `supervision`. Pass `display` to size the
  decode to the box the frames are painted into; without it they decode at the
  source's full resolution however small that box is. Under this source the
  renderer also answers `getRenderCount()` and `getPreparedAnnotationWindow()`,
  which report `null` for pulled media;
- `DetectionFrameSource` for caller-owned range loading. `loadFrames` receives
  optional `DetectionFrameLoadOptions`; a source that returns its own frames
  unchanged can ignore it, while a source that flattens child frames uses
  `coordinateSpace` to project each child before composing;
- `LiveMediaSession`, the shape `createMediaSession()` returns. It guarantees
  `appendLiveDetectionFrame()` and `finalizeDetectionCoverage()`, which stay
  optional on `MediaSession` so controllers and test doubles written against the
  previous shape remain assignable;
- `WritableDetectionFrameSource` and `createWritableDetectionFrameSource()` for
  streaming inference ingestion. `appendLiveFrame()` and `finalizeCoverage()`
  are optional members of `WritableDetectionFrameSource`, so a source written
  before they existed still satisfies the interface;
  `createWritableDetectionFrameSource()` returns the narrower
  `LiveWritableDetectionFrameSource`, which requires both, and the session
  surfaces them as `session.appendLiveDetectionFrame()` and
  `session.finalizeDetectionCoverage()`;
- `projectDetectionFrame()`, `projectDetectionFrames()`, and
  `createProjectedDetectionFrameSource()` when a host wants the same
  coordinate-space projection outside a session;
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
- ordered detection post-processing, bounded out-of-order buffering, tracking
  diagnostics, in-place derived detection updates, optional raw-copy
  preservation, and worker options.

`RenderPreparationMode.Auto` uses the package's embedded Blob worker when the
browser supports it and falls back to main-thread preparation after a worker
failure. `RenderPreparationMode.Worker` is strict: worker creation or runtime
failures reject instead of silently changing execution modes.

Hosts whose Content Security Policy blocks Blob workers may supply a
`RenderPreparationWorkerFactory` and host the self-contained script exported at
`supervision/render-preparation-worker`. That subpath is a deployment asset,
not a JavaScript API; its message protocol is intentionally internal.

Tracking uses the same deployment pattern. The self-contained script at
`supervision/detection-post-processing-worker` can be hosted by strict-CSP
applications through a `DetectionPostProcessingWorkerFactory`; its protocol is
also private.

### Live And Progressive Detections

A producer that streams results into a session has four supported contracts:

- `session.appendDetectionFrames()` writes a batch. Frames that declare
  `coordinateSpace` are normalized into media space before storage; rectangles,
  polygons, polylines, and keypoints scale, while masks keep their own intrinsic
  dimensions and are never scaled twice.
- `session.appendLiveDetectionFrame()` writes the newest result for a live
  stream. It stays active until the next live frame supersedes it, at which
  point the previous frame is closed at the new frame's `mediaTime`. At most two
  frames are written per call, so append cost does not grow with retained
  history. Tune the open-ended hold with
  `detections.appendable.live.holdSeconds` (default 60 seconds).

  Live writes are serialized inside the source and the newest causal result
  wins: concurrent appends are applied in call order, and a result older than
  the newest accepted live frame is dropped rather than reopening coverage the
  source already closed. A repeat of the current frame's identity is treated as
  a revision and replaces it. Because the hold is a placeholder for "still
  current" rather than covered data, retention windows are measured against the
  producer's real coverage, not against the hold.

- `session.finalizeDetectionCoverage(endTime?)` closes the last frame at the
  end of media, defaulting to the renderer's reported duration. It sets that
  frame's exclusive end to the requested time, extending a finite frame whose
  container declared a duration past the last decoded sample, or shortening a
  live frame that is still held open. Without it, reported availability either
  leaves a terminal sliver uncovered or claims time past the end of media. It is
  idempotent.
- `session.refresh()` still redraws on demand. By default the session also
  redraws itself when a write actually changed the frame selected for the
  displayed time. Live writes, batch writes, and coverage finalization all use
  the same rule: a result the source dropped as stale changes nothing, and a
  frame whose interval does not contain the displayed time cannot change what
  is on screen. A frame written without an
  `endTime` stays selected until a later frame supersedes it, so one appended
  behind the displayed time still redraws, and rewriting the most recent one
  with a real end redraws for the time it stops covering. Requests arriving during a redraw
  collapse into a single follow-up. Set `detections.autoRefresh: false` to own
  every redraw.

Retention windows evict in place when the cold store implements `pruneFrames`
(the built-in memory store does), so a long-running stream does not reload and
rewrite everything it keeps on every append. `pruneFrames` rejects a retention
floor that is not finite and non-negative rather than silently emptying a
dataset. Stores without that hook keep working through a reload-and-replace
fallback.

### Media Failures

Media failures carry a stable `MediaErrorKind` instead of asking applications to
match decoder, demuxer, or container message text:

```ts
import { MediaErrorKind, getMediaErrorKind } from "supervision";

const state = session.getState();

if (state.renderer?.source.errorKind === MediaErrorKind.UnsupportedFormat) {
  // Application-owned, localized copy.
}
```

`MediaSourceError` preserves the originating failure on `cause`. Public media
sources — finite video, `MediaStream`, and image sources — wrap what they throw,
and `getMediaErrorKind()` classifies any caught value, including one that never
passed through a source boundary. Unrecognized failures stay representable as
`MediaErrorKind.Unknown`, and new kinds may be added over time, so treat unknown
values like `Unknown`. `MediaSourceState.errorKind` is optional, so state
fixtures written before it existed keep type-checking; read it as
`state.renderer?.source.errorKind ?? null`.

Finite video sources present a zero-based timeline. Media trimmed through an
edit list carries decodable samples ahead of presentation time zero; those are
not presented, and the session reports `firstTimestamp` as the presentation
start rather than the negative decode start.

## Editing API

Annotation editing is a supported advanced API at the dedicated subpath:

```ts
import {
  createAnnotationEditingEngine,
  createEditableAnnotationFrameSession,
  createMaskBrushEditor,
} from "supervision/editing";
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
- ID-mask artifact payloads;
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
clock playback. `createReactNativeVideoFileSession()` presents the same
`MediaSession` controls and state surface as the generic path, while keeping
its native decoder, worklet runtime, and Skia resources private to the package.
Pause, play/resume, and stop are available; seeking is intentionally
unsupported until native decoding can reposition accurately. The older
`createReactNativeVideoSession()` name remains a deprecated forwarding alias.

Saved-video decoding on Android is implemented as an **experimental**
Nitro/C++ source backed by `AMediaExtractor` and `AMediaCodec`, delivering an
API-26+ RGBA `AHardwareBuffer` to the existing ExecuTorch and Skia consumers
with explicit timestamp and release ownership. It requires Android API 26;
older hosts report the stable `android-video-file-source-requires-api-26`
reason, and hosts without the native module keep the usual fallback
diagnostics. Rotated videos (portrait phone recordings with a
`rotation-degrees` track metadata) are rejected with an explicit error until
the GPU rotation pass lands. The pipeline is validated end-to-end on an
emulator; physical-device validation and performance numbers are still pending.

React Native currently shares editing geometry, picking, and gesture semantics
through `createReactNativeAnnotationGestureAdapter`. Native hosts own drawing
editing affordances from `AnnotationOverlayStyle` until a native overlay
renderer is introduced.

The experimental `./react/live-inference` entrypoint owns the live VisionCamera
worklet through `useReactNativeLiveInference()`; applications provide model
runners and serializable configuration, not frame callbacks. This keeps the
generic `./react` entry usable without the optional Worklets peer.

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
