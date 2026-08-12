---
title: Interactive Picking
group: Recipes
summary: Add paused-only hover and selected detection highlights.
---

# Interactive Picking

Use interaction callbacks for app state and interaction styles for renderer-owned
hover/selected presentation.

```ts
import {
  BaseBoxStyle,
  BaseFocusStyle,
  BaseInteractionStyle,
  BaseMaskStyle,
  FocusTargetMode,
  MediaInteractionMode,
  annotationRenderers,
  createMediaSession,
} from "supervision";

const session = await createMediaSession({
  container,
  detections: {
    frames,
  },
  media: file,
  presentation: {
    focusStyle: new BaseFocusStyle({
      fill: {
        alpha: 0.5,
        color: 0x020617,
      },
      targetMode: FocusTargetMode.Selected,
    }),
    interactionStyle: new BaseInteractionStyle({
      hovered: {
        maskStyle: new BaseMaskStyle({
          color: 0x38bdf8,
          opacity: 0.18,
          stroke: { alpha: 0.9, color: 0x67e8f9, width: 3 },
        }),
      },
      selected: {
        maskStyle: new BaseMaskStyle({
          color: 0x38bdf8,
          opacity: 0.28,
          stroke: { alpha: 1, color: 0xfde047, width: 5 },
        }),
      },
    }),
    renderers: [annotationRenderers.box({ style: new BaseBoxStyle() })],
  },
  renderer: {
    interaction: {
      mode: MediaInteractionMode.PausedOnly,
      onHover(pick) {
        showHoverDetails(pick);
      },
      onSelect(pick) {
        showSelectedDetails(pick);
      },
    },
  },
});
```

The renderer picks inside the same Pixi scene that presents media and
detections. Mask hits are checked first, then box hits are used as a fallback.
The highlight layer and the focus layer are separate from masks, boxes, and
labels, so selecting a detection does not rebuild prepared mask frames. When the
active selected target has a prepared PNG ID-mask, focus rendering uses that
artifact for a shape-accurate cutout; otherwise it falls back to the detection
rectangle.

Selections with an id that is unique in both the current and next detection
frames follow that detection across frames, including while `PausedOnly`
interaction is gated during playback. Anonymous or duplicate ids remain
frame-local, and hover always remains bound to the current pointer frame.

`onSelect` and `onSelectionChange` report selection identity or membership
changes; they do not run at playback frame rate while the same id follows.
Their `DetectionPickResult` values are immutable event snapshots. When an
inspector needs current geometry, retain the selected detection id and look it
up in `session.renderer.getActiveDetectionFrame()`.

Inspector UIs can also select the active detection frame programmatically:

```ts
const activeFrame = session.renderer.getActiveDetectionFrame();

session.renderer.setSelectedDetection({
  detectionIndex: 0,
});
```

Use this for detection lists, keyboard navigation, or table-to-canvas selection
without moving selection rendering into framework state.
