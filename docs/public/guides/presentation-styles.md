---
title: Presentation Styles
group: Guides
summary: Style boxes, masks, and labels without mutating detection data.
---

# Presentation Styles

Python `supervision` uses annotators such as `BoxAnnotator`,
`MaskAnnotator`, and `LabelAnnotator` to decide how detections are drawn.

In `supervision-js`, the equivalent concept is split into two parts:

- **styles** resolve how detections should look;
- **renderer layers** draw those resolved instructions efficiently.

This keeps detections as semantic model output while the renderer owns the
performance-sensitive drawing strategy.

For focused, live examples, open [Visualization Layers](../visualization-layers.md).
Each existing layer has a basketball fixture playground whose controls update
both the renderer and a minimal `setPresentation()` snippet.

## Start With Base Styles

Use `BaseBoxStyle`, `BaseMaskStyle`, `BasePolygonStyle`,
`BasePolylineStyle`, `BaseKeypointStyle`, `BaseLabelStyle`,
`BaseInteractionStyle`, and `BaseFocusStyle` for the common path:

```ts
const session = await createMediaSession({
  container,
  media,
  presentation: {
    boxStyle: new BaseBoxStyle(),
    focusStyle: new BaseFocusStyle(),
    interactionStyle: new BaseInteractionStyle(),
    maskStyle: new BaseMaskStyle({ opacity: 0.5 }),
    labelStyle: new BaseLabelStyle({ includeConfidence: true }),
  },
});
```

Box shape is just another style option. Use `shape` and `cornerRadius` when
rounded rectangles are the desired box treatment:

```ts
session.setPresentation({
  boxStyle: new BaseBoxStyle({
    cornerRadius: 8,
    shape: BoxShape.RoundedRect,
    stroke: {
      alignment: BoxStrokeAlignment.Inside,
      color: 0x38bdf8,
      width: 3,
    },
  }),
});
```

## Static And Dynamic Values

Style options accept either static values or resolver functions. Use static
values for global styling:

```ts
const maskStyle = new BaseMaskStyle({
  color: 0x38bdf8,
  mode: MaskRenderMode.FillAndStroke,
  opacity: 0.65,
  stroke: {
    alpha: 1,
    color: 0xe0f2fe,
    width: 4,
  },
});
```

Use `MaskRenderMode.FillOnly` or `MaskRenderMode.StrokeOnly` for fill-only or
outline-only masks. Stroke-only masks default to a 1px same-color outline when
no explicit stroke is provided.

Use resolver functions for per-class, per-confidence, or frame-aware styling:

```ts
const boxStyle = new BaseBoxStyle({
  cornerRadius: (detection) => (detection.className === "basketball" ? 999 : 8),
  fill: (detection) => ({
    alpha: 0.15,
    color: detection.className === "person" ? 0x22c55e : 0xa855f7,
  }),
  shape: BoxShape.RoundedRect,
  shouldRender: (detection) => (detection.confidence ?? 0) >= 0.5,
  stroke: (detection) => ({
    alpha: 1,
    color: detection.className === "person" ? 0x22c55e : 0xa855f7,
    width: 3,
  }),
});
```

Keep box variants in options rather than wrapper classes. That makes the style
surface easier to compose as more visual knobs arrive.

## Labels

Labels resolve from `className`, `metadata.label`, or a custom `text`
resolver. Confidence can be included without storing display text on the
detection:

```ts
const labelStyle = new BaseLabelStyle({
  background: (detection) => ({
    alpha: 0.78,
    color: detection.className === "basketball" ? 0x7c2d12 : 0x111827,
  }),
  includeConfidence: true,
  textStyle: {
    color: 0xffffff,
    fontSize: 14,
    fontWeight: "700",
  },
});
```

Use `offset` when labels need to move away from the default top-left box edge:

```ts
const labelStyle = new BaseLabelStyle({
  background: {
    cornerRadius: 6,
    paddingX: 8,
    paddingY: 4,
  },
  includeConfidence: true,
  offset: (detection) => ({
    x: detection.className === "basketball" ? 4 : 0,
    y: 8,
  }),
  placement: LabelPlacement.Bottom,
});
```

Set labels to appear only for the active hover target when persistent labels
would be too dense:

