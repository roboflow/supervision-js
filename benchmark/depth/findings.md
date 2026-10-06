# Depth Map Benchmark Findings

Measured on 2026-09-30 with `npm run benchmark:depth:gpu` (Chrome) and
`node benchmark/depth/run-gpu.mjs --browser=firefox`, and the exactness probe
by hand in the Claude desktop app's browser pane.

- Machine: Apple M3 Max, 16 cores, macOS 15.7.
- Browsers: HeadlessChrome 154 (Pixi WebGL on ANGLE Metal, and Pixi WebGPU
  on Metal); headless Firefox 155 (Pixi WebGL; WebGPU's `navigator.gpu` is
  present but grants no adapter headless, so Pixi falls back to WebGL);
  Claude desktop 2.16120 (Chrome 152) for the probe.
- Host load average during the timed runs was 25 to 36 on 16 cores, from
  other work on the machine. Timings are medians of 15 runs (9 at 4K) for
  decode and 30 presents for upload and render; treat differences under
  about 10 % as noise.
- Data: a synthetic stereo scene generated in the page, not model output.
  Disparity is stored x256 (x128 at 4K). Its PNGs are 1.0, 2.3 and 9.2 MB at
  720p, 1080p and 4K, a little larger than research 07's scene v2 (2.0 MB at
  1080p, 7.3 MB at 4K).
- Cases 4 and 6 (preview video, playback): the Spring fixture's 192-frame,
  24 fps SGBM preview at 720p (2.5 MB), and the runner's nearest-neighbour
  resizes of it to 1080p (3.9 MB) and 4K (6.5 MB), encoded with the
  producer's settings. Resized depth is smoother than a real 4K map would
  be, so its decode is cheaper; read the 1080p and 4K rows as a lower bound.
  Measured later the same day, load average 29 to 41.

## 1. Exactness: every code arrives exactly

Every 16-bit code (0 to 65,535, as `rg8`) and every 8-bit preview code (as
`r8`) came back exactly through the library's texture ring and depth shader,
colour path included, on every backend the browsers offered. Odd widths
(1279) were padded to 1280 on WebGL and uploaded unpadded on WebGPU, and
matched too.

| Browser                     | Backend               | rg8, 256x256                 | rg8, 1279 wide | r8, 256 wide | r8, 1279 wide |
| --------------------------- | --------------------- | ---------------------------- | -------------- | ------------ | ------------- |
| HeadlessChrome 154          | WebGL 2 (ANGLE Metal) | pass                         | pass           | pass         | pass          |
| HeadlessChrome 154          | WebGPU (Metal)        | pass                         | pass           | pass         | pass          |
| Claude desktop (Chrome 152) | WebGL 2               | pass                         | pass           | pass         | pass          |
| Claude desktop (Chrome 152) | WebGPU                | pass                         | pass           | pass         | pass          |
| Firefox 155, headless       | WebGL 2               | pass                         | pass           | pass         | pass          |
| Firefox 155, headless       | WebGPU                | not run: no adapter headless |                |              |               |
| Safari                      | both                  | not run: manual              |                |              |               |

The `rg8unorm` choice holds: no backend rounds unorm bytes on the way.

Pixi's WebGPU device keeps the default 8192 texture limit (the M3 Max
adapter offers 16384, checked in the Claude pane), and Firefox's WebGL
reports 8192, so a map wider than 8192
goes up decimated there.

## 2. PNG16 decode

`up`, `sub`, `none`, `average` and `paeth` put one filter on every row;
`paeth-up-mix` is two Paeth rows to one Up row, the mix Pillow wrote for the
research scene; `adaptive` is libpng's per-row heuristic (on this scene it
picks mostly Average and Up). "Prototype decoder" is research 08's
`png16.js` on the same file; the benchmark no longer runs it, so a rerun
has no prototype rows. The worker column is the round trip: post the
bytes, decode, transfer the samples back.

