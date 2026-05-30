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

Status: planned.

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

### 3. Worker Pool And Backpressure

Status: planned.

Spec:

- Replace the single mask-preparation worker client with a small worker pool.
- Add a configurable concurrency limit.
- Prioritize active frame work, then nearby future frames, then farther frames.
- Cancel or ignore stale work after seeks or style changes.
- Preserve main-thread fallback when workers are unavailable.

Test:

- Multiple pending mask jobs are distributed across workers.
- Active frame jobs are scheduled before background jobs.
- Stale jobs do not install artifacts after generation changes.
- Main-thread fallback still works.

Manual observation:

- Dense videos should prepare future masks faster.
- CPU usage may rise, but the main UI should remain responsive.

### 4. Prepared-Artifact Playback Gate

Status: planned.

Spec:

- Add an optional playback gate that waits for a minimum prepared-artifact
  lookahead, similar to detection prediction buffering.
- Gate only on artifact kinds enabled by the current presentation.
- Keep media playback ungated by default unless the caller opts in.

Test:

- Playback waits when required active/lookahead artifacts are missing.
- Playback resumes when enough prepared artifacts are ready.
- Disabling masks or disabling the gate removes the wait condition.

Manual observation:

- With the gate enabled, playback may wait briefly before motion starts.
- Once playing, masks should feel less flickery because prepared frames are
  already available.

### 5. Future Mask Representation Research

Status: planned.

Spec:

- Compare full RGBA composited mask frames with an ID-mask plus shader palette
  path and a bounded mask atlas path.
- Preserve current RLE cold storage and prepared artifact boundary.
- Design for per-class color, opacity, borders, hover, and labels.
- Do not replace the current implementation until benchmarks show the pressure.

Test:

- Add a benchmark route or benchmark app mode that measures dense mask prep,
  texture upload, style changes, and playback smoothness.

Manual observation:

- The benchmark should make it clear when full-frame RGBA is enough and when we
  need ID masks or shaders.
