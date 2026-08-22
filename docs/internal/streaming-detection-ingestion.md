# Streaming Detection Ingestion

This note captures the current direction for live or long-running prediction
ingestion. It is internal guidance, not a stable public API promise.

## Principle

The renderer should keep one stable detection source for a media session.
Prediction producers append or upsert `DetectionFrame` records into that source
as work completes. The renderer does not remount when new predictions arrive.

This keeps the same media clock, Pixi scene, cold store, and hot buffer alive
while inference streams in.

## Library Boundary

The library owns:

- `DetectionFrameSource` as the renderer-readable contract.
- cold detection storage for frames that should not all live in hot memory.
- writable detection ingestion for append/upsert workflows.
- prediction-coverage reporting, as `getAvailableRanges()` and the optional
  `waitForRange()` waiter, for callers that want to know what is covered.
- hot buffer refresh when a source version changes.

The demo owns:

- Roboflow API key collection.
- SAM3 request/response details.
- upload media preparation.
- browser-side frame extraction with Mediabunny.
- demo-server request coordination, throttling, and streamed inference results.

Do not put SAM3, Roboflow authentication, or model-specific response shapes in
the core package yet. Producers should normalize their output into
`DetectionFrame` records before handing data to the library.

## Current Model

For uploaded media, the demo prepares the media into a renderer-friendly profile,
creates one writable detection source, and extracts inference frames in batches
with Mediabunny in the browser. Batches are posted to the demo server over a
plain HTTP request whose response streams NDJSON events. This is not an SSE
session yet. The server fans out SAM3 requests with a fixed concurrency limit,
retries retryable per-frame failures, and streams completed frame results back
as they arrive. Each completed frame appends into cold storage. The writable
source records the time range touched by each append. The hot buffer checks the
version for its current window, so detections ingested elsewhere in the video do
not invalidate the visible buffered window. Writable sources also expose a
bounded change journal. When appended frames overlap the current hot window, the
timeline reloads and merges only those changed ranges instead of rebuilding the
complete window. If replacement, clearing, retention, or journal compaction
makes that incremental history incomplete, the timeline falls back to a full
window reload.

Cancellation is handled by aborting the active browser request. The demo server
observes the closed response and aborts in-flight Roboflow requests. A future
SSE/session design is still possible if we need reconnect/resume semantics, but
the current direction is intentionally simpler: browser-extracted batches,
server-side fan-out, and streamed HTTP responses.

Full replacement and clear operations still invalidate every range because
existing frame membership may have changed anywhere in the dataset.

## Bounded Retention

A rolling retention window used to be applied by reloading everything inside it
and writing it back with `putFrames`. That rewrote the retained window on every
append and invalidated every range, so a long-running stream paid for its whole
history each time a frame arrived.

`ColdDetectionFrameStore.pruneFrames` is the bounded path. A store that
implements it drops the frames ending before the retention floor in place, and
the writable source records that eviction as one more changed range next to the
appended range. The hot timeline then patches the two ranges that actually
moved. Stores that do not implement the hook keep the reload-and-replace
fallback, which stays correct and is what the browser IndexedDB store still
does today.

## Live Latest-Frame Semantics

A live producer only knows that its newest result is current. It learns that a
result stopped being current when the next one arrives, not before.
`appendLiveFrame` encodes exactly that: the newest frame is written with an
open-ended hold, and the previously held frame is rewritten to end where the new
one begins. Both frames keep their identity, so the store replaces rather than
accumulates, and each live append writes at most two frames regardless of how
much history is retained.

Leaving every frame open instead is what makes this expensive: overlapping
open-ended intervals pile up in the hot window, and each append reloads,
deep-copies, and re-sorts them all.

Two properties keep that encoding honest under a real transport:

- **Serialization.** Every live append reads the held frame before it awaits
  storage, so the source runs its mutating writes through one internal queue.
  Concurrent appends therefore apply in call order and only the newest stays
  open, instead of both observing the same pre-write state.
- **Latest-wins.** A result older than the newest accepted live frame is
  dropped. Reordered transports are normal, and writing a late result would
  reopen coverage the source already closed. A repeat of the held frame's
  identity is a revision and replaces it.

The hold is a placeholder for "still current", not a claim about covered data.
Retention therefore measures its window against the producer's real coverage
frontier. Anchoring it on the summary end time would push the retention floor
`holdSeconds` into the future and evict the frames the producer just wrote.

## Finalizing Coverage

