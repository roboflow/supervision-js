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
not invalidate the visible buffered window.

Cancellation is handled by aborting the active browser request. The demo server
observes the closed response and aborts in-flight Roboflow requests. A future
SSE/session design is still possible if we need reconnect/resume semantics, but
the current direction is intentionally simpler: browser-extracted batches,
server-side fan-out, and streamed HTTP responses.

Full replacement and clear operations still invalidate every range because
existing frame membership may have changed anywhere in the dataset.

## Image Handling

Images must still be rendered inside the Pixi-owned composition path. The demo
currently treats an uploaded image as a one-frame media source so image and video
share the same renderer, detection source, style controls, and synchronization
logic.