| Resolution | File                                   |     Size | Chrome main | Chrome worker | Firefox main | Firefox worker |
| ---------- | -------------------------------------- | -------: | ----------: | ------------: | -----------: | -------------: |
| 720p       | PNG16, up                              |  1.02 MB |     6.45 ms |       6.52 ms |      6.56 ms |        6.70 ms |
| 720p       | PNG16, up, prototype decoder           |  1.02 MB |     10.1 ms |             - |      10.2 ms |              - |
| 720p       | PNG16, sub                             |  1.01 MB |     6.05 ms |       6.11 ms |      6.30 ms |        6.34 ms |
| 720p       | PNG16, none                            |  1.15 MB |     5.92 ms |       6.06 ms |      6.02 ms |        6.10 ms |
| 720p       | PNG16, average                         |  1.03 MB |     6.27 ms |       6.32 ms |      6.54 ms |        6.74 ms |
| 720p       | PNG16, paeth                           |  1.02 MB |     10.7 ms |       11.0 ms |      14.3 ms |        14.6 ms |
| 720p       | PNG16, paeth, prototype decoder        |  1.02 MB |     15.0 ms |             - |      15.1 ms |              - |
| 720p       | PNG16, paeth-up-mix                    |  1.02 MB |     9.19 ms |       9.43 ms |      11.8 ms |        11.9 ms |
| 720p       | PNG16, paeth-up-mix, prototype decoder |  1.02 MB |     13.7 ms |             - |      13.4 ms |              - |
| 720p       | PNG16, adaptive                        |  1.01 MB |     6.82 ms |       6.77 ms |      7.46 ms |        7.46 ms |
| 720p       | u16 row-delta + gzip (reference)       |  0.97 MB |     6.20 ms |             - |      6.98 ms |              - |
| 1080p      | PNG16, up                              |  2.33 MB |     13.8 ms |       13.9 ms |      14.3 ms |        14.5 ms |
| 1080p      | PNG16, up, prototype decoder           |  2.33 MB |     22.3 ms |             - |      22.0 ms |              - |
| 1080p      | PNG16, sub                             |  2.32 MB |     13.3 ms |       13.3 ms |      13.4 ms |        13.7 ms |
| 1080p      | PNG16, none                            |  2.65 MB |     13.2 ms |       13.2 ms |      13.2 ms |        13.4 ms |
| 1080p      | PNG16, average                         |  2.31 MB |     14.1 ms |       13.9 ms |      14.6 ms |        14.5 ms |
| 1080p      | PNG16, paeth                           |  2.34 MB |     24.1 ms |       24.2 ms |      31.5 ms |        31.7 ms |
| 1080p      | PNG16, paeth, prototype decoder        |  2.34 MB |     33.3 ms |             - |      33.1 ms |              - |
| 1080p      | PNG16, paeth-up-mix                    |  2.34 MB |     20.7 ms |       20.9 ms |      25.8 ms |        26.2 ms |
| 1080p      | PNG16, paeth-up-mix, prototype decoder |  2.34 MB |     29.8 ms |             - |      29.6 ms |              - |
| 1080p      | PNG16, adaptive                        |  2.32 MB |     13.9 ms |       14.1 ms |      14.5 ms |        15.0 ms |
| 1080p      | u16 row-delta + gzip (reference)       |  2.29 MB |     13.6 ms |             - |      15.3 ms |              - |
| 4K         | PNG16, up                              |  9.25 MB |     55.3 ms |       61.6 ms |      56.2 ms |        57.3 ms |
| 4K         | PNG16, up, prototype decoder           |  9.25 MB |     89.0 ms |             - |      86.6 ms |              - |
| 4K         | PNG16, sub                             |  9.20 MB |     52.2 ms |       52.5 ms |      53.4 ms |        53.7 ms |
| 4K         | PNG16, none                            | 10.49 MB |     53.4 ms |       52.2 ms |      53.3 ms |        53.6 ms |
| 4K         | PNG16, average                         |  9.18 MB |     55.9 ms |       56.2 ms |      58.6 ms |        58.9 ms |
| 4K         | PNG16, paeth                           |  9.29 MB |     97.3 ms |       96.6 ms |     126.5 ms |       127.0 ms |
| 4K         | PNG16, paeth, prototype decoder        |  9.29 MB |    133.3 ms |             - |     133.4 ms |              - |
| 4K         | PNG16, paeth-up-mix                    |  9.28 MB |     82.7 ms |       82.8 ms |     103.4 ms |       103.9 ms |
| 4K         | PNG16, paeth-up-mix, prototype decoder |  9.28 MB |    117.7 ms |             - |     118.3 ms |              - |
| 4K         | PNG16, adaptive                        |  9.20 MB |     55.6 ms |       55.5 ms |      58.5 ms |        59.6 ms |
| 4K         | u16 row-delta + gzip (reference)       |  9.13 MB |     55.4 ms |             - |      60.3 ms |              - |

