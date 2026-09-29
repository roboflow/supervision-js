# Pebbles anomaly heatmap fixture

The semantic detections and scalar heatmaps come from Patrick's
`anomaly-in-pebbles-detections` export, not from the earlier whole-frame,
1024-pixel inference attempt. `raw-patrick-detections.json` preserves its 341
frame tracker output. The model ran on overlapping 512 x 512 tiles of the
3600 x 1570 source; Patrick stitched selected tile maps as 16-bit grayscale
PNGs and confirmed two temporal tracks (bolt #5 and stick #23).

`tools/anomaly-fixture/from-patrick.py` converts confirmed tracks to the normal
`DetectionFrame` chunk schema. Each `Detection` has the original tracker box,
class name, tracker ID and state. Only a tracker hit gets a `heatmap`: a crop
of the stitched scalar map around its matched hot spot, with 2 x 2 max pooling
and `valueScale: 1/65535`. The crop's `bounds` remain in source-video pixels.
The renderer applies a palette later. On a coast frame, the track box remains
but there is no invented heatmap. False-positive hot spots that did not confirm
as tracks are excluded from the detections; they remain in the raw export.

The supplied `source_stabilized_crop_4k.mp4` declares 341 frames but has a
corrupt H.264 packet near frame 319 and only 320 frames decode. The committed
`pebbles-1800.mp4` is a 320-frame, 1800 x 784 viewing proxy for the first 320
source frames. The manifest correctly declares detection coordinates as
3600 x 1570, so the renderer projects them onto the proxy. The final 21
Patrick frames are preserved in the raw export but are not currently playable.
Replace the proxy and regenerate the fixture when an intact source video is
available; do not pad the missing frames or shift later detections.

The repository maintainer confirmed on 2026-09-29 that the supplied video may
be redistributed here as this derived viewing proxy. The supplied source file
has SHA-256
9bd1200638abfccac5c46bc97f422745599f86e1e956a453cc18abb1af5507f1;
the committed `pebbles-1800.mp4` proxy has SHA-256
`80ea154050e73673f63eff73cf64d78bee4783b0588a4e033d9b286c88ba9045`.
The proxy was regenerated with FFmpeg 7.1 from that source using:

```sh
ffmpeg -hide_banner -loglevel error \
  -i /path/to/source_stabilized_crop_4k.mp4 \
  -frames:v 320 -vf scale=1800:784:flags=lanczos \
  -c:v libx264 -preset medium -crf 28 -pix_fmt yuv420p \
  -an -movflags +faststart -y \
  demo/fixtures/pebbles_anomaly/pebbles-1800.mp4
```

FFmpeg reports a decode error at the corrupt packet while producing the 320
valid frames. Check the output frame count and hash before regenerating the
fixture; different FFmpeg/libx264 builds may not produce identical bytes.

Rebuild with the bundled Python runtime (requires NumPy and Pillow):

```sh
python3 tools/anomaly-fixture/from-patrick.py \
  --source /path/to/anomaly-in-pebbles-detections \
  --destination demo/fixtures/pebbles_anomaly \
  --media /path/to/pebbles-1800.mp4 \
  --frame-count 320
```
