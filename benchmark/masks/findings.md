# Mask Artifact Benchmark Findings

Measured on 2026-05-31 with `npm run benchmark:masks` and
`npm run benchmark:masks:gpu`.

Environment: Apple M3 Max, 16 CPU cores, Node v24.16.0.
GPU benchmark environment: HeadlessChrome 148, Pixi WebGL renderer, WebGL
`finish()` supported.

Fixture: basketball SAM3 sample, 270 frames, 2,981 detections/masks, 1920 x
1080 masks, 30 fps.

## Timing Summary

| Scope       | Strategy                                   | Confidence | Mean / frame | P95 / frame | Decode mean | Texture/render mean | Projected fixture time | Artifact bytes / frame |
| ----------- | ------------------------------------------ | ---------: | -----------: | ----------: | ----------: | ------------------: | ---------------------: | ---------------------: |
| Node prep   | RGBA fill                                  |        0.5 |       19.3ms |      27.8ms |           - |                   - |                  5.21s |                 7.9 MB |
| Node prep   | RGBA fill + border                         |        0.5 |       51.2ms |      67.2ms |           - |                   - |                 13.83s |                 7.9 MB |
| Node prep   | ID mask candidate                          |        0.5 |       17.7ms |      22.9ms |           - |                   - |                  4.79s |                 2.0 MB |
| Node prep   | PNG ID mask level 1                        |        0.5 |       18.5ms |      24.0ms |           - |                   - |                  5.01s |                  26 KB |
| Node prep   | PNG ID mask level 6                        |        0.5 |       21.7ms |      26.6ms |           - |                   - |                  5.85s |                  11 KB |
| Browser GPU | Pixi RGBA fill ImageBitmap upload/render   |        0.5 |       7.72ms |      28.5ms |      0.00ms |              7.72ms |                  2.08s |                 7.9 MB |
| Browser GPU | Pixi RGBA border ImageBitmap upload/render |        0.5 |       6.27ms |      7.90ms |      0.00ms |              6.27ms |                  1.69s |                 7.9 MB |
| Browser GPU | Pixi PNG ID mask decode + upload/render    |        0.5 |       4.75ms |      6.50ms |      2.29ms |              2.46ms |                  1.28s |                  11 KB |
| Node prep   | RGBA fill                                  |        0.1 |       18.7ms |      24.8ms |           - |                   - |                  5.05s |                 7.9 MB |
| Node prep   | RGBA fill + border                         |        0.1 |       55.1ms |      71.5ms |           - |                   - |                 14.88s |                 7.9 MB |
| Node prep   | ID mask candidate                          |        0.1 |       17.1ms |      21.7ms |           - |                   - |                  4.62s |                 2.0 MB |
| Node prep   | PNG ID mask level 1                        |        0.1 |       18.5ms |      22.8ms |           - |                   - |                  4.99s |                  26 KB |
| Node prep   | PNG ID mask level 6                        |        0.1 |       21.8ms |      27.0ms |           - |                   - |                  5.89s |                  11 KB |
| Browser GPU | Pixi RGBA fill ImageBitmap upload/render   |        0.1 |       2.19ms |      2.60ms |      0.00ms |              2.19ms |                  590ms |                 7.9 MB |
| Browser GPU | Pixi RGBA border ImageBitmap upload/render |        0.1 |       6.61ms |      9.00ms |      0.00ms |              6.61ms |                  1.78s |                 7.9 MB |
| Browser GPU | Pixi PNG ID mask decode + upload/render    |        0.1 |       8.25ms |      10.7ms |      3.43ms |              4.82ms |                  2.23s |                  11 KB |

## Byte Pressure

| Item                        |  Bytes |
| --------------------------- | -----: |
| Video fixture               | 4.7 MB |
| Chunked detections          | 3.3 MB |
| RLE counts                  | 1.8 MB |
| Current RGBA prepared frame | 7.9 MB |
| ID mask prepared frame      | 2.0 MB |
| PNG ID mask prepared frame  |  11 KB |
| 5s RGBA prepared window     | 1.2 GB |
| 5s ID-mask prepared window  | 297 MB |
| 5s PNG ID-mask window       | 1.6 MB |
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
- PNG ID masks are the byte-pressure winner for this sparse fixture: roughly
  11-26 KB per frame instead of 2.0 MB raw ID masks or 7.9 MB RGBA masks.
- PNG encode adds roughly 1-4ms per frame over raw ID-mask generation in this
  Node benchmark, depending on compression level.
- Browser PNG decode + Pixi upload/render is comfortably under a 30fps frame
  budget in this benchmark, while moving only about 11 KB per frame as an
  encoded artifact.
- The GPU benchmark currently renders the PNG ID mask as an image texture. It
  does not yet include the final class-palette shader or mask-border shader.
- PNG is promising for backend-provided frame-level artifacts and possibly for
  persisted prepared artifacts, but the next renderer proof should verify
  shader/palette styling on top of the PNG or raw ID-mask texture.

## Next Benchmark

Run a shader/palette browser benchmark before committing to the ID-mask renderer
path:

- Decode PNG ID-mask artifacts in the browser or ingest backend-provided PNGs.
- Upload them as Pixi textures.
- Apply class palette, opacity, and border styling through shader/render logic.
- Compare runtime smoothness against the current RGBA prepared artifact path.

If PNG decode/upload is favorable, the next architecture should support
backend-provided frame-level mask artifacts as a first-class prepared artifact
source.
