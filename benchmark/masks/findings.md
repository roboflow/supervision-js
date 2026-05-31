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
| Browser GPU | Pixi RGBA fill ImageBitmap upload/render   |        0.5 |       3.64ms |      6.00ms |      0.00ms |              3.64ms |                  983ms |                 7.9 MB |
| Browser GPU | Pixi RGBA border ImageBitmap upload/render |        0.5 |       8.64ms |      19.4ms |      0.00ms |              8.64ms |                  2.33s |                 7.9 MB |
| Browser GPU | Pixi PNG ID mask decode + upload/render    |        0.5 |       5.30ms |      9.90ms |      1.52ms |              3.78ms |                  1.43s |                  11 KB |
| Browser GPU | Pixi PNG ID mask palette shader            |        0.5 |       5.19ms |      4.40ms |      1.47ms |              3.72ms |                  1.40s |                  11 KB |
| Browser GPU | Pixi PNG ID mask palette border shader     |        0.5 |       9.62ms |      14.8ms |      5.55ms |              4.07ms |                  2.60s |                  11 KB |
| Node prep   | RGBA fill                                  |        0.1 |       18.7ms |      24.8ms |           - |                   - |                  5.05s |                 7.9 MB |
| Node prep   | RGBA fill + border                         |        0.1 |       55.1ms |      71.5ms |           - |                   - |                 14.88s |                 7.9 MB |
| Node prep   | ID mask candidate                          |        0.1 |       17.1ms |      21.7ms |           - |                   - |                  4.62s |                 2.0 MB |
| Node prep   | PNG ID mask level 1                        |        0.1 |       18.5ms |      22.8ms |           - |                   - |                  4.99s |                  26 KB |
| Node prep   | PNG ID mask level 6                        |        0.1 |       21.8ms |      27.0ms |           - |                   - |                  5.89s |                  11 KB |
| Browser GPU | Pixi RGBA fill ImageBitmap upload/render   |        0.1 |       2.38ms |      2.70ms |      0.00ms |              2.38ms |                  642ms |                 7.9 MB |
| Browser GPU | Pixi RGBA border ImageBitmap upload/render |        0.1 |       6.28ms |      7.20ms |      0.00ms |              6.28ms |                  1.69s |                 7.9 MB |
| Browser GPU | Pixi PNG ID mask decode + upload/render    |        0.1 |       9.47ms |      26.4ms |      4.00ms |              5.48ms |                  2.56s |                  11 KB |
| Browser GPU | Pixi PNG ID mask palette shader            |        0.1 |       5.73ms |      9.30ms |      1.81ms |              3.93ms |                  1.55s |                  11 KB |
| Browser GPU | Pixi PNG ID mask palette border shader     |        0.1 |       6.65ms |      12.2ms |      1.47ms |              5.18ms |                  1.79s |                  11 KB |

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
- Palette shader styling on top of PNG ID masks is also comfortably under the
  frame budget in this fixture. Fill styling is roughly in the same range as
  plain PNG upload/render, and shader borders are much cheaper than CPU border
  preparation.
- Per-class style changes should not require rebuilding the mask artifact in
  the ID-mask path. They can update palette uniforms and re-render the active
  prepared texture.
- PNG ID-mask artifacts are promising for backend-provided frame-level mask
  artifacts and for persisted prepared artifacts generated locally.

## Decision

Proceed with an internal ID-mask prepared artifact prototype:

- Keep RLE detections as the semantic cold-storage format.
- Add a prepared mask artifact path that can carry PNG or raw ID-mask textures.
- Render ID masks through a Pixi shader palette for class fill, opacity, and
  border styling.
- Keep the current RGBA prepared mask path as the stable fallback until visual
  parity and lifecycle behavior are proven in the demo.
