# Render Preparation Performance Plan

## Goal

Make dense mask and polygon rendering feel smooth while keeping the renderer
truthful about what is ready, what is still being prepared, and what should
block playback or presentation. Those two geometries are the ones that have to
be rasterized before anything can draw them; the other annotation layers draw
from the detection data and have nothing to prepare.

## Context

`supervision-js` currently keeps raw detections in cold storage, hydrates a hot
detection window near playback time, and prepares mask render artifacts from
that hot window. A prepared mask artifact is one plane of pixels per detection
frame, which Pixi presents as a texture for the active frame. Checkpoint 5
records which plane that is.

The current diagnostics expose total pending and prepared artifact counts, but
they do not distinguish between:

- the active frame being missing or pending;
- background prefetch work that is still catching up;
- playback being truly blocked;
- presentation being incomplete but media still playing.

That distinction matters because a background worker being busy is useful debug
information, but it should not always cover the video viewport or imply the
current frame is wrong.

## Research Notes

- Pixi smoothness is most sensitive to per-frame main-thread work, GPU texture
  creation, and object churn. Prepared artifacts should be created ahead of the
  frame that will display them, and Pixi should mostly swap textures at playback
  time.
- Full-frame RGBA mask artifacts are simple and renderer-friendly, but expensive:
  a 1920 x 1080 frame is roughly 8 MB before GPU overhead. Larger prepared
  windows must be bounded and observable.
- Web workers help with CPU-heavy RLE decoding and compositing, but texture
  upload remains a renderer/GPU concern. Worker pools need backpressure, task
  priority, and cancellation after seeks.
- Hot detection windows and prepared render windows should roll forward
  continuously. If the hot detection window only jumps near its end, the
  prepared window discovers a large amount of new mask work at once and creates
  a queue cliff.
- More lookahead without bounded scheduling can make the queue worse. The
  scheduler should admit a small amount of background work each scan, always
  admit the active frame, and refuse far-future work when pending work is
  already saturated.
- Some applications should let media keep playing while artifacts catch up;
  others should gate playback until predictions and prepared artifacts are ready.
  The library should support both without conflating them.

## Checkpoints

### 1. Active-Frame-Aware Diagnostics

Status: complete.

Spec:

- Add render-preparation diagnostics for the active artifact frame.
- Keep aggregate pending/prepared artifact counts for background work.
- Add session activity metadata that distinguishes background preparation from
  active-frame presentation blocking.
- Update the demo viewport overlay to show render-preparation overlays only
  when the active frame is pending, not when background prefetch work is pending.

Test:

- `prepared-render-window` reports active frame status as pending, then prepared.
- `media-session-state` marks active pending artifacts as presentation-blocking.
- `media-session-state` keeps background-only pending artifacts non-blocking.

Manual observation:

- While basketball plays, the viewport should not be covered merely because the
  warm window is preparing future masks.
- If the active frame mask is not ready, the overlay may still appear briefly.
- The status panel should still show pending/prepared render-prep counts.

### 2. Prepared Window And Cache Controls

Status: complete.

Spec:

- Surface explicit options for mask prefetch frame count and prepared artifact
  cache size through the renderer/session render-preparation options.
- Keep conservative defaults for general use.
- Let the demo tune these values without changing source code.
- Record memory tradeoffs in diagnostics or docs.

Test:

- `prepared-render-window` honors configured prefetch and cache sizes.
- The demo/session wiring passes configuration through the public boundary.

Manual observation:

- Increasing the prepared window should reduce active-frame pending overlays.
- Very large values should increase memory use and may delay style changes.
- The basketball demo does not configure the mask prefetch window or cache
  size at all; it takes the library's file-mode session defaults, a 7s mask
  prefetch window and an 8s prepared mask cache, so we can test whether a
  larger ready-ahead window removes active-frame misses without changing
  package defaults.

### 3. Rolling Windows, Worker Pool, And Backpressure

Status: complete.

Spec:

- Refresh hot detection windows in smaller rolling increments instead of only
  near the end of the current loaded range.
- Bound pending mask-frame preparation work so background prefetch cannot grow
  unbounded.
- Schedule a small number of new background frames per scan instead of dumping
  the entire prepared window.
