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
