# Library Contract

This document defines the current internal contract for `supervision-js` as a
library. It is not public README polish and it is not a final API promise. It is
the working agreement that keeps implementation moving toward a clean,
renderer-first package.

## Primary Primitive: Media Session

`MediaSession` is the main user-facing primitive. One media item maps to one
session.

A session owns:

- media preparation and optional normalization;
- renderer lifecycle;
- playback control;
- detection source wiring;
- cold detection storage and hot detection buffering;
- prepared render-window orchestration;
- presentation style updates;
- interaction and picking;
- aggregate loading, processing, and error state.

The host application owns application UI, API calls, and business workflows. It
can append detections, update presentation, seek, play, pause, subscribe to
state, and destroy the session. It should not need to know how detection chunks,
prepared mask artifacts, Pixi textures, or worker queues are internally wired.

## Public Data Model

The public data model should remain small and evidence-based:

- `DetectionFrame`: a media-time or frame-index keyed unit of detections.
- `Detection`: one model output with optional box, mask, class name,
  confidence, and metadata.
- `Rect`: the current rectangle shape used for boxes.
- `DetectionMask`: currently compressed RLE for semantic cold storage.
- style classes and style interfaces for boxes, masks, and labels.
- `DetectionFrameSource`: the read contract for loading detections by time.
- `WritableDetectionFrameSource`: the write contract for streaming detections
  into a session.

Prepared render artifacts are not public annotation data. PNG ID masks, RGBA
fallbacks, Pixi textures, palettes, and worker payloads are renderer-owned
runtime representations.

## Detection Pipeline

The package should preserve this pipeline:

1. **Cold detection source/store**
   Compact semantic data. It may live in IndexedDB, memory, static chunks, or a
   caller-owned source.
2. **Hot detection window**
   A small time window of parsed detection frames around playback.
3. **Prepared render window**
   Runtime-friendly artifacts derived from the hot window. For masks this is
   usually one prepared frame-level artifact, such as a PNG ID mask.
4. **Active render frame**
   The renderer presents media and overlays selected from the same media timing
   reference.

This keeps memory proportional to configured window size rather than media
duration.

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

## Media Boundary

Mediabunny is the first media engine. It should remain the default adapter for
reading, decoding, and normalizing media, but the session contract should not be
shaped around Mediabunny types.

The session should expose normalized media status and playback state, not
Mediabunny internals.

## State Contract

`MediaSessionState` is the aggregate state model for consuming apps. It should
answer:

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
- Keep PNG ID masks and other prepared artifacts internal unless a future use
  case proves that they need to be public.
- Prefer one strong session API over many low-level public constructors.
- Add public extension points only after a second real pressure point appears.
- Make diagnostics useful, but do not require consumers to parse internals for
  common loading states.