```ts
const labelStyle = new BaseLabelStyle({
  includeConfidence: true,
  visibilityMode: LabelVisibilityMode.HoveredOnly,
});
```

## Polygons, Polylines, And Keypoints

Vector geometry uses the same static-or-resolver style model:

```ts
const polygonStyle = new BasePolygonStyle({
  fill: { alpha: 0.18, color: 0x22c55e },
  stroke: { alpha: 1, color: 0x86efac, width: 3 },
});

const polylineStyle = new BasePolylineStyle({
  stroke: { alpha: 1, color: 0x38bdf8, width: 4 },
});

const keypointStyle = new BaseKeypointStyle({
  edgeShadowStroke: { alpha: 0.65, color: 0x000000, width: 4 },
  edgeStroke: { alpha: 1, color: 0x22c55e, width: 2 },
  markerFill: { alpha: 1, color: 0x22c55e },
  markerStroke: { alpha: 1, color: 0xffffff, width: 2 },
  radius: 6,
});

session.setPresentation({
  keypointStyle,
  polygonStyle,
  polylineStyle,
});
```

`BaseKeypointStyle` draws `NotLabeled` points as absent, `Occluded` points as
crosses, and `Visible` points as circles. Pass `definitions` when class-specific
skeleton vertices and edges need their own colors.

## Consistent Class Colors

Use the shared resolver when boxes, masks, labels, polygons, and keypoints
should agree on class color:

```ts
const boxStyle = new BaseBoxStyle({
  stroke: (detection) => ({
    alpha: 1,
    color: resolveDetectionClassColorStyle(detection.className).stroke,
    width: 3,
  }),
});

const labelStyle = new BaseLabelStyle({
  background: (detection) => ({
    alpha: 0.85,
    color: resolveDetectionClassColorStyle(detection.className).labelBackground,
  }),
  textStyle: (detection) => ({
    color: resolveDetectionClassColorStyle(detection.className).labelText,
  }),
});
```

Known classes use `DEFAULT_DETECTION_CLASS_STYLES`. Unknown names are normalized
and deterministically assigned from `DEFAULT_DETECTION_COLOR_SEQUENCE`.

## Runtime Updates

Presentation can change without rewriting detections:

```ts
session.setPresentation({
  boxStyle,
  keypointStyle,
  labelStyle,
  maskStyle,
  polygonStyle,
  polylineStyle,
});
```

Pass `null` for a layer to disable it. Omit a property to leave the current
layer unchanged.

Global annotation visibility can hide annotations, labels, classes, or specific
detection IDs without mutating semantic frames:

```ts
session.setPresentation({
  visibility: {
    hiddenClasses: ["background"],
    hiddenDetectionIds: ["suppressed-1"],
    labelsHidden: false,
  },
});
```

For masks, the renderer may reuse prepared ID-mask artifacts when the new style
can be applied through the shader palette. If a style change affects which masks
exist or how mask borders are prepared, the renderer rebuilds the affected
prepared artifacts in the background.

Interaction styles draw hover and selected states in a separate overlay layer.
They resolve to the same box, mask, and label style contracts as the base
presentation. Pointer movement does not rebuild prepared mask artifacts:

```ts
session.setPresentation({
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
});
```

Focus styles dim the rest of the media around the selected or hovered
detections. The renderer may use the prepared PNG ID-mask artifact for
shape-accurate mask cutouts and falls back to detection rectangles when no mask
artifact is available:

```ts
session.setPresentation({
  focusStyle: new BaseFocusStyle({
    fill: {
      alpha: 0.5,
      color: 0x020617,
    },
    targetMode: FocusTargetMode.Selected,
  }),
});
```

## Custom Styles

Custom styles implement the same `resolve(detection, context)` contract as the
base styles. Return a draw instruction to render the detection, or `undefined`
to skip it.

```ts
const onlyPlayers: BoxStyle = {
  resolve(detection) {
    if (detection.className !== "player" || !detection.rect) {
      return undefined;
    }

    return {
      rect: detection.rect,
      shape: BoxShape.Rect,
      stroke: {
        alpha: 1,
        color: 0xfacc15,
        width: 2,
      },
    };
  },
};
```

Keep style decisions in styles. Keep detection frames focused on model output:
geometry, masks, class names, confidence, ids, and metadata.
