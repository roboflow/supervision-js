# Milestone 3 Dense Shape Measurement

## What This Proves

This milestone adds a repeatable proof-only benchmark workspace for dense simple
rectangles inside a Pixi-owned media scene. It measures the current renderer
pressure from many simple rectangle outlines before the project designs
annotation abstractions, without adding benchmark code to the package runtime or
normal demo.

This is a benchmark and measurement proof. It is not an annotation API, not a
`BoundingBox` model, not a primitive hierarchy, and not performance target
setting. The goal is to collect constraints from the renderer before deciding
what an annotation model should look like.

## Benchmark Workspace

The benchmark lives in [`../../benchmark/initial`](../../benchmark/initial) as a
separate Vite workspace. It imports `pixi.js` and `mediabunny` directly and owns
its benchmark-specific renderer implementation. The package entrypoint and
normal React demo stay focused on the Milestone 1/2 renderer proof.

The benchmark renderer generates deterministic rectangles in media pixel
coordinates once after decoded media dimensions are known. It can draw those
rectangles with the original single Pixi `Graphics` path or with a proof-only
`particle-edges` candidate that turns each rectangle outline into four
`Texture.WHITE` particles in a `ParticleContainer`. Both render inside the same
media-coordinate Pixi scene as the decoded media texture and the timestamped
proof overlay rectangles.

`particle-edges` exists only to compare a batched box-like outline approach
against `Graphics` at high counts. It is not a committed public rendering
abstraction, not an annotation primitive, and not a promise that future boxes
will be represented as particles.

The proof supports comparable benchmark modes:

- benchmark off / media-only: render decoded media and synchronized proof
  overlays without dense generated rectangles, while still recording renderer
  frame timing and FPS diagnostics.
- `static`: draw the generated rectangles once after setup.
- `static-cached`: draw the generated rectangles once after setup, then cache
  the benchmark `Graphics` as a Pixi texture for a proof-level comparison of a
  static dense layer.
- `redraw-each-frame`: redraw the generated rectangles only when a newly
  presented decoded video sample advances.

The benchmark app includes a rough count sweep runner. It records a media-only
baseline and then sweeps a small set of rectangle counts across `graphics` and
`particle-edges`, including `static` and `redraw-each-frame` for both
strategies. The `graphics` sweep also includes `static-cached` to keep the cache
comparison visible. Trial durations are intentionally modest so a local browser
run can finish in about a minute or less.

Text is intentionally disabled in this milestone and reported as
`textEnabled: false`. Labels, masks, tracks, keypoints, workers, WebGPU, custom
shaders, culling, object pools, and serialization are still outside this
milestone.

The current interpretation is intentionally cautious: poor FPS with many shapes
in `redraw-each-frame` does not automatically mean JavaScript shape redraw is
the dominant bottleneck. The measured redraw/update cost may be small even when
overall FPS is poor, so the benchmark distinguishes media-only, static,
static-cached, and redraw-each-frame modes to isolate media decode, texture
upload, Pixi rendering, and per-sample redraw pressure.

Render strategy conclusions from the current local measurements are summarized
in [`render-strategy-guidelines.md`](render-strategy-guidelines.md). Keep those
conclusions internal and proof-level; they are meant to guide the next
rectangle feature, not to establish public performance claims or final APIs.

The hard renderer constraint remains unchanged while measuring these modes:
Mediabunny owns media reading, decode, and decoded sample timestamps; Pixi owns
the single composed scene for media, synchronized overlays, and benchmark
rectangles inside `/benchmark/initial`; selected overlay state follows decoded
media sample timestamps as the one source of truth for time. Do not introduce a
DOM `<video>`, DOM overlays, React-owned rendering, Pixi `VideoSource`, or an
independent application clock for this proof.

## Diagnostics

The benchmark app reports the repeatable dimensions a human should record
during a run:

- browser and version;
- device and display notes;
- Pixi backend preference, currently `webgl`;
- render strategy, currently `graphics` or `particle-edges`;
- shape count;
- rendered primitive count, where `graphics` reports rectangles and
  `particle-edges` reports edge particles;
- update strategy;
- cache enabled/applied state;
- frame time average, min, max, p95, p99, or FPS from the benchmark
  diagnostics;
- frame sample count and frame timing quality;
- last sample request, media draw, texture upload, and present/update costs;
- last rectangle redraw/update cost in milliseconds;
- text on/off, currently off.

Frame timing diagnostics skip the first finite Pixi ticker elapsed sample for
each proof renderer instance. That first sample can include setup or navigation
transition time, so the frame average and percentile fields represent
steady-state rendering when the browser is foreground-like and enough ticker
samples are available. The benchmark app labels frame timing as `insufficient`
when the sample count is too low and `throttled` when frame average or p95 is
clearly background-limited. In throttled or background browser runs, do not use
frame average, p95, or p99 as comparison signals. Use present/update and
rectangle redraw costs as the primary automated-run signal, with sample request,
media draw, and texture upload costs as supporting diagnostics. Setup, redraw,
sample request, media draw, texture upload, and present/update costs are still
reported separately.

Actual numbers vary by browser, device, GPU, display refresh rate, and other
local load. Do not fabricate benchmark results in this document. During a run,
copy the dimensions above from the demo readouts and add any visible bottleneck
notes such as stutter, decode errors, or resize behavior.

## First Repeatable Run Template

Use this template when recording a local run:

- Browser:
- Device notes:
- Backend/preference: `webgl`
- Shape count:
- Render strategy:
- Rendered primitive count:
- Update strategy:
- Cache enabled/applied:
- Text enabled: `false`
- Frame sample count / quality:
- Frame time / FPS:
- Frame min/max/p95/p99:
- Sample request / media draw / texture upload / present cost:
- Last redraw/update cost:
- Notes:

## Done Criteria

- The package runtime entrypoint and normal demo do not expose benchmark
  options, diagnostics, or dense-shape render paths.
- Benchmark options and diagnostics live under `/benchmark/initial`.
- Generated rectangles are deterministic for the same media dimensions and
  shape count.
- Benchmark rectangles render inside the benchmark Pixi scene rather than React
  or DOM.
- Static mode draws once after setup.
- Static-cached mode draws once after setup and reports whether the proof cache
  was enabled and applied for the `graphics` strategy.
- Redraw-each-frame mode redraws only for newly presented decoded samples.
- Diagnostics expose enough data for a human to repeat and record a local
  measurement, including frame distribution, rendered primitive count, and
  sample/media/upload/present costs.
