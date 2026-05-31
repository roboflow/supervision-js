# Render Preparation Performance Plan

## Goal

Make dense mask and annotation rendering feel smooth while keeping the renderer
truthful about what is ready, what is still being prepared, and what should
block playback or presentation.

## Context

`supervision-js` currently keeps raw detections in cold storage, hydrates a hot
detection window near playback time, and prepares mask render artifacts from
that hot window. A prepared mask artifact is one composited image-like object per
detection frame. Pixi then presents that artifact as a texture for the active
frame.

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
- The basketball demo currently uses a 5s mask prefetch window and a 5s
  prepared mask cache, derived from the fixture inference frame rate, so we can
  test whether a larger ready-ahead window removes active-frame misses without
  changing package defaults.

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
- The basketball demo currently uses a 4-worker mask-preparation pool and
  exposes in-flight worker diagnostics so throughput can be observed directly.
- Automatic worker count uses a conservative browser-aware default: roughly half
  of `navigator.hardwareConcurrency`, capped at 4 workers. Explicit worker
  counts are clamped to a small safe range so callers can tune without creating
  runaway worker pools.

### 4. Prepared-Artifact Playback Gate

Status: implemented.

Spec:

- Add an optional playback gate that waits for a minimum prepared-artifact
  lookahead, similar to detection prediction buffering.
- Use high/low watermarks so playback does not wait a tiny amount before every
  frame. Below the low watermark, the gate buffers back up to the requested
  lookahead.
- Gate only on artifact kinds enabled by the current presentation.
- Keep media playback ungated by default unless the caller opts in.
- Keep the renderer core generic: it asks the scene to wait for render
  preparation, while Pixi masks are the only current prepared artifact behind
  that boundary.

Test:

- Playback waits when required active/lookahead artifacts are missing.
- Playback resumes when enough prepared artifacts are ready.
- Disabling masks or disabling the gate removes the wait condition.

Manual observation:

- With the gate enabled, playback may wait briefly before motion starts.
- Once playing, masks should feel less flickery because prepared frames are
  already available.
- The demo enables a 1s render-preparation playback gate for the basketball and
  upload flows with a 0.25s low watermark so this can be exercised without
  turning playback into a continuous speed governor.

### 5. Future Mask Representation Research

Status: baseline benchmark added.

Spec:

- Compare full RGBA composited mask frames with an ID-mask plus shader palette
  path and a bounded mask atlas path.
- Preserve current RLE cold storage and prepared artifact boundary.
- Design for per-class color, opacity, borders, hover, and labels.
- Do not replace the current implementation until benchmarks show the pressure.
- Run `npm run benchmark:masks` to benchmark the basketball SAM3 fixture without
  involving the demo UI.

Test:

- Programmatically measure current RGBA artifact preparation, RGBA artifact
  preparation with mask borders, and an ID-mask candidate.
- Report source fixture bytes, RLE payload bytes, prepared artifact bytes,
  projected prepared-window byte pressure, and local CPU preparation timings.
- Treat GPU upload/render timings as a separate browser/GPU follow-up because
  the current Node benchmark estimates upload bytes but does not exercise Pixi
  or the GPU.

Current takeaway:

- Current RGBA mask artifacts remain the stable implementation path because they
  are simple and already work.
- The basketball fixture shows full-frame RGBA artifacts are byte-heavy: a 5s
  prepared window is roughly 1.2 GB of raw RGBA artifact bytes at 1920 x 1080.
- The ID-mask candidate cuts that same 5s window to roughly 297 MB and makes
  per-class style updates palette-sized instead of prepared-window-sized.
- CPU mask borders are expensive enough that future border styling should move
  toward an ID-mask/shader path rather than thicker CPU contour preparation.
