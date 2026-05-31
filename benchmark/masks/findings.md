# Mask Artifact Benchmark Findings

Measured on 2026-05-31 with `npm run benchmark:masks`.

Environment: Apple M3 Max, 16 CPU cores, Node v24.16.0.

Fixture: basketball SAM3 sample, 270 frames, 2,981 detections/masks, 1920 x
1080 masks, 30 fps.

## Timing Summary

| Strategy           | Confidence | Mean / frame | P95 / frame | Projected fixture prep | Artifact bytes / frame |
| ------------------ | ---------: | -----------: | ----------: | ---------------------: | ---------------------: |
| RGBA fill          |        0.5 |       20.3ms |      29.1ms |                  5.48s |                 7.9 MB |
| RGBA fill + border |        0.5 |       50.5ms |      65.6ms |                 13.63s |                 7.9 MB |
| ID mask candidate  |        0.5 |       17.4ms |      22.7ms |                  4.70s |                 2.0 MB |
| RGBA fill          |        0.1 |       18.4ms |      23.0ms |                  4.97s |                 7.9 MB |
| RGBA fill + border |        0.1 |       55.2ms |      71.5ms |                 14.91s |                 7.9 MB |
| ID mask candidate  |        0.1 |       17.1ms |      21.9ms |                  4.63s |                 2.0 MB |

## Byte Pressure

| Item                        |  Bytes |
| --------------------------- | -----: |
| Video fixture               | 4.7 MB |
| Chunked detections          | 3.3 MB |
| RLE counts                  | 1.8 MB |
| Current RGBA prepared frame | 7.9 MB |
| ID mask prepared frame      | 2.0 MB |
| 5s RGBA prepared window     | 1.2 GB |
| 5s ID-mask prepared window  | 297 MB |
| Per-class palette update    |   12 B |

## Interpretation

- Current RGBA artifacts are still the stable baseline because they are simple
  and already work.
- CPU decode/compositing is expensive enough that workers and prepared windows
  remain necessary.
- CPU mask borders are the loudest bottleneck. Borders should move toward a
  shader/ID-mask approach instead of relying on CPU contour expansion.
- ID masks do not magically remove RLE decode cost, but they cut prepared
  artifact byte pressure by roughly 4x and make per-class style updates tiny.
- A backend-provided frame-level PNG mask artifact is worth benchmarking before
  implementing the next mask renderer path.

## Next Benchmark

Run a PNG artifact benchmark before committing to the ID-mask shader path:

- Build one frame-level ID mask per detection frame.
- Encode it as PNG, likely one PNG per frame.
- Measure encoded bytes, encode time, browser/native decode time, and texture
  upload bytes.
- Compare against the current RLE-to-RGBA path and the raw ID-mask candidate.

If PNG decode/upload is favorable, the next architecture should support
backend-provided frame-level mask artifacts as a first-class prepared artifact
source.
