# Mask Artifact Benchmark

Programmatic benchmark for mask rendering strategy decisions.

This benchmark consumes the deterministic basketball SAM3 fixture and measures
CPU artifact preparation cost plus transfer/upload-size pressure for:

- current RGBA composited mask artifacts;
- current RGBA composited mask artifacts with mask borders;
- an ID-mask artifact candidate for future shader/palette styling;
- frame-level grayscale PNG ID-mask artifacts at fast and normal compression
  levels;
- browser/Pixi upload, decode, palette shader, and border shader costs for
  PNG ID-mask artifacts.

Run from the repo root:

```bash
npm run benchmark:masks
npm run benchmark:masks:gpu
```

The CPU preparation benchmark writes `latest.json` and `latest.md` to
`benchmark/masks/results/`. The browser/Pixi GPU benchmark writes
`latest-gpu.json` and `latest-gpu.md` to the same directory. The GPU runner
launches an isolated headless Chrome; set `CHROME_BIN` if Chrome is not at the
default macOS path.

Timing numbers are local-machine measurements; bytes and fixture stats are
stable for the checked-in fixture.

Tracked summary findings live in [`findings.md`](findings.md) and
[`findings.csv`](findings.csv). Regenerate the local detailed report before
updating those files.

## Detection-order session regression

After `npm run build`, exercise the public media session with independent mask
ordering on real WebGL and WebGPU scenes:

```bash
node benchmark/masks/run-gpu.mjs --order
node benchmark/masks/run-gpu.mjs --order --webgpu
```

The regression uses frozen lossless video and synthetic masks, boxes and
polygons. It checks pixel composition and DOM pointer picks across reordering,
opacity, timed styles, holes, outline alignment, zoom, hide/show, source-size
changes, duplicate and mixed-type IDs, and detection indexes beyond 255.
Translucent explicit-unit outlines are compared with dense-renderer controls.
It also checks stable active resources through repeated updates and immediate
retirement of mask textures and allocated UBO buffers as video coverage changes
and sessions are destroyed.
The runner writes `latest-order-webgl.json` or `latest-order-webgpu.json` to
`benchmark/masks/results/`. These resource payload counts do not measure
browser or GPU-driver overhead.
