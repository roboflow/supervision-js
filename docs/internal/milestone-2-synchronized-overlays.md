# Milestone 2 Synchronized Overlays

## What This Proves

This completed proof checks the next renderer-first claim: simple visual overlays can be
selected from decoded media sample timing and rendered inside the same Pixi
scene as the media texture.

The overlay input is intentionally tiny: timestamped frames with rectangle draw
instructions in media pixel coordinates. This is synchronized overlay proof
data, not an annotation schema, not a `BoundingBox` API, and not a primitive hierarchy.

## Media-Time Selection

The renderer copies and sorts proof overlay frames once when the proof is
created. On each newly presented decoded video sample, it selects the overlay
frame whose `mediaTime` / `endTime` interval contains the sample timestamp.

This means overlay state follows Mediabunny decoded sample timestamps, not
React state, `requestAnimationFrame()` time alone, or an independent app clock.
Duplicate or late samples that are not presented do not redraw overlays or count
as new presented overlay state.

## Pixi Scene Ownership

The media sprite and overlay `Graphics` live under one Pixi `Container` in media
pixel coordinates. The container is transformed for `contain` or `cover`, so the
overlay rectangles stay aligned with the uploaded media texture while the canvas
resizes.

The proof still does not create a visible DOM media element, DOM overlay, React
overlay, or Pixi `VideoSource`. The user sees one renderer-owned Pixi canvas.

## Done Criteria

- The package runtime entrypoint exposes `createMediaRenderer` plus the
  renderer string enums needed by plain JavaScript consumers.
- TypeScript-only `MediaRenderer*` interfaces describe timestamped overlay frames and
  simple rectangle draw instructions.
- The demo passes a small local synthetic overlay timeline and displays timing
  diagnostics for the active overlay frame and rect count.
- Tests prove overlay selection comes from decoded sample timestamps and that
  duplicate samples do not redraw or advance overlay diagnostics.

## Not Included

No benchmark path, labels, masks, tracks, keypoints, editing, serialization,
persistence, annotation identity, public API stability promise, or final
`BoundingBox` model is included in this milestone.
