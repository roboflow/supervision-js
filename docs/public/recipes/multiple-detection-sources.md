---
title: Multiple Detection Sources
group: Recipes
summary: Compose model predictions, draft annotations, or other app-owned detection streams over one media item.
---

# Multiple Detection Sources

Use `detections.sources` when one media item needs more than one semantic
detection stream.

Common examples:

- model predictions plus app-owned draft annotations;
- accepted annotations plus the shape a user is currently drawing;
- output from two model versions for side-by-side review;
- persisted detections plus short-lived reviewer notes or correction overlays.

The library does not know those business meanings. It only composes sources,
preserves source provenance, orders detections deterministically, and lets each
source override box, mask, polygon, polyline, keypoint, and label presentation.

Do **not** use multiple sources when you only need per-class colors, confidence
filtering, or a different label format. Those are normal style concerns and are
better handled with `BaseBoxStyle`, `BaseMaskStyle`, `BaseLabelStyle`, or custom
style resolvers.

## Mental Model

One media session can read many detection sources, but the renderer still sees
one active semantic `DetectionFrame`.

```text
predictions source  ┐
draft source        ├─ composed hot frame ─ prepared artifacts ─ Pixi layers
review source       ┘
```

Copied detections receive:

- `sourceId`: the source entry that produced the detection;
- `sourceDetectionIndex`: the detection index inside that source frame before
  composition.

Those fields are provenance, not workflow state. Your app can decide that
`"draft"` means “unsaved human edits,” but `supervision-js` treats it as just
another ordered source.

## Predictions Plus Draft Annotations

This example renders model predictions as the global default source and renders
draft annotations above them with a different box/label style and no masks.

```ts
import {
  BaseBoxStyle,
  BaseLabelStyle,
  BaseMaskStyle,
  BoxShape,
  annotationRenderers,
  createMediaSession,
} from "supervision";

const PREDICTIONS_SOURCE_ID = "predictions";
const DRAFT_SOURCE_ID = "draft";

const session = await createMediaSession({
  container,
  media,
  detections: {
    sources: [
      {
        appendable: {
          datasetId: "video-123-predictions",
        },
        id: PREDICTIONS_SOURCE_ID,
        requiredForCoverage: true,
      },
      {
        appendable: {
          datasetId: "video-123-drafts",
        },
        id: DRAFT_SOURCE_ID,
        order: 10,
        presentation: {
          boxStyle: new BaseBoxStyle({
            cornerRadius: 8,
            fill: { alpha: 0.16, color: 0xf59e0b },
            shape: BoxShape.RoundedRect,
            stroke: { alpha: 1, color: 0xfbbf24, width: 4 },
          }),
          labelStyle: new BaseLabelStyle({
            background: { alpha: 0.85, color: 0x78350f },
            text: (detection) => {
              const label = detection.className ?? "object";
              const confidence =
                detection.confidence === undefined
                  ? ""
                  : ` ${Math.round(detection.confidence * 100)}%`;

              return `Draft ${label}${confidence}`;
            },
          }),
          maskStyle: null,
        },
        requiredForCoverage: false,
      },
    ],
  },
  presentation: {
    renderers: [
      annotationRenderers.box({ style: new BaseBoxStyle() }),
      annotationRenderers.label({
        style: new BaseLabelStyle({ includeConfidence: true }),
      }),
      annotationRenderers.mask({
        style: new BaseMaskStyle({ opacity: 0.65 }),
      }),
    ],
  },
});

await session.appendDetectionFrames(predictionFrames, {
  sourceId: PREDICTIONS_SOURCE_ID,
});

await session.replaceDetectionFrames(draftFrames, {
  sourceId: DRAFT_SOURCE_ID,
});
```

`requiredForCoverage` picks which entries the composed source's `waitForRange`
fans out to: predictions here, not drafts. Awaiting `waitForRange` on
`session.detectionSource` therefore returns once predictions cover the range,
while drafts may still be loading. An enabled `detections.playbackGate` awaits
that same waiter. The gate is off by default.

`order` controls draw order. Lower sources compose first. Higher sources render
later and appear on top.

## Updating One Source

When a session owns more than one appendable source, writes need a `sourceId`.

```ts
await session.appendDetectionFrames(predictionFrames, {
  sourceId: PREDICTIONS_SOURCE_ID,
});

await session.replaceDetectionFrames([currentDraftFrame], {
  sourceId: DRAFT_SOURCE_ID,
});

await session.clearDetectionFrames({
  sourceId: DRAFT_SOURCE_ID,
});
```

Appending, replacing, or clearing one source does not mutate the others. The
session composes them again when the hot window refreshes.

## Source-Level Presentation

The top-level `presentation.renderers` list selects the global annotation
renderers and supplies their styles.

A source-level `presentation` can override:

- `boxStyle`
- `maskStyle`
- `polygonStyle`
- `polylineStyle`
- `keypointStyle`
- `labelStyle`

For each selected renderer:

- `undefined` falls back to the global style;
- `null` disables that layer for detections from that source;
- a style object overrides the global style for that source.

Interaction and focus presentation remain global. If they need source-aware
behavior, branch on `detection.sourceId` inside the style resolver.

The composed frame still reaches the renderer as one semantic `DetectionFrame`,
so buffering, render preparation, picking, focus, and playback synchronization
continue through the same engine path.

## Direct Composition

Most apps should use `createMediaSession({ detections: { sources } })`. Use
`createCompositeDetectionFrameSource()` directly only when you already manage a
lower-level renderer or need to test composition outside a media session.

```ts
import { createCompositeDetectionFrameSource } from "supervision";

const source = createCompositeDetectionFrameSource({
  sources: [
    { frames: predictionFrames, id: PREDICTIONS_SOURCE_ID },
    { frames: draftFrames, id: DRAFT_SOURCE_ID, order: 10 },
  ],
});
```

## Rules Of Thumb

- Use one source for ordinary “render these detections” flows.
- Use multiple sources when the app needs separate ownership, separate writes,
  separate retention, separate presentation, or source-aware interaction.
- Keep source IDs stable and app-owned.
- Set `requiredForCoverage: false` when a source should not hold the coverage
  wait, whether that wait is your own `waitForRange` call on
  `session.detectionSource` or an enabled `detections.playbackGate`. The gate is
  off by default.
- Do not combine `detections.sources` with single-source inputs such as
  `frames`, `source`, or `appendable`.
