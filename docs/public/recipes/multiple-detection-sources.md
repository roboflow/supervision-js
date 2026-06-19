---
title: Multiple Detection Sources
group: Recipes
summary: Compose several detection streams and style each source differently.
---

# Multiple Detection Sources

Use multiple sources when an app owns different detection streams for the same
media item. The library does not need to know what each stream means; it only
composes them, preserves source provenance, and lets styles branch on
`detection.sourceId`.

```ts
import {
  BaseBoxStyle,
  BaseLabelStyle,
  BaseMaskStyle,
  createMediaSession,
} from "supervision-js";

const session = await createMediaSession({
  container,
  media,
  detections: {
    sources: [
      {
        frames: baseFrames,
        id: "base",
      },
      {
        appendable: { datasetId: "overlay" },
        id: "overlay",
        order: 10,
        presentation: {
          boxStyle: new BaseBoxStyle({
            fill: { alpha: 0.18, color: 0xfacc15 },
            stroke: { alpha: 1, color: 0xfacc15, width: 3 },
          }),
          labelStyle: new BaseLabelStyle({ includeConfidence: true }),
          maskStyle: null,
        },
      },
    ],
  },
  presentation: {
    boxStyle: new BaseBoxStyle(),
    labelStyle: new BaseLabelStyle({ includeConfidence: true }),
    maskStyle: new BaseMaskStyle({ opacity: 0.65 }),
  },
});

await session.appendDetectionFrames(nextOverlayFrames, {
  sourceId: "overlay",
});
```

`presentation` is the global default. Source-level presentation overrides only
the layers it defines. Passing `null` disables that layer for the source.

The composed frame still reaches the renderer as one semantic `DetectionFrame`,
so buffering, render preparation, picking, focus, and playback synchronization
continue through the same engine path.
