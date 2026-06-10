---
title: Static Detections
group: Recipes
summary: Render detections that are already available when the media session starts.
---

# Static Detections

Use static detection frames when an app already has predictions for the media.
This is the simplest way to render a fixture, cached inference result, or local
JSON file.

For a runnable version of this pattern, see `examples/vanilla` in the repo. It
uses the basketball fixture with plain TypeScript, Vite, and no framework.

```ts
import {
  BaseLabelStyle,
  BaseMaskStyle,
  BaseBoxStyle,
  BoxShape,
  createMediaSession,
  type DetectionFrame,
} from "supervision-js";

const frames: DetectionFrame[] = await fetch("/detections.json").then(
  (response) => response.json(),
);

const session = await createMediaSession({
  container,
  media: "/sample.webm",
  detections: {
    frames,
  },
  presentation: {
    boxStyle: new BaseBoxStyle({
      cornerRadius: 8,
      shape: BoxShape.RoundedRect,
      stroke: { alpha: 1, color: 0x38bdf8, width: 3 },
    }),
    labelStyle: new BaseLabelStyle({ includeConfidence: true }),
    maskStyle: new BaseMaskStyle({
      color: 0x38bdf8,
      opacity: 0.6,
      stroke: { alpha: 1, color: 0xe0f2fe, width: 3 },
    }),
  },
  renderer: {
    autoPlay: true,
    loop: true,
  },
});
```

## Frame Shape

Detection frames should use media-time seconds:

```ts
const frame: DetectionFrame = {
  detections: [
    {
      className: "person",
      confidence: 0.92,
      id: "person-1",
      rect: { x: 120, y: 80, width: 240, height: 420 },
    },
  ],
  endTime: 1 / 30,
  frameIndex: 0,
  mediaTime: 0,
};
```

Use `frameIndex` when detections came from a fixed inference frame grid. Use
`mediaTime` and `endTime` when detections came from timestamp intervals.

## Why This Works

The session treats static frames as semantic detection data. Internally, it
hydrates a hot detection window near playback, prepares renderer-friendly
artifacts for masks, and presents the active frame inside the same renderer
scene as the media.
