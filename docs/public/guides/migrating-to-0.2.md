---
title: Migrating to 0.2
group: Guides
summary: Install the preview and update interaction highlights for the 0.2 browser API.
---

# Migrating to 0.2

Version `0.2` is currently published on npm's `next` tag. Applications using
the web video engine must install the preview explicitly:

```sh
npm install supervision@next
```

The engine remains a subpath of `supervision`; do not add a separate engine or
core package dependency.

## Indexed Frame Clocks

Indexed sources can expose `frameClock` on a session and renderer. It is `null`
for unindexed media. Use `timeAt`, `durationAt`, and `indexAtOrBefore` rather
than an assumed FPS: the table retains a nonzero first timestamp and final-frame
duration.

## Display Output

The web video engine source exposes `setDisplay()`, which rejects unless the
source uses a display-box decode strategy (configured with `display`). Other
media sources may omit the method. Send the current CSS box and device pixel ratio
through that existing session or renderer; do not rebuild the session or source
on every layout change. Calls superseded by a newer size reject with
`AbortError`.

## Interaction Highlight Styles

`BaseInteractionStyle` no longer accepts the rectangle-specific `shape`,
`cornerRadius`, `stroke`, or `fill` options. Those fields mixed box rendering
into a presentation that can now highlight masks, labels, polygons, polylines,
and keypoints as well as boxes.

Move the old rectangle options into a `BaseBoxStyle` assigned to each state.

Before:

```ts
import { BaseInteractionStyle, BoxShape } from "supervision";

const interactionStyle = new BaseInteractionStyle({
  shape: BoxShape.RoundedRect,
  cornerRadius: 8,
  stroke: { color: 0x67e8f9, width: 3 },
  fill: { color: 0x67e8f9, alpha: 0.1 },
});
```

After:

```ts
import { BaseBoxStyle, BaseInteractionStyle, BoxShape } from "supervision";

const highlight = new BaseBoxStyle({
  shape: BoxShape.RoundedRect,
  cornerRadius: 8,
  stroke: { color: 0x67e8f9, width: 3 },
  fill: { color: 0x67e8f9, alpha: 0.1 },
});

const interactionStyle = new BaseInteractionStyle({
  hovered: { boxStyle: highlight },
  selected: { boxStyle: highlight },
});
```

Use different style objects for `hovered` and `selected` when those states need
different presentation. Set either state to `null` to suppress its highlight.
Leaving a state undefined keeps the default box highlight.
