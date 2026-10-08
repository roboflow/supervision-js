# Annotation antialiasing on real renderers

This optional harness compares annotation-only FXAA at normal and twice the output density with AA off. It uses the production filter and the demo's single selector: Off, FXAA and FXAA + 2×. Label backgrounds receive the shared filter; their text is rendered directly at output resolution.

Consecutive labels can share a background capture while their padded aggregate footprints remain disjoint. A possible overlap starts a new capture to preserve translucent blending and paint order. There are no label captures when backgrounds are absent; the worst case is one capture per visible label background. Capture containers are reused, and all runs share the production annotation filter. Text stays outside those captures.

The pixel harness uses the production ID-mask shader, focus-mask shader, box and label layers, path drawer and keypoint drawer. Its scene keeps labels outside the main capture and applies the shared filter to their backgrounds. A separate real-renderer label proof verifies unchanged glyph pixels and smoothed rounded backgrounds. A Vite-only export exposes the private focus factory; production exports are unchanged.

The output is 768×512 at resolution 1 on either real WebGPU or WebGL. The input categorical mask stays nearest sampled and unchanged. The modes render the exact same mask pixels, translucent fill, thin colored outlines, overlapping IDs, polygon paths, skeleton, keypoints, rotated rounded box, label and focus cutout. Mask preparation is fixed so these comparisons isolate the shared annotation filter.

Each mode saves transparent overlay pixels and their composition over a fixed background sprite outside the filtered container. The right strip is a high-frequency calibration image with no annotation; it must remain byte-identical. Additional checks cover exact off→on→off pixel parity, semantic mask bytes, absent detection colors and GPU/GL errors. Coverage statistics and error against a 4× output reference are recorded by region. That reference uses the same mask raster and vector inputs, so it measures output coverage without claiming to recover discarded mask contour detail. The label's text texture retains its original resolution.

`mask-border-probe.mjs` separately measures total CSS border widths 1–4 with Outside, Center and Inside alignment. A grid of red outlines and green fills is rendered at fit/zoom scales and output/capture densities 1/1, 1/2, 2/2 and 2/4. Sparse flat-edge samples must match independently intersected geometric intervals; integrated coverage, alignment centroids, opaque interior fill, categorical ID picking and Off restoration are checked too. The comparison scene supplies its actual capture density to the mask shader on every mode change, including the 4× reference.

Timing is three counterbalanced pairs per candidate, using batches of 24 complete scene renders after compilation/warmup and then waiting for GPU completion. It is **synchronized render + GPU-drain wall time**, including JS/Pixi submission. It is not an isolated GPU timestamp, CPU-utilization measurement, playback or scrub throughput, or a measurement of mask preparation.

Start only after the benchmark owner freezes the source and clears the shared browser boundary:

```sh
./node_modules/.bin/vite --config tools/annotation-aa/vite.config.mjs
```

Use the existing owned headed Chrome window at `http://127.0.0.1:5277/?backend=webgpu&run=1` or `?backend=webgl&run=1`. `&timings=0` collects functional pixels without timing batches. Never open a second window or use DPR emulation/headless rendering for this comparison. The report is exposed as `window.annotationAaReport`, and native PNGs plus JSON are saved under ignored `tools/annotation-aa/artifacts/`. Every report pins source/dependency bytes before and after the run.

The optional `run-owned.mjs` driver defaults to a read-only preflight. Running it requires an explicit reviewed full Git head, the current saved Chrome anchor, and ownership of its target/window. It records the actual native display DPR separately from the fixed output resolution, and never closes other tabs, creates a window, activates Chrome, changes display settings or silently recovers a stale target. Additional blank/new-tab pages require explicit `--allow-inert-tabs`; other pages can be accepted only for a pixel-only run with explicit owner approval.

Run its read-only preflight against the saved window before starting captures:

```sh
AA_HEAD=<full reviewed commit> \
CHROME_ANCHOR=<current chrome-session.json> \
AA_OUTPUT=<new output folder> \
node tools/annotation-aa/run-owned.mjs
```

Once the browser owner authorizes captures, add `--run`; add `--pixels-only` to omit timing batches. This driver accepts `--allow-inert-tabs` for extra blank/new-tab pages. Accepting additional nonblank pages requires both `--pixels-only --allow-extra-pages` and the owner's approval.

## Horse Trail cost and presentation check

`cost-driver.mjs` compares Off and FXAA + 2× in the demo's **Quality → Smooth annotation edges** control, using the same committed and built packages. It prepares files without touching Chrome by default; `--run` requires a clean committed checkout, a completed build, explicit ownership of the saved Chrome target/window, and an otherwise empty dedicated profile.

The compact plan is two counterbalanced off/on pairs for 1× playback, 8× playback, and the captured human timeline drag at output DPR 1. One additional 8× pair uses output DPR 2. This compact cost plan requires native monitor DPR 2, which is verified against the saved window anchor. Each playback window is eight seconds from the beginning of the clip; the recorded drag retains all delivered events and their original timing. Every window reopens the clip and parks the same start frame before measuring. No window is created, activated or resized; cleanup leaves the same owned target idle at `about:blank`.

```sh
AA_HEAD=<full reviewed commit> \
CHROME_ANCHOR=<current chrome-session.json> \
AA_NOTES=<notes/perf-continuation-2026-10-05> \
AA_OUTPUT=<new output folder> \
node tools/annotation-aa/cost-driver.mjs
```

Add `--run` only after the browser owner hands it back. `AA_DEMO_URL` defaults to `http://127.0.0.1:5278/?mediaPath=engine`. The preparation command prints source/build fingerprints and the schedule. Measurement additionally pins all compiled JS chunks, Pixi runtime modules, Horse fixtures, the historical observer, and the recorded human gesture/replay protocol before and after every window.

Timed windows collect Chrome process CPU time and summed resident memory (RSS), small renderer-clock/render-count/mask-stamp samples, and mask-cache diagnostics. RSS includes browser overhead and can count shared pages more than once; it is not exact VRAM. The mask stamp is renderer evidence rather than optical frame capture. No tracing, screenshots, pixel readbacks, profilers, GPU hooks or worker hooks run inside these CPU windows.

For a separate detailed off/on human-scrub pass, use a different output folder and add `--mask-evidence --run`. This reuses the previous post-submit GPU mask observer without modification; its hashes are part of the manifest. Masks drawn into the filtered overlay count as offscreen mask draws, so missing direct canvas draws alone do not count as missing masks. These instrumented records have no CPU/RAM claim. Their source-clock counts describe delivered presentations and do not treat deliberately skipped source frames at 8× as drops.
