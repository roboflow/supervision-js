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

## Start With Base Styles

Use `BaseBoxStyle`, `BaseMaskStyle`, and `BaseLabelStyle` for the common path:

```ts
const session = await createMediaSession({
  container,
  media,
  presentation: {
    boxStyle: new BaseBoxStyle(),
    maskStyle: new BaseMaskStyle({ alpha: 0.5 }),
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
  }),
});
```

## Static And Dynamic Values

Style options accept either static values or resolver functions. Use static
values for global styling:

```ts
const maskStyle = new BaseMaskStyle({
  alpha: 0.65,
  color: 0x38bdf8,
  stroke: {
    alpha: 1,
    color: 0xe0f2fe,
    width: 4,
  },
});
```

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

## Runtime Updates

Presentation can change without rewriting detections:

```ts
session.setPresentation({
  boxStyle,
  labelStyle,
  maskStyle,
});
```

For masks, the renderer may reuse prepared ID-mask artifacts when the new style
can be applied through the shader palette. If a style change affects which masks
exist or how mask borders are prepared, the renderer rebuilds the affected
prepared artifacts in the background.

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