A container can declare a duration slightly beyond its last decoded sample --
9.0 seconds for 89 frames at 10fps, for example. Coverage-gated playback then
waits forever for that terminal sliver at the loop boundary.
A source tracks its latest frame so it can finalize without scanning storage.
That tracking follows identity, not just ordering: a write that replaces or
revises the tracked frame's stored record replaces what is tracked, or
finalization would later write superseded detections back over the revision.

`finalizeCoverage(endTime)` sets the last retained frame's exclusive end to a
known end of media without reaching into store internals. It extends a finite
terminal frame, and it shortens a live frame that is still held open past the
end of media -- otherwise a stream that ends earlier than its hold would keep
reporting coverage that does not exist. Reported availability is clipped with
it. The operation is idempotent, so a producer can call it whenever it
finishes.

## Prediction-Gated Playback

A rolling retention window used to be applied by reloading everything inside it
and writing it back with `putFrames`. That rewrote the retained window on every
append and invalidated every range, so a long-running stream paid for its whole
history each time a frame arrived.

`ColdDetectionFrameStore.pruneFrames` is the bounded path. A store that
implements it drops the frames ending before the retention floor in place, and
the writable source records that eviction as one more changed range next to the
appended range. The hot timeline then patches the two ranges that actually
moved. Stores that do not implement the hook keep the reload-and-replace
fallback, which stays correct and is what the browser IndexedDB store still
does today.

## Live Latest-Frame Semantics

A live producer only knows that its newest result is current. It learns that a
result stopped being current when the next one arrives, not before.
`appendLiveFrame` encodes exactly that: the newest frame is written with an
open-ended hold, and the previously held frame is rewritten to end where the new
one begins. Both frames keep their identity, so the store replaces rather than
accumulates, and each live append writes at most two frames regardless of how
much history is retained.

Leaving every frame open instead is what makes this expensive: overlapping
open-ended intervals pile up in the hot window, and each append reloads,
deep-copies, and re-sorts them all.

Two properties keep that encoding honest under a real transport:

- **Serialization.** Every live append reads the held frame before it awaits
  storage, so the source runs its mutating writes through one internal queue.
  Concurrent appends therefore apply in call order and only the newest stays
  open, instead of both observing the same pre-write state.
- **Latest-wins.** A result older than the newest accepted live frame is
  dropped. Reordered transports are normal, and writing a late result would
  reopen coverage the source already closed. A repeat of the held frame's
  identity is a revision and replaces it.

The hold is a placeholder for "still current", not a claim about covered data.
Retention therefore measures its window against the producer's real coverage
frontier. Anchoring it on the summary end time would push the retention floor
`holdSeconds` into the future and evict the frames the producer just wrote.

## Finalizing Coverage

A container can declare a duration slightly beyond its last decoded sample --
9.0 seconds for 89 frames at 10fps, for example. The frames then stop short of
the end of media, and a caller reading availability sees a terminal sliver the
source will never cover.
A source tracks its latest frame so it can finalize without scanning storage.
That tracking follows identity, not just ordering: a write that replaces or
revises the tracked frame's stored record replaces what is tracked, or
finalization would later write superseded detections back over the revision.

`finalizeCoverage(endTime)` sets the last retained frame's exclusive end to a
known end of media without reaching into store internals. It extends a finite
terminal frame, and it shortens a live frame that is still held open past the
end of media -- otherwise a stream that ends earlier than its hold would keep
reporting coverage that does not exist. Reported availability is clipped with
it. The operation is idempotent, so a producer can call it whenever it
finishes.

## Prediction Coverage

Missing predictions are not treated as missing media. Playback never awaits
prediction coverage: `detections.playbackGate` is accepted and ignored, and a
frame the ingested ranges do not cover presents without annotations rather than
holding the picture. `DetectionFrameSource.waitForRange()` says so in its own
TSDoc: "Playback never awaits it. A caller that wants to wait awaits it itself."

The writable source still tracks appended time ranges and exposes that waiter,
so an app that genuinely wants to hold playback until a range lands awaits
`waitForRange()` on `MediaSession.detectionSource` and pauses itself. That
decision belongs to the app. A demo that only wants to show progress should
read `getAvailableRanges()` and render it rather than running a pause/play loop.

## Image Handling

Images must still be rendered inside the Pixi-owned composition path. The demo
currently treats an uploaded image as a one-frame media source so image and video
share the same renderer, detection source, style controls, and synchronization
logic.
