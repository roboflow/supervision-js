# Mask Artifact Benchmark Findings

CPU preparation refreshed on 2026-06-04 with `npm run benchmark:masks`. GPU
rows were measured on 2026-05-31 with `npm run benchmark:masks:gpu`.

CPU environment: Apple M3 Max, 16 CPU cores, Node v24.16.0.
GPU benchmark environment: HeadlessChrome 148, Pixi WebGL renderer, WebGL
`finish()` supported.

Fixture: basketball SAM3 sample, 270 frames, 2,981 detections/masks, 1920 x
1080 masks, 30 fps.

## Timing Summary

| Scope       | Strategy                                   | Role                         | Confidence | Mean / frame | P95 / frame | Decode mean | Texture/render mean | Projected fixture time | Artifact / frame | 5s prepared window |
| ----------- | ------------------------------------------ | ---------------------------- | ---------: | -----------: | ----------: | ----------: | ------------------: | ---------------------: | ---------------: | -----------------: |
| Node prep   | RGBA fill                                  | Runtime RGBA artifact        |        0.5 |       18.5ms |      24.2ms |           - |                   - |                  5.00s |           7.9 MB |             1.2 GB |
| Node prep   | RGBA fill + border                         | Runtime RGBA artifact        |        0.5 |       47.4ms |      58.8ms |           - |                   - |                 12.80s |           7.9 MB |             1.2 GB |
| Node prep   | ID mask candidate                          | Runtime raw ID-mask artifact |        0.5 |       16.6ms |      20.6ms |           - |                   - |                  4.48s |           2.0 MB |             297 MB |
| Node prep   | PNG ID mask level 1                        | Runtime PNG ID-mask artifact |        0.5 |       17.9ms |      22.7ms |           - |                   - |                  4.84s |            26 KB |             3.8 MB |
| Node prep   | PNG ID mask level 6                        | Runtime PNG ID-mask artifact |        0.5 |       21.0ms |      26.1ms |           - |                   - |                  5.68s |            11 KB |             1.6 MB |
| Browser GPU | Pixi RGBA fill ImageBitmap upload/render   | Runtime RGBA artifact        |        0.5 |       3.64ms |      6.00ms |      0.00ms |              3.64ms |                  983ms |           7.9 MB |             1.2 GB |
| Browser GPU | Pixi RGBA border ImageBitmap upload/render | Runtime RGBA artifact        |        0.5 |       8.64ms |      19.4ms |      0.00ms |              8.64ms |                  2.33s |           7.9 MB |             1.2 GB |
| Browser GPU | Pixi PNG ID mask decode + upload/render    | Runtime PNG ID-mask artifact |        0.5 |       5.30ms |      9.90ms |      1.52ms |              3.78ms |                  1.43s |            11 KB |             1.6 MB |
| Browser GPU | Pixi PNG ID mask palette shader            | Runtime PNG ID-mask artifact |        0.5 |       5.19ms |      4.40ms |      1.47ms |              3.72ms |                  1.40s |            11 KB |             1.6 MB |
| Browser GPU | Pixi PNG ID mask palette border shader     | Runtime PNG ID-mask artifact |        0.5 |       9.62ms |      14.8ms |      5.55ms |              4.07ms |                  2.60s |            11 KB |             1.6 MB |
| Node prep   | RGBA fill                                  | Runtime RGBA artifact        |        0.1 |       17.8ms |      22.5ms |           - |                   - |                  4.81s |           7.9 MB |             1.2 GB |
| Node prep   | RGBA fill + border                         | Runtime RGBA artifact        |        0.1 |       54.9ms |      70.9ms |           - |                   - |                 14.83s |           7.9 MB |             1.2 GB |
| Node prep   | ID mask candidate                          | Runtime raw ID-mask artifact |        0.1 |       16.8ms |      21.6ms |           - |                   - |                  4.55s |           2.0 MB |             297 MB |
| Node prep   | PNG ID mask level 1                        | Runtime PNG ID-mask artifact |        0.1 |       18.4ms |      23.3ms |           - |                   - |                  4.96s |            26 KB |             3.8 MB |
| Node prep   | PNG ID mask level 6                        | Runtime PNG ID-mask artifact |        0.1 |       21.3ms |      25.6ms |           - |                   - |                  5.76s |            11 KB |             1.6 MB |
| Browser GPU | Pixi RGBA fill ImageBitmap upload/render   | Runtime RGBA artifact        |        0.1 |       2.38ms |      2.70ms |      0.00ms |              2.38ms |                  642ms |           7.9 MB |             1.2 GB |
| Browser GPU | Pixi RGBA border ImageBitmap upload/render | Runtime RGBA artifact        |        0.1 |       6.28ms |      7.20ms |      0.00ms |              6.28ms |                  1.69s |           7.9 MB |             1.2 GB |
| Browser GPU | Pixi PNG ID mask decode + upload/render    | Runtime PNG ID-mask artifact |        0.1 |       9.47ms |      26.4ms |      4.00ms |              5.48ms |                  2.56s |            11 KB |             1.6 MB |
| Browser GPU | Pixi PNG ID mask palette shader            | Runtime PNG ID-mask artifact |        0.1 |       5.73ms |      9.30ms |      1.81ms |              3.93ms |                  1.55s |            11 KB |             1.6 MB |
| Browser GPU | Pixi PNG ID mask palette border shader     | Runtime PNG ID-mask artifact |        0.1 |       6.65ms |      12.2ms |      1.47ms |              5.18ms |                  1.79s |            11 KB |             1.6 MB |