- The library decoder reads Up, Sub, Average and None files at 13 to 15 ms
  at 1080p and 52 to 59 ms at 4K in both engines; the Up file decodes 36 to
  38 % faster than with the prototype. That is the same speed as the row-delta + gzip reference, which
  research 07 measured 2.5 times faster than the prototype: once the
  unfilter loops are tight, an Up-filtered PNG costs what its inflate costs.
- Paeth rows still cost more: 24 ms (Chrome) and 32 ms (Firefox) at 1080p,
  97 and 127 ms at 4K, 1.7 to 2.3 times an Up file. A file of mostly Paeth
  rows, which Pillow writes by default, decodes 1.5 to 1.8 times slower than
  the same samples written with Up rows, and file sizes differ by under 1 %
  on this scene. On the research scene's 720p frame, at the same zlib
  level, Up rows came out 6 % and Sub rows 12 % larger than Pillow's
  per-row choice. Producers
  should write one simple filter (the depth docs say so).
- A worker costs nothing extra: the round trip matches the main-thread
  decode within noise, so decoding off the main thread is free.

## 3. Upload and render per frame

The render texture is media-sized, so every present shades one fragment per
media pixel. Each present is waited on (a one-pixel readback on WebGL,
`onSubmittedWorkDone` on WebGPU), which adds a fixed round trip of about
0.4 to 0.6 ms to both columns; the upload share is their difference.

| Browser | Backend | Resolution | Encoding                              | Bytes / frame | Upload + render | Render only | Upload share |
| ------- | ------- | ---------- | ------------------------------------- | ------------: | --------------: | ----------: | -----------: |
| Chrome  | webgl   | 720p       | exact rg8                             |       1.8 MiB |         0.80 ms |     0.48 ms |      0.32 ms |
| Chrome  | webgl   | 720p       | preview r8                            |       900 KiB |         0.67 ms |     0.46 ms |      0.21 ms |
| Chrome  | webgl   | 720p       | exact rg8, half-size map (edge-aware) |       450 KiB |         0.62 ms |     0.53 ms |      0.08 ms |
| Chrome  | webgl   | 1080p      | exact rg8                             |       4.0 MiB |         1.13 ms |     0.41 ms |      0.72 ms |
| Chrome  | webgl   | 1080p      | preview r8                            |       2.0 MiB |         0.88 ms |     0.60 ms |      0.29 ms |
| Chrome  | webgl   | 1080p      | exact rg8, half-size map (edge-aware) |      1013 KiB |         0.88 ms |     0.67 ms |      0.21 ms |
| Chrome  | webgl   | 4K         | exact rg8                             |        16 MiB |         3.63 ms |     0.88 ms |      2.74 ms |
| Chrome  | webgl   | 4K         | preview r8                            |       7.9 MiB |         2.04 ms |     0.88 ms |      1.16 ms |
| Chrome  | webgl   | 4K         | exact rg8, half-size map (edge-aware) |       4.0 MiB |         1.78 ms |     1.01 ms |      0.77 ms |
| Chrome  | webgpu  | 720p       | exact rg8                             |       1.8 MiB |         1.11 ms |     0.52 ms |      0.59 ms |
| Chrome  | webgpu  | 720p       | preview r8                            |       900 KiB |         0.81 ms |     0.54 ms |      0.27 ms |
| Chrome  | webgpu  | 720p       | exact rg8, half-size map (edge-aware) |       450 KiB |         0.74 ms |     0.55 ms |      0.19 ms |
| Chrome  | webgpu  | 1080p      | exact rg8                             |       4.0 MiB |         2.55 ms |     0.58 ms |      1.97 ms |
| Chrome  | webgpu  | 1080p      | preview r8                            |       2.0 MiB |         1.17 ms |     0.57 ms |      0.61 ms |
| Chrome  | webgpu  | 1080p      | exact rg8, half-size map (edge-aware) |      1013 KiB |         1.03 ms |     0.68 ms |      0.36 ms |
| Chrome  | webgpu  | 4K         | exact rg8                             |        16 MiB |         4.02 ms |     0.95 ms |      3.07 ms |
| Chrome  | webgpu  | 4K         | preview r8                            |       7.9 MiB |         2.19 ms |     0.95 ms |      1.24 ms |
| Chrome  | webgpu  | 4K         | exact rg8, half-size map (edge-aware) |       4.0 MiB |         2.88 ms |     0.63 ms |      2.24 ms |
| Firefox | webgl   | 720p       | exact rg8                             |       1.8 MiB |         1.36 ms |     0.58 ms |      0.78 ms |
| Firefox | webgl   | 720p       | preview r8                            |       900 KiB |         1.24 ms |     0.68 ms |      0.56 ms |
| Firefox | webgl   | 720p       | exact rg8, half-size map (edge-aware) |       450 KiB |         0.82 ms |     0.52 ms |      0.30 ms |
| Firefox | webgl   | 1080p      | exact rg8                             |       4.0 MiB |         2.68 ms |     0.56 ms |      2.12 ms |
| Firefox | webgl   | 1080p      | preview r8                            |       2.0 MiB |         1.88 ms |     0.56 ms |      1.32 ms |
| Firefox | webgl   | 1080p      | exact rg8, half-size map (edge-aware) |      1013 KiB |         1.12 ms |     0.66 ms |      0.46 ms |
| Firefox | webgl   | 4K         | exact rg8                             |        16 MiB |         9.02 ms |     0.68 ms |      8.34 ms |
| Firefox | webgl   | 4K         | preview r8                            |       7.9 MiB |         6.62 ms |     0.96 ms |      5.66 ms |
| Firefox | webgl   | 4K         | exact rg8, half-size map (edge-aware) |       4.0 MiB |         3.54 ms |     1.40 ms |      2.14 ms |

