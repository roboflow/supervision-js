# Library Contract

This document defines the current internal contract for `supervision-js` as a
library. It is not public README polish and it is not a final API promise. It is
the working agreement that keeps implementation moving toward a clean,
renderer-first package.

## Package Boundary

The repository is split into internal engine/core workspaces and the browser
package:

- `supervision-js-trackers` in `packages/trackers` is an internal build
  boundary for generic tracking engines and lightweight geometric contracts.
  It must not depend on detections, masks, workers, rendering, or browser APIs.
  It is bundled into core and is not independently published.
- `supervision-js-core` in `packages/core` is platform-neutral. It must not
  depend on DOM, WebWorker, Pixi, Mediabunny, IndexedDB, fetch, or browser media
  APIs.
- `supervision` in `packages/web` is the published browser package. It depends on core
  and provides the current public import surface for browser users.
- `supervision-js-react-native` in `packages/react-native` is experimental and
  private. It depends on core, must not depend on the web package, and exists to
  prove future native rendering boundaries before a stable mobile API exists.

Public examples and docs should keep using:

```ts
import { createMediaSession } from "supervision";
```

Core exists so future renderers can share detections, timelines, styles,
retention policies, source composition, picking contracts, and session lifecycle
contracts without inheriting browser implementation details. Core also owns
renderer-neutral media-rendering readouts such as fit modes, playback/source
status, frame diagnostics, presentation style bundles, and quality hints.
Core adapts detections, masks, and keypoints into lightweight tracker
observations and applies returned tracker assignments. Tracker engines never
receive or mutate full detection payloads.

React Native experiments should share the core semantic model and style
resolution, but should not reuse Pixi, Mediabunny, browser workers, or IndexedDB.
Mobile media frame providers, storage, and rendering surfaces are platform
implementation details.

## Primary Primitive: Media Session

`MediaSession` is the main user-facing primitive. One media item maps to one
session.

A session owns:

- media preparation and optional normalization;
- renderer lifecycle;
- playback control;
- media seeking, frame stepping, and playback-rate control;
- detection source wiring;
- cold detection storage and hot detection buffering;
- prepared render-window orchestration;
- presentation style updates;
- interaction and picking;
- aggregate loading, processing, and error state.

The host application owns application UI, API calls, and business workflows. It
can append detections, update presentation, navigate media, subscribe to state,
invalidate changed semantic data, and destroy the session. It must not run a
parallel decoder, media clock, decoded-canvas handoff, or redraw loop. It should
not need to know how detection chunks, prepared mask artifacts, Pixi textures,
or worker queues are internally wired.

## Public Data Model

The public data model should remain small and evidence-based:

- `DetectionFrame`: a media-time or frame-index keyed unit of detections.
- `Detection`: one model output with optional box, mask, class name,
  confidence, and metadata.
- `Rect`: center-based rectangle geometry used for boxes; top-left rectangles
  are explicit renderer/layout boundaries only.
- `DetectionMask`: currently compressed RLE for semantic cold storage.
- style classes and style interfaces for boxes, masks, labels, polygons,
  polylines, and keypoints.
- `DetectionFrameSource`: the read contract for loading detections by time.
- `WritableDetectionFrameSource`: the write contract for streaming detections
  into a session.

Prepared render artifacts are not public annotation data. ID masks, RGBA
fallbacks, Pixi textures, palettes, and worker payloads are renderer-owned
runtime representations.

## Advanced Editing Contract

The browser package exposes editing from `supervision/editing`, not its root
entrypoint. It contains semantic editing engines, immutable editable-frame
sessions, conversion utilities, and the browser mask brush. Hosts create the
editing engine, commit detections to their chosen persistence/source, and own
undo. `MediaSession` only receives the caller-owned engine to route gestures
and render previews.

`AnnotationOverlayStyle` remains a core renderer-neutral contract so browser
and React Native hosts share editing vocabulary. Pixi display objects and other
renderer implementation types must never appear in public declarations. Live
editing preview values may resolve from the preview detection and
`AnnotationEditingPreviewStyleContext`, allowing move and resize presentation
to retain the edited annotation's class styling independently of host tool
state.

## Detection Pipeline

The package should preserve this pipeline:

1. **Cold detection source/store**
   Compact semantic data. It may live in IndexedDB, memory, static chunks, or a
   caller-owned source.
2. **Hot detection window**
   A small time window of parsed detection frames around playback.
3. **Prepared render window**
   Runtime-friendly artifacts derived from the hot window. For masks this is
   usually one prepared frame-level artifact, such as an ID mask.
4. **Active render frame**
   The renderer presents media and overlays selected from the same media timing
   reference.

This keeps memory proportional to configured window size rather than media
duration.

Stateful semantic post-processing consumes complete frame identities in causal
order, even when inference arrives out of order, and must not be implemented
inside range-loading or renderer callbacks. It updates derived detection fields
in place so the host may persist only processed truth. Hosts that need audit or
comparison views may instead retain separate raw and processed cold sources.
Browser workers receive only lightweight association projections; motion
predictions remain internal to the tracker, while masks and dense geometry
remain in semantic cold storage.

