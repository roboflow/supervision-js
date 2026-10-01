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
npm run benchmark:depth:playback   # the docs playground, playing, in Chrome
```

The Chrome runner writes `results/latest-gpu.{json,md}`; the Firefox runner
writes `results/latest-firefox.{json,md}`. Set `CHROME_BIN` or `FIREFOX_BIN`
when the browser is not at its default macOS path. `--query=cases=exactness`
(or `decode`, `upload`, `memory`, comma-separated), `backends=webgl` and
`resolutions=1080p` narrow a run, and `--port` moves the benchmark server off 5187. Firefox has no CDP, so its page PUTs the result to the benchmark's dev
server (`?report=firefox`).

Cases 4 and 6 decode the Spring fixture's 720p preview video
(`demo/fixtures/spring_stereo_depth/sgbm/preview.mp4`, from Git LFS) and two
resizes of it that the runner writes into `results/` with ffmpeg, using the
producer's encoder settings. Without ffmpeg those rows are skipped.

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
- **Case 4, preview decode.** The library's once-per-page probe of every
  decoder the browser offers, at TV and full levels: does each return the
  preview codes as written, directly or through the probe's table? Then
  every frame of a 192-frame preview at 720p, 1080p and 4K decoded back to
  back through the library's reader, with frames copied in
  the render-preparation worker (the session's way) or on the page, timing
  decode speed and the main thread's share per frame.
- **Codes (`cases=codes`).** The same probe, then the first second of the
  Spring SGBM preview through each decoder with its own probe's table,
  compared pixel for pixel with ffmpeg's luma of the same frames, which the
  runner writes to `results/preview-720p-luma.gray`.
- **Case 5, memory** at the library's default budgets, which scale with the
  clip's resolution, computed from the formats.
- **Case 6, playback with the gate, and seeking.** Each preview played at 1x,
  2x and 8x against the library's preview window with the session's default
  gate, each animation frame drawn through the texture ring and depth shader
  with the upload in the present or done ahead: gate holds, presents
  without depth, present time; then the time from a seek to its preview.

`run-playback.mjs` drives the real thing: the depth docs playground
(`?embed=depth`) on the demo's dev server (port 5195 by default, `--port`),
in headless Chrome over CDP or headless Firefox over WebDriver BiDi
(`--browser=firefox`). It plays both layers at 1x and 2x and checks, every
50 ms, that the depth drawn is the frame on screen's and a preview while
playing, that the exact frame replaces it after a pause, that a seek and a
drag never show another frame's depth, and that the page never holds two
preview decoders. It also compares one preview frame with the exact frames
around it, and its codes with the codes the producer wrote. `--screens=<dir>`
saves screenshots of each step. Build the packages first: the demo runs the
built package.

`run-android-decoders.mjs` opens the same playground, at phone size, with the
page's `VideoDecoder` made to misbehave the ways a phone's can:
`prefer-software` H.264 reported unsupported, and frames held back until
`flush()` (`android`), or never returned at all with a `flush()` that never
settles (`silent`). It checks that the video comes up and plays without
waiting for depth, that preview depth plays wherever a decoder can play it,
that exact depth shows at rest, and that the page says why when the preview
is off. It serves nothing: build the packages and the demo, serve
`demo/dist` (`npm run preview -w demo`), and pass that page as `--url`.
`--throttle=<kbps>` slows the page's network and lists when each depth file
and lazy chunk was fetched, and how much of it.

Timing numbers are local-machine measurements; the report records the host's
load average, and numbers taken on a busy machine are not comparable. The
exactness verdicts are not timings and hold regardless.

Tracked summary findings live in [`findings.md`](findings.md),
[`findings.csv`](findings.csv) (cases 1 to 3) and
[`findings-preview.csv`](findings-preview.csv) (cases 4 and 6). Regenerate the
local detailed report before updating those files.