- Drawing depth is cheap: 0.4 to 1.4 ms per present at every size once the
  map is on the GPU, edge-aware filter included, and most of that is the
  wait's round trip.
- Uploading an exact 4K map costs 2.7 to 3.1 ms in Chrome and 8.3 ms in
  Firefox's WebGL. That is the case for the plan's upload-ahead (P6): an
  upload in the present at 4K spends a fifth to a half of a 60 fps frame.
- A preview (`r8`) frame uploads in about half the time of an exact one.

## 4. Preview video decode

### Codes through each decoder (plan risk R2)

Once per page, before a preview opens, the library decodes a 256x256 clip of
all 256 codes (flat 16x16 blocks, neutral chroma, full range, the producer's
encoder at a quantiser low enough that ffmpeg decodes every block exactly)
through each decoder the browser offers, and keeps the first one that returns
the codes as written.

| Browser     | Decoder                  | Offered | Exact | Codes changed | Max error | 0 reads as | 255 reads as | Luma from |
| ----------- | ------------------------ | ------- | ----- | ------------: | --------: | ---------: | -----------: | --------- |
| Chrome 154  | prefer-software (chosen) | yes     | yes   |             0 |         0 |          0 |          255 | plane     |
| Chrome 154  | prefer-hardware          | yes     | no    |           249 |        20 |         16 |          235 | plane     |
| Chrome 154  | no-preference            | yes     | yes   |             0 |         0 |          0 |          255 | plane     |
| Firefox 155 | prefer-software (chosen) | yes     | no    |            36 |         1 |          0 |          255 | rgb       |
| Firefox 155 | prefer-hardware          | yes     | no    |            36 |         1 |          0 |          255 | rgb       |
| Firefox 155 | no-preference            | yes     | no    |            36 |         1 |          0 |          255 | rgb       |

- **Chrome's hardware decoder (VideoToolbox) changes every code**: full-range
  luma comes back squeezed into video range, `16 + code * 219/255`. Code 0, no
  depth, reads as 16, a valid code, so holes would draw as far depth. Its
  software decoder returns every code as written. `no-preference` picks
  software at the probe's 256x256 and hardware at 720p and up: on the real
  720p preview it gave the squeeze (slope 0.86, intercept 15.8 against the
  codes ffmpeg decodes). So the library asks for `prefer-software` by name,
  and on the Spring preview Chrome's luma matches ffmpeg's byte for byte.
