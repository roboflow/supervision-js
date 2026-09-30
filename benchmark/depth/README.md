# Depth Map Benchmark

Browser benchmark for the depth renderer: whether 16-bit depth reaches the
shader exactly, what a 16-bit PNG costs to decode, and what a depth map costs
to upload and draw. It drives the library's own code: the PNG decoder
(`packages/web/src/render-preparation/depth-png16.ts`), the texture ring
(`depth-textures.ts`) and the depth shader (`pixi-depth-shader.ts`), on Pixi
apps created with `preference: "webgl"` and `preference: "webgpu"`.

The data is a synthetic stereo scene ray cast in the page
(`gpu/src/synthetic-stereo.ts`): a room with objects, occlusion holes, flying
pixels and matcher-like noise. It is not model output, and nothing is loaded
from `demo/fixtures`.

Run from the repo root:

```bash
npm run benchmark:depth:gpu        # headless Chrome over CDP
npm run benchmark:depth:gpu:dev    # the page, for any browser
node benchmark/depth/run-gpu.mjs --browser=firefox   # headless Firefox
```

The Chrome runner writes `results/latest-gpu.{json,md}`; the Firefox runner
writes `results/latest-firefox.{json,md}`. Set `CHROME_BIN` or `FIREFOX_BIN`
when the browser is not at its default macOS path. `--query=cases=exactness`
(or `decode`, `upload`, `memory`, comma-separated), `backends=webgl` and
`resolutions=1080p` narrow a run. Firefox has no CDP, so its page PUTs the
result to the benchmark's dev server (`?report=firefox`).

Safari is a manual run: start `npm run benchmark:depth:gpu:dev`, open
`http://127.0.0.1:5187/benchmark/depth/gpu/index.html` in Safari, and copy the
JSON the page prints.

## Cases

- **Case 1, exactness probe.** Maps holding every 16-bit code (256x256, and 1279
  wide so WebGL pads rows) and every 8-bit preview code (256 and 1279 wide)
  go through the texture ring and the depth shader into a render texture,
  which is read back byte for byte (on WebGPU with `copyTextureToBuffer`, not
  Pixi's canvas-based extract). The shader's output is 8 bits, so each draw
  colours a window of 256 codes with an identity colour table; 256 draws show
  every code. A pass means every code came back exactly and "no depth" was
  painted as such.
- **Case 2, PNG16 decode** at 720p, 1080p and 4K, one file per PNG row filter, on the
  main thread and in a worker. `adaptive` is libpng's default per-row choice;
  `paeth-up-mix` is the mix Pillow wrote for the research scene. The research
  prototype's decoder and a row-delta + gzip file of the same samples are
  decoded as references.
- **Case 3, upload and render** per frame at each resolution, exact (`rg8`, 2 bytes
  per sample) and preview (`r8`, 1 byte), with the upload in the present and
  uploaded ahead, and a half-size map drawn edge-aware. The GPU is waited on
  after every present.
- **Case 5, memory** at the build plan's proposed default budgets, computed from the
  formats.

Cases 4 (preview-track decode) and 6 (seek to exact frame) arrive with the
preview track and clip frames.

Timing numbers are local-machine measurements; the report records the host's
load average, and numbers taken on a busy machine are not comparable. The
exactness verdicts are not timings and hold regardless.

Tracked summary findings live in [`findings.md`](findings.md) and
[`findings.csv`](findings.csv). Regenerate the local detailed report before
updating those files.
