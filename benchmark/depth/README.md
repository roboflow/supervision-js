# Depth Map Benchmark

Two browser checks for the depth renderer.

```bash
npm run benchmark:depth:gpu        # exactness probe, headless Chrome over CDP
npm run benchmark:depth:gpu:dev    # the probe page, for any browser
node benchmark/depth/run-gpu.mjs --browser=firefox   # headless Firefox
npm run benchmark:depth:playback   # the docs playground, playing, in Chrome
```

**Exactness probe** (`run-gpu.mjs`, `gpu/`). Maps holding every 16-bit code
(256x256, and 1279 wide so WebGL pads rows) and every 8-bit preview code
(256 and 1279 wide, full and TV levels) go through the library's texture ring
(`packages/web/src/renderers/depth-textures.ts`) and depth shader
(`pixi-depth-shader.ts`) into a render texture on Pixi's WebGL and WebGPU
renderers, which is read back byte for byte (on WebGPU with
`copyTextureToBuffer`). The shader's output is 8 bits, so each draw colours a
window of 256 codes with an identity colour table; 256 draws show every code.
A pass means every code came back exactly and "no depth" was painted as such.
The runner writes `results/latest-gpu.{json,md}` (`latest-firefox` for
Firefox, which reports over the benchmark's dev server); `--query=backends=webgl`
narrows a run and `--port` moves the server off 5187. Safari is manual: start
the dev page, open `http://127.0.0.1:5187/benchmark/depth/gpu/index.html` and
copy the JSON it prints.

**Playback** (`run-playback.mjs`) drives the depth docs playground
(`?embed=depth`) on a demo dev server it starts (port 5195 by default,
`--port`), in headless Chrome over CDP or headless Firefox over WebDriver BiDi
(`--browser=firefox`). It plays both layers at 1x and 2x and checks, every
50 ms, that the depth drawn is the frame on screen's, that the exact frame
replaces the preview after a pause, that a seek and a drag never show another
frame's depth, and that the page never holds two preview decoders.
`--screens=<dir>` saves screenshots of each step. Build the packages first:
the demo runs the built package.

The measurements that settled the formats, budgets and decoder choices (PNG
decode cost, upload cost, preview decode speed, memory, gate holds at 8x)
are recorded in [`findings.md`](findings.md), [`findings.csv`](findings.csv)
and [`findings-preview.csv`](findings-preview.csv).