## Byte Pressure

| Item                        |  Bytes |
| --------------------------- | -----: |
| Video fixture               | 4.7 MB |
| Chunked detections          | 3.3 MB |
| RLE counts                  | 1.8 MB |
| Estimated 5s RLE hot window | 1.0 MB |
| Current RGBA prepared frame | 7.9 MB |
| ID mask prepared frame      | 2.0 MB |
| PNG ID mask prepared frame  |  11 KB |
| 5s RGBA prepared window     | 1.2 GB |
| 5s ID-mask prepared window  | 297 MB |
| 5s PNG ID-mask window       | 1.6 MB |
| Per-class palette update    |   12 B |

## Interpretation

- RLE compressed masks are the right semantic cold-storage format: compact,
  appendable, and renderer-neutral.
- RLE is not the right active render representation. Decoding and compositing
  every mask on the playback path is the cost we want to move out of the frame
  loop.
- Prepared artifacts are a separate runtime layer. The hot window owns the
  semantic detections; the prepared window owns GPU/runtime-friendly frame
  artifacts.
- CPU RGBA mask preparation with borders costs 47-55ms per frame in this
  fixture. Browser presentation of PNG ID masks with palette + border shader
  costs 6.7-9.6ms per frame in the measured GPU path. That is roughly a 5-8x
  improvement for the active presentation path while keeping styling dynamic.
- PNG ID masks are the byte-pressure winner for this sparse fixture: roughly
  11-26 KB per frame instead of 2.0 MB raw ID masks or 7.9 MB RGBA masks.
- A 5s prepared window is about 1.2 GB as RGBA, 297 MB as raw ID mask, and
  about 1.6 MB as PNG ID mask. This is the main reason the library should keep
  semantic detections cold and prepared artifacts windowed.
- PNG encode adds roughly 1-4ms per frame over raw ID-mask generation in this
  Node benchmark, depending on compression level. This cost belongs in workers
  or backend preparation, not in the active draw loop.
- Per-class style changes should not require rebuilding the mask artifact in
  the ID-mask path. They should update palette uniforms and re-render the active
  prepared texture.
- PNG ID-mask artifacts are useful both for backend-provided frame-level mask
  artifacts and for locally prepared artifacts generated from RLE detections.

## Decision

Proceed with an internal ID-mask prepared artifact prototype:

- Keep RLE detections as the semantic cold-storage format.
- Keep PNG ID-mask frames as the preferred prepared runtime mask artifact.
- Render ID masks through a Pixi shader palette for class fill, opacity, and
  border styling.
- Keep raw ID-mask and RGBA paths as fallbacks for environments where PNG
  decode, shader setup, or browser support is not acceptable.
