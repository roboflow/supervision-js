# Spring 0021 stereo depth fixture

Eight seconds of a rendered stereo shot with two disparity layers for the left view. Both layers cover
every frame.

- **`sgbm/`**: what a classic stereo matcher (OpenCV semi-global matching) finds on the stereo pair.
  Real matching errors and real holes. This is the "prediction" layer.
- **`ground-truth/`**: the exact disparity Spring rendered for the same frames. Use it for an error
  view.

Source: Spring dataset, train sequence `0021`, frames 1–192, left and right views
(https://spring-benchmark.org, doi:10.18419/darus-3376, version 2.0).

The shot shows a girl in a rocky hollow under an overhead bone bridge, filmed by a slowly moving camera.
There is near rock, a mid-ground figure, a back wall and a little distant sky (1–3 % of pixels).

## Files

| Path | What | Bytes |
|---|---|---|
| `left.mp4` | Left view, 1280x720, 24 fps, 192 frames (8 s), H.264 High 3.1 (`avc1.64001f`) yuv420p bt709, keyframe every 1 s, faststart | 4,276,966 |
| `sgbm/depth.json` | Manifest for the SGBM layer | < 1 kB |
| `sgbm/exact/000000.png` … `000191.png` | 16-bit disparity × 1024, 0 = no depth | 42,937,912 (about 224 kB/frame) |
| `sgbm/preview.mp4` | 8-bit preview of the same, `range_px` [1.562, 37.25] | 4,530,702 |
| `ground-truth/depth.json` | Manifest for the ground-truth layer | < 1 kB |
| `ground-truth/exact/000000.png` … `000191.png` | 16-bit disparity × 1024, 0 = no depth (sky) | 63,492,343 (about 331 kB/frame) |
| `ground-truth/preview.mp4` | 8-bit preview, `range_px` [1.64, 37.271] | 2,953,220 |
| `fixture.meta.json` | Demo metadata, pebbles shape plus a `depth` block | < 1 kB |

In total, about 118.3 MB. The PNGs and MP4s are Git LFS objects, which Git LFS stores and checks by
SHA-256.

There are no detections for this clip, so the folder has no `detections.manifest.json`. The demo
opens it for depth only.

- **Frame numbering:** fixture frame `k` (zero-based) is:
  - `left.mp4` frame `k` at `k / 24` s;
  - `exact/{k:06}.png` in each layer;
  - Spring frame `k + 1` (`frame_left_{k+1:04d}.png`).
- **Frame rate:** 24 fps, native. The Spring open movie is 24 fps. No frames are dropped, duplicated or
  retimed.
- **Coordinates:** both layers are 1280x720, the same size as `left.mp4`. They were computed on exactly
  the downscaled frames that were encoded into `left.mp4`.

## Depth manifests (`*/depth.json`)

Each layer has a manifest in the format the
[depth maps page](../../../docs/public/annotation-renderers/depth.md#data-format) describes.

- **Identity:** `schema` `"supervision.depth-manifest"`, `version` 1, `kind` `"disparity_px"`, `view`
  `"left"`.
- **`storage`:** `png16`. Stored value = round(disparity × `scale`); 0 = no depth. `scale` is the
  largest power of two that keeps the clip maximum under 65535 (1024 for both layers).
- **`camera`:**
  - `fx_px` 1346.8013: Spring's fx of 2020.2020 at 1920 wide, × 1280/1920.
  - `cx_px` 640 and `cy_px` 360: Spring's 960 and 540, scaled the same way.
  - `baseline_m` 0.065 and `doffs_px` 0: Spring's parallel rig.
  - Metric depth is `Z = fx_px × baseline_m / d`.
- **`display_range_px`:** the 2nd–98th percentile of valid disparity over the whole clip, one range per
  layer.
- **`frames`:** `{count: 192, exact: "exact/{index:06}.png", times_s: null}`.
- **`preview`:** `preview.mp4`. Its `codec` string is read from the file's avcC box.
  - `levels` `"tv"`; `reserved_max` 31; `range_px` the 0.1st to 99.9th percentile of valid disparity over
    the clip, so outliers do not widen the step. Disparity outside it clamps to its ends in the preview
    only; the exact frames keep it.
  - Encode: `code = clamp(32 + round((d − lo) / (hi − lo) × 203), 32, 235)`, with `[lo, hi]` =
    `range_px`. No depth is written as 16, and codes up to 31 mean no depth.
  - Encoding: 8-bit gray in the luma of H.264 yuv420p, chroma fixed at 128, TV (limited) range
    flagged with BT.709 colour, CRF 12, `-tune psnr`, a keyframe every second, faststart.
- **PNG details:** every exact PNG is 16-bit grayscale, with PNG filter type 2 (Up) on every row for
  fast browser decode. Written by the research workspace's `fixture/tools/png16.py`.
  - The build proves the round trip on frame 0 of each layer with two independent decoders: the
    script's own reader, and OpenCV/libpng.

## How each layer was made

**Ground truth**

- Spring stores left-view disparity for each frame as a float16 HDF5 map at 3840x2160. Values are in
  1920-wide pixels, and sky is exactly 0.
- The builder takes the maximum of each 3x3 block, which keeps the nearest surface in each 720p pixel
  and preserves thin foreground structure. It then multiplies by 1280/1920.
- Sky stays 0, i.e. "no depth". In reality it is infinitely far.

**SGBM**

- Both views are downscaled from 1920x1080 to 1280x720 with `cv2.INTER_AREA`.
- The matcher is `cv2.StereoSGBM_create(minDisparity=0, numDisparities=64, blockSize=5, P1=600, P2=2400,
  disp12MaxDiff=1, preFilterCap=63, uniquenessRatio=10, speckleWindowSize=100, speckleRange=2,
  mode=STEREO_SGBM_MODE_HH)`.
- Unmatched pixels (negative output) and zero disparity are stored as 0.
- No filtering or hole filling is applied.
- The leftmost 64 columns have no candidate match in the right view within the 64-px search range, so
  they are always no depth.

**Measured on this clip (all 192 frames, from the stored PNGs)**

| | Ground truth | SGBM |
|---|---|---|
| No depth | 2.08 % (sky) | 8.38 % (left band, occlusions, rejected matches) |
| `display_range_px` (2nd–98th percentile) | 2.01–32.229 px | 2.0–33.0 px |
| Clip maximum | 38.583 px | 63.0 px (outliers at the edge of the search range) |

Where both layers have depth, SGBM's mean error against ground truth is 0.77 px. 3.9 % of those pixels
are off by more than 1 px and 2.8 % by more than 3 px. SGBM covers 92.6 % of the pixels where ground
truth has depth. The worst frame's mean error is 1.26 px.

**`left.mp4`**

- The same 1280x720 frames, H.264 High yuv420p, bt709, CRF 18, a keyframe every 24 frames (1 s),
  faststart.
- `ffprobe` reports 192 frames at 24/1, with keyframes at 0–7 s.

## Licences and attribution

The data files in this folder are **CC BY 4.0, not MIT**. That covers `left.mp4` and both layers:
they are material adapted from the Spring dataset.

> This fixture contains material adapted from the Spring dataset by Lukas Mehl, Jenny Schmalfuss,
> Azin Jahedi, Yaroslava Nalivayko and Andrés Bruhn (University of Stuttgart), "Spring: A
> High-Resolution High-Detail Dataset and Benchmark for Scene Flow, Optical Flow and Stereo", CVPR
> 2023, https://doi.org/10.18419/darus-3376, licensed under CC BY 4.0
> (https://creativecommons.org/licenses/by/4.0/). The Spring movie assets
> (https://cloud.blender.org/spring) by Blender Foundation are licensed under CC BY 4.0.
> Changes made:
>
> - sequence 0021, frames 1–192;
> - left view downscaled to 1280x720 and encoded as H.264;
> - ground-truth disparity max-pooled to 1280x720, rescaled, and quantised to 1/1024 px as 16-bit PNG
>   and an 8-bit preview video;
> - added a disparity layer computed with OpenCV StereoSGBM from the downscaled left and right views.
>
> Provided as is, without warranties (see the licence).

- **Spring dataset:** DaRUS record doi:10.18419/darus-3376, licence field "CC BY 4.0", data source
  "The Spring movie assets (https://cloud.blender.org/spring) by Blender Foundation are licensed under
  CC BY 4.0". Please also cite the paper.
- **"Spring" open movie:** Blender Studio (Blender Foundation), 2019, CC BY 4.0. The Blender Studio
  credit line is "(CC) Blender Foundation | studio.blender.org".
- **OpenCV:** `opencv-python-headless` 5.0.0.93, Apache-2.0. It computed the SGBM layer. The SGBM
  layer is data, not OpenCV code, and no model weights are involved.
- **Build scripts:** `fixture/tools/*.py` belong to the depth-map rendering research workspace the
  fixture was built in, not to supervision-js. That workspace keeps the rebuild commands and tool
  versions, the list of Spring members fetched, and the output hashes.

No learned stereo model was used, deliberately: every public stereo checkpoint was trained on data with
research-only or non-commercial terms.

## Known quirks

- **Sky is no depth, not infinitely far.** Spring's ground truth puts 0 there, and 0 is the no-depth
  code.
- **SGBM outliers:** SGBM has occasional outliers up to 63 px, the top of its 64-px search range,
  while the true maximum is 38.6 px.
  - `preview.range_px` stops at the 99.9th percentile, so they clamp there in the preview, and both layers
    have about the same preview step: 0.176 px (it was 0.310 px for `sgbm/` when the range ran to 63 px).
  - `display_range_px` (2nd–98th percentile) is unaffected.
- **Blur and focus:** Spring's images include motion blur and depth of field; its ground truth does
  not. SGBM errors in blurred areas are real errors on the input.
