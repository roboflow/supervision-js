---
title: Presentation Styles
group: Guides
summary: Style boxes, masks, and labels without mutating detection data.
---

# Presentation Styles

Python `supervision` uses annotators such as `BoxAnnotator`,
`MaskAnnotator`, and `LabelAnnotator` to decide how detections are drawn.

In `supervision-js`, the equivalent concept is split into two public parts:

- **styles** resolve how detections should look;
- **annotation renderers** select which visualization capabilities contribute
  to the scene and carry their styles.

This keeps detections as semantic model output while the renderer owns the
performance-sensitive drawing strategy.

For focused, live examples, open
[Annotation Renderers](../annotation-renderers.md). Each renderer page with a
playground runs it on a committed fixture, and its controls update both the
scene and a minimal `setPresentation()` snippet.

## Start With Base Styles

Use `BaseBoxStyle`, `BaseMaskStyle`, `BasePolygonStyle`,
`BasePolylineStyle`, `BaseKeypointStyle`, `BaseLabelStyle`,
`BaseInteractionStyle`, and `BaseFocusStyle` for the common path:

```ts
const session = await createMediaSession({
  container,
  media,
  presentation: {
    focusStyle: new BaseFocusStyle(),
    interactionStyle: new BaseInteractionStyle(),
    renderers: [
      annotationRenderers.box({ style: new BaseBoxStyle() }),
      annotationRenderers.mask({
        style: new BaseMaskStyle({ opacity: 0.5 }),
      }),
      annotationRenderers.label({
        style: new BaseLabelStyle({ includeConfidence: true }),
      }),
    ],
  },
});
```

Box shape is just another style option. Use `shape` and `cornerRadius` when
rounded rectangles are the desired box treatment:

```ts
session.setPresentation({
  renderers: [
    annotationRenderers.box({
      style: new BaseBoxStyle({
        cornerRadius: 8,
        shape: BoxShape.RoundedRect,
        stroke: {
          alignment: BoxStrokeAlignment.Inside,
          color: 0x38bdf8,
          width: 3,
        },
      }),
    }),
  ],
});
```

## Smooth Annotation Edges

Enable antialiasing for the annotations, focus, and interaction overlays
with one presentation option:

```ts
session.setPresentation({ annotationAntialiasing: true });
```

`true` enables FXAA at output resolution; `false` disables smoothing. Label
backgrounds are smoothed while text stays sharp. Consecutive
labels that do not overlap can share a background capture; overlaps split
captures to preserve blending and draw order.

```ts
session.setPresentation({ annotationAntialiasing: 2 });
```

`2` applies FXAA with a capture at twice the output density in each dimension,
with four times as many capture pixels. The output canvas DPR stays unchanged.

Video frames retain their original rendering. Region effects smooth their
coverage boundary without filtering the video inside it.

Antialiasing is off by default. A 2× capture preserves mask detail
up to the original resolution before smoothing, independently of video. This adds
mask preparation work and cache bytes within the configured memory budget,
as well as rendering work and offscreen GPU textures. Motion previews use
the configured fraction of that finer mask resolution. The renderer can retain
offscreen textures for reuse after antialiasing is disabled or DPR changes.
Capture resolution adjusts to the GPU's texture-size limit on large displays.
A low-resolution mask preview still limits contour detail; use the
[mask quality controls](detections-and-rendering.md)
when more source detail is needed.

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
  shadowStroke: { alpha: 0.55, color: 0x000000, width: 6 },
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
  renderers: [
    annotationRenderers.keypoints({ style: keypointStyle }),
    annotationRenderers.polygon({ style: polygonStyle }),
    annotationRenderers.polyline({ style: polylineStyle }),
  ],
});
```

`BaseKeypointStyle` draws `NotLabeled` points as absent, `Occluded` points as
crosses, and `Visible` points as circles. Pass `definitions` when class-specific
skeleton vertices and edges need their own colors.

A contrast stroke drawn under the line keeps a thin class-colored path readable
where the media beneath it happens to share that color. `BasePolylineStyle`
takes it as `shadowStroke`, `BaseKeypointStyle` as `edgeShadowStroke`, and the
default presentation supplies one for both. Pass `null` to remove it.

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
  renderers: [
    annotationRenderers.box({ style: boxStyle }),
    annotationRenderers.keypoints({ style: keypointStyle }),
    annotationRenderers.label({ style: labelStyle }),
    annotationRenderers.mask({ style: maskStyle }),
    annotationRenderers.polygon({ style: polygonStyle }),
    annotationRenderers.polyline({ style: polylineStyle }),
  ],
});
```

The renderer list is authoritative: omit a renderer to disable it, and use an
empty list to disable every built-in annotation renderer. The direct
`boxStyle`, `maskStyle`, and related presentation fields remain supported for
compatibility and source-specific overrides, but new global presentation code
should prefer `renderers`.

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

Focus styles dim the media around the selected or hovered detections. Annotation
fills, outlines, and labels remain above the dim overlay. Masks and polygons keep
their actual shapes; heatmap cutouts follow the regions that display visible
colour, including changes to the cutoff and opacity. Other detections use the
styled rectangle fallback:

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

Set `shape: null` to disable rectangular fallback. Masks, polygons, and ready
heatmap regions still cut out their actual shapes; rectangle-only detections
remain dimmed. Heatmap cutouts use the current frame's visible heat and disappear
when that heat is absent or still loading.

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
