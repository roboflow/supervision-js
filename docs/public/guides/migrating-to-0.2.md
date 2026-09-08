---
title: Migrating to 0.2
group: Guides
summary: Update playback gates, playback feedback, and interaction highlights from 0.1.7.
---

# Migrating to 0.2

Version `0.2` is currently published on npm's `next` tag. Applications using
the web video engine must install the preview explicitly:

```sh
npm install supervision@next
```

The engine remains a subpath of `supervision`; do not add a separate engine or
core package dependency.

## Playback Gate Options

Check these separately when upgrading from `0.1.7`:

| Option                                                | Change in 0.2                                                                         | Migration                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `renderPreparation.playbackGate.minimumAheadSeconds`  | Removed; existing typed configuration no longer compiles.                             | Remove it. It was a soft preparation target, not an alias for another gate option.                                             |
| `renderPreparation.playbackGate.requiredAheadSeconds` | Now a **ceiling** on the prepared lead requested by a stop, not the old resume floor. | Review the value independently of detection coverage. Raising it does not request more preparation or guarantee a longer lead. |
| `detections.playbackGate.requiredAheadSeconds`        | Still a **floor**: the detections that must be available ahead of playback.           | Keep the coverage requirement your producer needs; do not reuse the preparation ceiling blindly.                               |

The two identically named `requiredAheadSeconds` options have different jobs.
Preparation pauses use `stopBelowWallSeconds` (default `0.1`) and
`resumeMarginWallSeconds` (default `0.2`), measured in viewer time. Playback rate
converts them to media time, and the preparation ceiling can shorten that wait.
For session configuration, preparation options live under
`renderer.renderPreparation`; detection options live under `detections`.

This former configuration is intentionally a compile error:

```ts
import type { MediaSessionOptions } from "supervision";

const options: MediaSessionOptions = {
  container: document.createElement("div"),
  media: "/media/example.mp4",
  renderer: {
    renderPreparation: {
      playbackGate: {
        // @ts-expect-error Removed in 0.2; delete this option.
        minimumAheadSeconds: 1,
      },
    },
  },
};

void options;
```

### Wait Bounds

Enabled gates also have new finite wait bounds. Detection coverage defaults to
`maxWaitSeconds: 10`; render preparation defaults to `maxWaitSeconds: 2`.
The `0.1.7` gate options had no such bounds. Set `maxWaitSeconds: Infinity`
explicitly when missing annotations must hold playback indefinitely, or `0`
when that gate must not hold playback. A finite bound allows playback to
continue without the unavailable annotations once its wait expires.

See [Detections and Rendering](detections-and-rendering.md) for coverage and
preparation configuration.

## Playback Feedback

`MediaRendererState` adds seven optional fields relative to `0.1.7`:

| Field                            | Use                                                                     |
| -------------------------------- | ----------------------------------------------------------------------- |
| `presentedTime`                  | Time of the video pixels on screen; `currentTime` can already be ahead. |
| `drawnMaskFrameTime`             | Detection timestamp of the mask currently drawn, or `null` when absent. |
| `maskHeldStale`                  | Reports a mask/annotation identity violation.                           |
| `playbackGateReach`              | Whether active gates apply throughout playback or are off.              |
| `renderPreparationGateAbandoned` | Preparation stopped answering within the wait bound.                    |
| `seeking`                        | Transport is settling a requested position.                             |
| `scrubbing`                      | A drag gesture is open; distinguish this from waiting after release.    |

`MediaSourceState.awaitingRead` is also new. It reports a pending source read,
not whether the entire presentation pipeline is busy. These fields are optional
so existing consumers implementing the state interfaces remain compatible.

## Indexed Navigation And Display Output

Indexed push-presented sources can now expose optional `frameClock` and
`frameNavigation` properties on the session and renderer. Keep time-based
controls for sources where either is `null`. `moveToFrame(index)` lands an
exact index; `moveToTime(seconds)` resolves the covering indexed frame. For a
drag, use `scrubToFrame()` or `scrubToTime()` while the pointer moves, then one
`moveToTime()` on release. A later scrub settles the earlier one as
`{ status: "superseded" }`, rather than rejecting it.

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