## Renderer Boundary

PixiJS is the first renderer backend, not the public architecture. The public
session API should expose media, detections, presentation, interaction, and
state. It should not expose Pixi containers, sprites, graphics objects, shader
instances, or textures.

Renderer layers should remain internally separated:

- media layer;
- box layer;
- mask layer;
- label layer;
- interaction and picking layer.

Each layer can use Pixi-specific implementation details, but orchestration
should flow through renderer-neutral contracts.

Renderer state/readout contracts that do not mention browser APIs belong to
core. Browser renderer construction, DOM containers, Mediabunny sources, Pixi
scene adapters, workers, and prepared-artifact implementation details belong to
`packages/web`.

## Media Boundary

Video presentation is push-based and engine-backed: the media source announces
every frame it puts on screen and the renderer composites it, with no pull loop
and no second clock. Mediabunny remains the adapter behind the `src` path,
media normalization and preparation, and browser `MediaStream` inputs, and the
session contract is shaped around neither engine's types.
[`video-engine-presentation.md`](video-engine-presentation.md) is the contract
for the push path and describes what the pull path still covers.

The session should expose normalized media status, playback state, canonical
frame timing, seek/step/rate controls, and current-frame refresh, not the media
adapter's internals. Navigation is latest-request-wins, and refresh reuses the retained
media presentation instead of decoding or uploading the frame again.

Browser media, renderer, worker, and storage adapters belong in
`packages/web`. Core should only model semantic contracts that are not tied to a
browser runtime.

A media adapter presents a zero-based presentation timeline. Media trimmed
through an edit list carries decodable samples ahead of presentation time zero;
the adapter drops them, presents the sample straddling zero at zero, and reports
`firstTimestamp` as the presentation start. Random access follows the same rule
as iteration: a seek that lands on pre-roll ending at or before zero falls
forward to the first visible sample rather than presenting a zero-duration
frame. A consumer should never have to clamp the public timeline or write its
own opener to get that.

Detection coordinate-space projection is a renderer pipeline step, not a session
convenience. The renderer knows the media dimensions before it builds its hot
detection timeline, so it wraps whatever detection source it was given --
static frames, a caller-owned source, or a composite -- in one projecting
source. Sessions may additionally normalize what they write so a persisted
dataset stays in one space; re-projecting an already-projected frame is a
no-op.

That wrapper also passes the target down through `DetectionFrameLoadOptions`,
because a source that flattens child frames destroys the metadata projection
needs. A composite carries one coordinate space but composes children that may
each have been inferred at a different size, so it projects every child while
that child's own `coordinateSpace` is still attached to its own detections. Any
source that returns its frames unchanged can ignore the option.

Media failures cross the boundary as a `MediaErrorKind` on
`MediaSourceState.errorKind` and as a `MediaSourceError` that preserves its
cause. The kind enum is a semantic contract and lives in core; classifying
vendor failures into it is the browser adapter's job, and every public media
source wraps what it throws at its own `open()` boundary. Applications branch on
the kind and own their localized copy; they should never have to match decoder,
demuxer, or container message text.

Additions to these public shapes stay structurally compatible. New members of an
already-published interface are optional, and a capability that must be
guaranteed gets a narrower interface the factory returns instead of being made
required on the published one.

Playback state must settle. `Buffering` means playback was requested and is
waiting for data, so `play()` may not treat it as a settled active run and a
seek taken while buffering must end in a valid playing or paused state.

A live media source may report renderer-neutral presented-frame metadata for
transport correlation. Media time is the only required field; everything the
browser may omit stays optional, and no DOM element or vendor object may cross
that boundary.

## State Contract

Session lifecycle enums, activity records, and the generic lifecycle-state shell
belong to core. Renderer-neutral state/readout payloads also belong to core.
Browser-specific media, normalization, render-preparation, and implementation
payloads belong to `packages/web`.

`MediaSessionState` is the browser-bound aggregate state model for consuming
apps. It should answer:

- Is the session loading, ready, playing, paused, buffering, processing,
  destroyed, or errored?
- Which activities are currently running or waiting?
- Which activities block playback or presentation?
- What renderer, media, normalization, detection-buffer, and render-preparation
  diagnostics are available?

State should be subscribable after creation. A caller should not need to wire
every renderer callback to understand whether the session is ready or waiting.

## Interaction Contract

Interaction should be library-owned and renderer-synchronized. Picking should
work from the active detection frame and prepared render artifacts, not from DOM
overlays or React state.

The public contract should eventually support:

- enabling/disabling interaction;
- picking boxes, masks, or both;
- hover and selection events;
- paused-only interaction for heavy video cases;
- detection identity and frame metadata in pick results.

## Implementation Guardrails

- Keep React out of the core library.
- Keep visual composition renderer-owned.
- Keep RLE as semantic cold storage.
- Keep ID masks and other prepared artifacts internal unless a future use
  case proves that they need to be public.
- Prefer one strong session API over many low-level public constructors.
- Add public extension points only after a second real pressure point appears.
- Make diagnostics useful, but do not require consumers to parse internals for
  common loading states.