- **Firefox hands every decoded frame over as BGRX**, converted to RGB on the
  way, whichever decoder it uses. Full range survives (0 and 255 come back
  as 0 and 255), but 36 of 256 codes come back one off, colliding with a
  neighbour, so no table undoes them. The library keeps the decoder, reports
  the change in its depth diagnostics `message` and a console warning, and
  playback depth in Firefox is within one preview step plus the codec's
  error (0.64 codes mean on the Spring SGBM preview, against 0.32 in Chrome).
- Safari was not run. Its WebCodecs decodes through VideoToolbox; if it
  squeezes as Chrome's hardware path does and offers no software decoder,
  the probe's correction table brings the codes back to within one.

### TV-range previews (2026-10-01)

The Spring previews are now written in TV range (luma 16 to 235, flagged
limited range with BT.709 colour; no depth is 16, codes up to 31 are no
depth, depth runs 32 to 235). The probe has a TV-range clip of the same 256
blocks and judges the 220 codes from 16 to 235, hardware decoder first.
`node benchmark/depth/run-gpu.mjs --query="cases=codes&backends=webgl"`
(and `--browser=firefox`), and the same page in the Claude desktop app's
browser pane (Chrome 152, hardware decode):

| Browser                     | Decoder                  | Codes changed | Max error | After the table | 16 reads as | 235 reads as | Luma from |
| --------------------------- | ------------------------ | ------------: | --------: | --------------: | ----------: | -----------: | --------- |
| Chrome 154 headless         | prefer-hardware (chosen) |      0 of 220 |         0 |               0 |          16 |          235 | plane     |
| Chrome 154 headless         | prefer-software          |      0 of 220 |         0 |               0 |          16 |          235 | plane     |
| Chrome 154 headless         | no-preference            |      0 of 220 |         0 |               0 |          16 |          235 | plane     |
| Chrome 152, Claude app pane | prefer-hardware (chosen) |      0 of 220 |         0 |               0 |          16 |          235 | plane     |
| Chrome 152, Claude app pane | prefer-software          |      0 of 220 |         0 |               0 |          16 |          235 | plane     |
| Chrome 152, Claude app pane | no-preference            |      0 of 220 |         0 |               0 |          16 |          235 | plane     |
| Firefox 155 headless        | prefer-hardware (chosen) |    214 of 220 |        20 |               0 |           0 |          255 | rgb       |
| Firefox 155 headless        | prefer-software          |    214 of 220 |        20 |               0 |           0 |          255 | rgb       |
| Firefox 155 headless        | no-preference            |    214 of 220 |        20 |               0 |           0 |          255 | rgb       |

The first second of the SGBM preview (24 frames, 22.1 million pixels)
through each decoder and its own probe's table, against ffmpeg's luma of the
same frames, both clamped to 16 to 235:

| Browser                     | Decoder         | Pixels that differ | Max error |
| --------------------------- | --------------- | -----------------: | --------: |
| Chrome 154 headless         | prefer-hardware |                  0 |         0 |
| Chrome 154 headless         | prefer-software |                  0 |         0 |
| Chrome 152, Claude app pane | prefer-hardware |                  0 |         0 |
| Chrome 152, Claude app pane | prefer-software |                  0 |         0 |
| Firefox 155 headless        | every decoder   |                  0 |         0 |

- **Every decoder returns TV-range codes exactly.** Chrome's hardware
  decoder, which squeezes full range, passes TV range through untouched, so
  the session now asks for it by name and no longer needs the software one.
  Firefox converts to RGB, `(code - 16) * 255 / 219`, which spreads 220 codes
  over 256 without collisions, so the probe's table undoes it exactly; its
  full-range previews stay one off on 36 codes.
- 100,840 of the 22.1 million pixels (0.46 %) decode outside 16 to 235 in
  ffmpeg, the codec's error next to holes and edges. An RGB path returns
  them as 16 and 235, which decode to the same depth (no depth, and the top
  of the range).
