# Render Strategy Guidelines

This is internal, proof-level guidance from the Milestone 3 dense shape
benchmark. It is not a public performance claim, not a final renderer API, and
not a universal target. The numbers below are local evidence from one browser
and machine run, useful for choosing the next implementation path.

## Current Recommendation

Build the first real `BoundingBox` or rectangle feature on the Pixi `Graphics`
path. Use dirty redraws keyed by decoded media annotation frame changes: when
the selected annotation frame for the current decoded media sample changes,
redraw the rectangle layer; when it does not change, keep the existing graphics.

Do not route the hot path through React state or DOM overlays. Keep media and
annotations in one Pixi-owned scene, with Mediabunny decoded sample timestamps
as the source of truth for synchronized annotation state.

## Local Evidence

The current recommendation is based on stable per-sample present/redraw costs
and earlier foreground-like frame runs. Automated Codex in-app browser runs may
throttle Pixi ticker/frame statistics to around `1000ms`; when the demo labels
frame timing as `throttled` or `insufficient`, ignore frame avg/p95/p99 for
strategy comparison and use present/redraw costs instead.

Recent automated Codex browser sweeps still produced stable per-sample costs:

- `graphics` redraw at `6000` boxes reported present/redraw near
  `5.9ms` / `5.6ms`.
- `graphics` redraw at `12000` boxes reported present/redraw near
  `10.0ms` / `9.8ms`.
- `graphics` redraw at `24000` boxes reported present/redraw near
  `20.6ms` / `20.4ms`.
- `particle-edges` redraw at `12000` boxes reported present/redraw near
  `19.0ms` / `18.8ms`.
- `particle-edges` redraw at `24000` boxes reported present/redraw near
  `40.6ms` / `40.4ms`.
- Static `graphics` at `24000` boxes reported present near `0.1ms` after a
  one-time redraw around `22.4ms`.
- `static-cached` `graphics` at `24000` boxes reported present near `0.2ms`
  after one-time setup around `19.5ms`.

The earlier foreground-like built-in sweep showed dynamic `Graphics` redraws
staying reasonable through about `6000` boxes on this run. Around `12000`
boxes, the dynamic path started showing risk in the tail frame timings. Around
`24000` boxes and above, dynamic redraws were clearly too expensive for this
local setup.

The stress run reinforced that split:

- `graphics` redraw at `12000` boxes averaged about `9.6ms`, with p95 around
  `16.7ms` and p99 around `25.0ms`.
- `graphics` redraw at `24000` boxes averaged about `13.5ms`, with p95 around
  `41.7ms` and p99 around `49.7ms`.
- `graphics` redraw at `48000` boxes averaged about `31.9ms`, with p95 around
  `100.2ms` and p99 around `118.1ms`.
- Static `graphics` at `48000` boxes stayed near the media-only frame profile
  after a one-time draw cost of about `39.9ms`.
- `static-cached` `graphics` at `48000` boxes also stayed near the media-only
  frame profile after a one-time draw and cache setup cost of about `41.9ms`.

Media-only and static dense layers stayed near the same frame profile in these
runs, which points to per-sample dynamic redraw pressure as the main concern for
dense changing rectangles.

## Strategy Notes

Keep a prepared render window between the hot detection window and Pixi scene
objects. Cold detections should stay semantic, while the prepared window builds
renderer-friendly artifacts for a small set of nearby frames. The first concrete
artifact is a composited mask canvas per detection frame, which Pixi can upload
once and present as a single sprite. Future artifacts may include grouped box
draw instructions, text layout/cache entries, track paths, heatmaps, or custom
geometry.

Do not assume every prepared artifact should be an image. Masks and heatmaps
fit texture artifacts well; boxes often fit grouped `Graphics` instructions
better until measured pressure says otherwise. The common rule is to move
expensive decode, style resolution, sorting, and grouping out of the per-sample
presentation path.

Static dense layers can use `Graphics`. Use `static-cached` when the layer is
complex and rarely changes, but avoid repeated recaching. Treat recache as a
costly redraw plus texture update, not as a cheap per-frame optimization.

The naive `particle-edges` benchmark is not the default box renderer. It is a
useful proof of a batched draw direction, but it currently loses for dynamic
boxes because each box becomes four elements and the benchmark repopulates the
particles on redraw. In the observed stress run, `particle-edges` reached
`192000` edge elements for `48000` boxes and paid a much larger per-redraw cost
than `Graphics`.

If future real workloads need dynamic counts beyond the local `Graphics`
comfort zone, the next candidate should be pooled and reused particles or a
custom mesh or instanced renderer. Do not respond to dense dynamic pressure by
moving boxes into React or DOM overlays.

## Hard Constraints

- Mediabunny owns media reading, decode, and decoded sample timestamps.
- Pixi owns one composed scene for media, synchronized overlays, and future
  rectangle annotations. Benchmark layers live in `/benchmark/initial`, not the
  package renderer.
- The renderer presents one canvas and does not create visible DOM media or DOM
  annotation layers.
- Annotation state follows decoded media sample timing, not an independent app
  clock.
- `48000` boxes remains a manual stress case, not part of the normal benchmark
  sweep.
