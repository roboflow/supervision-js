# Media Upload Benchmark

This browser-only benchmark compares the first media upload paths we could use
between Mediabunny decoded `VideoSample`s and Pixi textures.

It exists to answer a narrow renderer question:

- Are we accidentally rendering video without GPU acceleration?
- Is the current staging-canvas upload path obviously slower than direct
  `VideoFrame` or `ImageBitmap` texture sources?

## Run

```sh
npm run benchmark:media-upload:dev
```

Open:

```text
http://127.0.0.1:5178/benchmark/media-upload/
```

For a production build check:

```sh
npm run benchmark:media-upload:build
```

## Latest Local Result

Run on Chrome 149, Pixi WebGL, 1920x1080 basketball fixture, 90 measured frames
after 5 warmup frames.

| Strategy                     | Average |  Median |     p95 | Notes                                    |
| ---------------------------- | ------: | ------: | ------: | ---------------------------------------- |
| CanvasSource staging canvas  | 0.136ms | 0.100ms | 0.300ms | Current production path                  |
| ImageSource from VideoFrame  | 0.134ms | 0.100ms | 0.300ms | Requires careful frame lifetime handling |
| ImageSource from ImageBitmap | 0.128ms | 0.100ms | 0.300ms | Extra bitmap allocation/close step       |

## Interpretation

The renderer is using Pixi WebGL, so the demo is not rendering media and
annotations as an unaccelerated DOM/canvas overlay. The current production path
does draw each decoded `VideoSample` into a staging canvas, then updates a Pixi
texture, but that measured cost is effectively tied with direct `VideoFrame`
and `ImageBitmap` texture sources on this fixture.

The direct `VideoFrame` path is still worth revisiting later if a longer
benchmark shows a real win, but it has a lifecycle hazard: the sample/frame must
stay alive until Pixi has safely uploaded/rendered the texture. The current
staging-canvas path copies the frame immediately, which is boring and robust.

For now, visible playback cost is more likely to come from prepared artifact
scheduling, masks, labels, boxes, React readouts, or GPU memory pressure than
from the media upload path itself.