- Prioritize active frame work, then nearby future frames, then farther frames.
- Cancel or ignore stale work after seeks or style changes.
- Reset stale worker work when a style change invalidates mask artifacts.
- Replace the single mask-preparation worker client with a small worker pool.
- Add a configurable concurrency limit.
- Preserve main-thread fallback when workers are unavailable.

Test:

- Detection hot buffers can refresh continuously before reaching the end of the
  current range.
- Mask preparation respects max pending work and per-scan schedule limits.
- Style changes reset stale pending worker work.
- Multiple pending mask jobs are distributed across workers.
- Active frame jobs are scheduled before background jobs.
- Stale jobs do not install artifacts after generation changes.
- Main-thread fallback still works.

Manual observation:

- Pending masks should no longer grow without bound during normal basketball
  playback.
- The hot predictions timeline range should move more continuously instead of
  jumping only when playback is near the end of the current range.
- Style changes that invalidate mask pixels should recover quickly instead of
  waiting behind stale queued work.
- Dense videos should prepare future masks faster.
- CPU usage may rise, but the main UI should remain responsive.
- The demo requests no worker count, so it runs on the automatic default and
  exposes in-flight worker diagnostics so throughput can be observed directly.
- Automatic worker count uses a conservative browser-aware default: roughly half
  of `navigator.hardwareConcurrency`, capped at 4 workers. An explicit count is
  clamped to between 1 and 8 so callers can tune without creating runaway worker
  pools.

### 4. Prepared-Artifact Playback Gate

Status: shipped as an opt-in, off by default.

`RenderPreparationOptions.playbackGate` is the watermarked lookahead gate
specced here, and a session that never mentions it gets the gate off. Off, a
frame whose artifacts are not ready presents without those annotation layers,
which `media-renderer-core.test.ts` pins by name with "plays through render
preparation that never finishes". The prepared annotation window in
[`video-engine-presentation.md`](video-engine-presentation.md) is what keeps a
stale frame's annotations off that picture.

On, and on a media source the renderer pulls decoded samples from, the renderer
awaits the scene before presenting a sample and holds until the prepared window
leads the playhead by `requiredAheadSeconds`, which "buffers playback until
render preparation reaches the requested lookahead" pins by name. A source that
presents its own frames owns the playhead, so the gate is accepted and ignored
there, which is every session the video engine backs.

The work reaches the host as an activity either way. A `RenderPreparing`
activity sets `blockingPresentation` while the frame on screen waits for an
artifact, and never sets `blockingPlayback`: a gated hold surfaces separately,
as the `PlaybackBuffering` activity the buffering playback state raises.

### 5. Mask Representation

Status: shipped. The id raster is the default prepared mask artifact and the
RGBA composite is its fallback.

A prepared mask frame is an id raster, one byte per pixel naming the detection
that owns it, next to the fill and stroke palettes the shader reads. Both the
worker and the main-thread preparer build that raster first and answer with a
composited RGBA frame only when it cannot represent the frame, which is a
detection index at or past the 64-entry palette ceiling.
`mask-frame-preparer.test.ts` pins both answers by name with "builds ID-mask
rasters on the main thread" and "falls back to a composited RGBA frame past the
ID palette". Either artifact draws the same picture.

The raster is prepared at the width the picture can show rather than at media
width, so a 1080p mask on a smaller viewport carries display-resolution bytes.
Strokes ride the same raster and are drawn from the stroke palette, so a border
costs a shader test per pixel instead of a CPU contour pass. The RGBA fallback
still composites its borders.

The basketball fixture is what settled it, measured by `npm run benchmark:masks`
for CPU preparation and `npm run benchmark:masks:gpu` for upload and draw, with
the numbers in [`findings.md`](../../benchmark/masks/findings.md): a 5s prepared
window of full-frame RGBA artifacts at 1920 x 1080 is roughly 1.2 GB of raw
bytes, and the same window of id rasters is roughly 297 MB.

Still open:

- A per-class style change clears the prepared mask frames and prepares them
  again, because the palettes are written during preparation. Rewriting the
  palettes on the artifacts already in hand would make that restyle
  palette-sized. A style that names an `artifactKey` keeps its artifacts across
  a change, which is how the focus and halo cooks avoid re-preparation.
- The bounded mask atlas specced here was not built. The byte pressure the
  atlas was meant to relieve is what the id raster took out.