- The playground's playback check (`run-playback.mjs`) in headless Chrome
  matched the producer's codes with slope 1.000 and 0.21 to 0.34 codes mean
  error (the codec's); Firefox 0.18 to 0.28, down from 0.27 to 0.64.
- One step is a 203rd of `range_px` instead of a 239th: 0.31 px instead of
  0.26 px on the SGBM layer, 0.19 px instead of 0.16 px on ground truth.

### Decode and copy cost

Every frame of the preview decoded back to back through the library's
reader, luma copied in the render-preparation worker (what a session does)
or on the page (the fallback). Main thread is the page's time per frame:
handing the frame over, and on the page, copying its luma out.

| Browser | Clip  | Decoder         | Copied in |  fps | Main thread median |     P95 |
| ------- | ----- | --------------- | --------- | ---: | -----------------: | ------: |
| Chrome  | 720p  | prefer-software | worker    | 1054 |            0.01 ms | 0.02 ms |
| Chrome  | 720p  | prefer-software | page      | 1033 |            0.06 ms | 0.13 ms |
| Chrome  | 720p  | prefer-hardware | worker    |  886 |            0.00 ms | 0.02 ms |
| Chrome  | 1080p | prefer-software | worker    |  868 |            0.00 ms | 0.02 ms |
| Chrome  | 1080p | prefer-software | page      |  827 |            0.26 ms | 0.35 ms |
| Chrome  | 1080p | prefer-hardware | worker    |  647 |            0.00 ms | 0.03 ms |
| Chrome  | 4K    | prefer-software | worker    |  742 |            0.00 ms | 0.03 ms |
| Chrome  | 4K    | prefer-software | page      |  736 |            1.05 ms | 1.51 ms |
| Chrome  | 4K    | prefer-hardware | worker    |  295 |            0.00 ms | 0.03 ms |
| Firefox | 720p  | prefer-software | worker    |  389 |            0.00 ms | 0.04 ms |
| Firefox | 720p  | prefer-software | page      |  435 |            2.02 ms | 2.38 ms |
| Firefox | 1080p | prefer-software | worker    |  182 |            0.00 ms | 0.04 ms |
| Firefox | 1080p | prefer-software | page      |  208 |            4.40 ms | 4.98 ms |
| Firefox | 4K    | prefer-software | worker    |   51 |            0.00 ms | 0.08 ms |
| Firefox | 4K    | prefer-software | page      |   54 |            17.4 ms | 20.3 ms |

- Copied on the page, Firefox spends 4.4 ms of main thread per 1080p frame
  (its RGB conversion runs inside `copyTo`) and 17 ms at 4K, past the plan's
  1 ms ceiling (risk R4); Chrome stays under it until 4K. So the library
  sends each decoded frame to the render-preparation worker, transferred, and
  the page's share drops to under 0.1 ms a frame at every size in both
  browsers. A browser that cannot send a frame to a worker copies on the page.
- Decode keeps up with 8x (192 frames a second) everywhere but Firefox at
  4K, which decodes 51 frames a second: about 2x.
- In Chrome the software decoder is faster than the hardware one here, 2.5
  times at 4K, so choosing it for exact codes costs no speed.

## 5. Memory at the default budgets (computed)

The byte budgets now scale with the clip (`resolveDepthClipOptions`): the
preview window holds twice the 1 s prefetch plus the 0.25 s kept behind the
playhead, at least 96 MiB and at most 512 MiB; the exact cache holds 128 MiB,
or the frame at rest and its ±2 neighbours twice over when that is more. At
30 fps, with exact and preview maps in texture rings of their own:

| Resolution | Exact frame | Preview frame | Exact cache                             | Preview window                  | Still image (map + confidence) | Decode transient | GPU rings (3 + 3 slots) |
| ---------- | ----------: | ------------: | --------------------------------------- | ------------------------------- | -----------------------------: | ---------------: | ----------------------: |
| 720p       |     1.8 MiB |       900 KiB | 128 MiB: 72 frames (48 with confidence) | 96 MiB: 109 frames, 3.38 s lead |                        2.6 MiB |          1.8 MiB |                 7.9 MiB |
| 1080p      |     4.0 MiB |       2.0 MiB | 128 MiB: 32 frames (21 with confidence) | 134 MiB: 68 frames, 2.02 s lead |                        5.9 MiB |          4.0 MiB |                  18 MiB |
| 4K         |      16 MiB |       7.9 MiB | 158 MiB: 10 frames (6 with confidence)  | 512 MiB: 64 frames, 1.88 s lead |                         24 MiB |           16 MiB |                  71 MiB |

- The 4K lead is 1.88 s instead of 0.15 s (plan risk R5): more than the
  gate's 1 s ceiling at any rate. 512 MiB of luma is the price; a host that
  cannot spend it sets `renderPreparation.depth.maxPreviewCacheBytes`, and
  the gate then asks for no more lead than the budget holds.

## 6. Playback with the gate, and seeking

The library's preview window plays each clip with the session's default
gate (stop below 0.1 s of wall time, resume 0.2 s later, at most 1 s of
timeline, give up after 2 s), for 4 s of wall time or the whole clip. Each
animation frame presents the frame's preview through the texture ring and
depth shader, its upload either inside the present or done ahead in a task
after the previous present, as the depth layer does. Presents are not
waited on, so their time is what the page spends. Seek is the time from a
seek to the middle of the clip, at rest, to its preview decoded. Headless
Firefox animates at about 25 frames a second, Chrome at 60.

| Browser | Clip  | Rate | Upload     | Presents | Without depth | Holds (held) | Present median / P95 | Uploads in present | Seek to preview |
| ------- | ----- | ---: | ---------- | -------: | ------------: | ------------ | -------------------- | -----------------: | --------------: |
| Chrome  | 720p  |   1x | in present |      241 |             0 | 0            | 0.06 / 0.20 ms       |                 97 |               - |
| Chrome  | 720p  |   1x | ahead      |      241 |             0 | 0            | 0.04 / 0.08 ms       |                  1 |               - |
| Chrome  | 720p  |   2x | ahead      |      240 |             0 | 0            | 0.04 / 0.09 ms       |                  1 |           12 ms |
| Chrome  | 720p  |   8x | ahead      |       61 |             0 | 0            | 0.04 / 0.11 ms       |                  2 |           10 ms |
| Chrome  | 1080p |   1x | ahead      |      241 |             0 | 0            | 0.04 / 0.08 ms       |                  1 |               - |
| Chrome  | 1080p |   2x | in present |      240 |             0 | 0            | 0.24 / 1.97 ms       |                192 |            8 ms |
| Chrome  | 1080p |   2x | ahead      |      239 |             0 | 0            | 0.03 / 0.08 ms       |                  1 |            8 ms |
| Chrome  | 1080p |   8x | ahead      |       60 |             0 | 0            | 0.04 / 0.12 ms       |                  3 |            8 ms |
| Chrome  | 4K    |   1x | in present |      241 |             0 | 0            | 0.06 / 2.57 ms       |                 97 |               - |
| Chrome  | 4K    |   1x | ahead      |      241 |             0 | 0            | 0.05 / 0.09 ms       |                  1 |               - |
| Chrome  | 4K    |   2x | in present |      240 |             0 | 0            | 1.01 / 3.48 ms       |                192 |           20 ms |
| Chrome  | 4K    |   2x | ahead      |      242 |             0 | 0            | 0.05 / 0.09 ms       |                  1 |           20 ms |
| Chrome  | 4K    |   8x | in present |       61 |             0 | 0            | 1.08 / 2.68 ms       |                 61 |           25 ms |
| Chrome  | 4K    |   8x | ahead      |       61 |             0 | 0            | 0.07 / 0.63 ms       |                  2 |           20 ms |
| Firefox | 720p  |   1x | ahead      |       99 |             0 | 0            | 0.14 / 0.20 ms       |                  1 |               - |
| Firefox | 720p  |   8x | ahead      |       26 |             0 | 0            | 0.14 / 0.40 ms       |                  6 |           18 ms |
| Firefox | 1080p |   2x | in present |       98 |             0 | 0            | 0.56 / 0.86 ms       |                 98 |           33 ms |
| Firefox | 1080p |   2x | ahead      |      100 |             0 | 0            | 0.16 / 0.42 ms       |                  7 |           29 ms |
| Firefox | 1080p |   8x | ahead      |       28 |             0 | 0            | 0.18 / 0.64 ms       |                 10 |           44 ms |
| Firefox | 4K    |   1x | in present |       98 |             0 | 0            | 1.62 / 2.20 ms       |                 96 |               - |
| Firefox | 4K    |   1x | ahead      |      100 |             0 | 0            | 0.18 / 0.40 ms       |                  1 |               - |
| Firefox | 4K    |   2x | ahead      |      100 |             0 | 0            | 0.20 / 1.36 ms       |                 12 |           77 ms |
| Firefox | 4K    |   8x | in present |       31 |             0 | 9 (2217 ms)  | 1.56 / 2.36 ms       |                 31 |           83 ms |
| Firefox | 4K    |   8x | ahead      |       29 |             0 | 9 (2225 ms)  | 1.32 / 2.42 ms       |                 20 |           76 ms |

Every row, both browsers, is in `findings-preview.csv`.

- **The gate held only where decode cannot keep up**: Firefox at 4K and 8x,
  where the decoder's 51 frames a second meet 192 needed. It held 9 times
  for about a quarter of a second each, none ran out the 2 s bound, and no
  present ever drew without its frame's depth. Everywhere else the decoded
  lead never fell below the stop threshold: no holds.
- **Upload ahead takes the preview upload out of the present.** A 4K present
  that uploads its preview costs 2.6 to 3.5 ms at P95 in Chrome; uploaded
  ahead it only binds, 0.09 ms at 1x and 2x and 0.63 ms at 8x. The rows
  left uploading in the present are the first frame and, at 8x, the first
  jumps before the layer has the pace (it uploads the two frames a present
  can land on: 3 and 4 ahead at 3.2 frames a present). Headless Firefox's
  irregular 25 Hz animation leaves a few more.
- **Seek to preview depth**: 8 to 25 ms in Chrome, 18 to 83 ms in Firefox,
  for a seek into a key-frame interval of 24 frames. In the docs playground
  (720p, real session, Chrome), a seek drew the preview for the new frame 17
  to 37 ms after it, and the exact frame landed 160 to 210 ms after a pause,
  150 ms of which is the settle delay before it is fetched.

### Playback in the docs playground

`node benchmark/depth/run-playback.mjs` plays the depth docs playground
(`?embed=depth`, the Spring clip) in headless Chrome and Firefox, both
layers, at 1x and 2x, and checks what is drawn every 50 ms:

- Chrome: preview depth in every sample while playing (101 to 102 of 102 at
  1x, 63 of 63 at 2x), always the frame on screen's; the readout said
  "≈ 8-bit preview value" for the frame on screen; the exact frame replaced
  it after a pause; a seek and a 40-step drag showed no depth from another
  frame. The preview frame matched its own exact frame (0.06 to 0.13 px mean
  difference) better than either neighbour (0.22 to 0.39 px), and its codes
  matched the codes the producer wrote from the exact frame (slope 1.000,
  0.18 to 0.36 codes mean, the codec's error). The page never held more than
  one preview decoder, the probe's included.
- Firefox: the web video engine stops presenting the Spring clip after its
  first eight frames in headless Firefox (with or without depth, and with
  the page's decoders removed), so playback there was checked on the
  frame it stops at: preview depth drawn for it, codes within one (0.27 to
  0.64 codes mean), no stale depth, one decoder.

### Exact depth while playing (2026-10-01)

`node benchmark/depth/run-playback.mjs --playback=<auto|exact>` (with
`--throttle-mbps` for the capped runs) on an Apple-silicon Mac, the demo
served locally, the Spring 720p clip:

- `"exact"` played exact depth at the clip's full 24 and 48 frames a second
  at 1x and 2x, with the exact frames loading at 150 to 220 a second and one
  gate hold at the start. The whole browser spent about 18 to 31 ms of CPU a
  presented frame, against 12 to 23 ms for the preview.
- With downloads capped at 50 Mbit/s (about 23 exact frames a second for the
  clip's 224 kB frames), `"auto"` kept the preview throughout, with no
  hand-backs and no holds.
- `"exact"` at 30 Mbit/s held playback to about 13 frames a second.
