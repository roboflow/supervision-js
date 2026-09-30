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
`png16.js` on the same file. The worker column is the round trip: post the
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

## 5. Memory at the proposed defaults (computed)

From the formats and the plan's defaults: 128 MiB exact cache, 96 MiB
preview window, 0.25 s kept behind the playhead, 30 fps, a three-slot
texture ring. The still-image path holds one map and its confidence plane,
and the upload itself copies nothing on little-endian hosts.

| Resolution | Exact frame | Preview frame | Exact cache, 128 MiB           | Preview window, 96 MiB  | Still image (map + confidence) | Decode transient | GPU ring (3 slots) |
| ---------- | ----------: | ------------: | ------------------------------ | ----------------------- | -----------------------------: | ---------------: | -----------------: |
| 720p       |     1.8 MiB |       900 KiB | 72 frames (48 with confidence) | 109 frames, 3.38 s lead |                        2.6 MiB |          1.8 MiB |            5.3 MiB |
| 1080p      |     4.0 MiB |       2.0 MiB | 32 frames (21 with confidence) | 48 frames, 1.35 s lead  |                        5.9 MiB |          4.0 MiB |             12 MiB |
| 4K         |      16 MiB |       7.9 MiB | 8 frames (5 with confidence)   | 12 frames, 0.15 s lead  |                         24 MiB |           16 MiB |             47 MiB |

- At 4K the default preview budget leaves 0.15 s of lead, too little for the
  gate (plan risk R5). P6 should scale the preview budget with resolution or
  use a lower-resolution preview rendition.
- The exact cache holds 32 frames at 1080p and 8 at 4K, enough for ±2
  neighbours at every size.
