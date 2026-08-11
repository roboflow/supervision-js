# Renderer-First Roadmap

> This document records the project's foundational sequence. Several
> capabilities originally deferred here have since landed. New visualization
> recipes and annotator facades are sequenced by the
> [annotator use-case roadmap](annotator-use-case-roadmap.md), while the
> renderer-first constraints below remain authoritative.

The first milestones should prove rendering capability before committing to a
large annotation API. Each milestone should leave the project with something
observable, measurable, and demoable.

## Milestone 1: Render Media Inside Pixi

Goal: load and display decoded media frames as a Pixi-owned texture.

For the current proof, Mediabunny owns media reading and video-frame decode from
day 0. Pixi owns only visual composition and texture presentation.

The renderer should control the visible scene rather than placing annotations
over a separate DOM media element. The first success case can be narrow: one
video source, one decode path, one Pixi application, correct sizing, and a
predictable render loop.

Done when: a local demo renders a playing video from Mediabunny-decoded frames
inside a Pixi-owned scene, resizes correctly, and exposes basic source,
playback, and frame timing diagnostics through one experimental package export.

Not included: annotation primitives, React integration, playback controls beyond
what the proof needs, or a stable public package API.

Questions to answer:

- Can media playback be represented cleanly as renderer-owned visual state?
- What proof-grade clock is sufficient for Mediabunny sample retrieval, and
  where does it break?
- What resize and device-pixel-ratio behavior is required for a credible demo?

## Milestone 2: Synchronize Simple Overlays To Media Frames

Goal: render simple visual overlays whose state is selected from media frame
timing.

The overlays should be intentionally primitive: lines, rectangles, points, or
debug text are enough. The point is media-clock alignment, not annotation
semantics.

Done when: a demo updates simple overlays from media frame timing and shows
enough timing diagnostics to evaluate timestamp or frame mismatch.

Completed Milestone 2 proof note: see
[`milestone-2-synchronized-overlays.md`](milestone-2-synchronized-overlays.md)
for the current synchronized overlay proof. It selects overlay frames from
decoded media sample timestamps and renders rectangles in the Pixi scene. It is
not an annotation schema or a `BoundingBox` API.

Not included: a formal annotation schema, editing interactions, labels, tracks,
or persistence.

Questions to answer:

- Can overlay state be selected from media frame timing instead of an independent
  app clock?
- How should the renderer receive timestamped or frame-keyed overlay data?
- What minimal timing metadata needs to be tracked across playback, pause, seek,
  and dropped-frame scenarios?

## Milestone 3: Measure Dense Simple Shapes

Goal: stress the 2D renderer with many simple shapes before adding richer
annotation types.

This should produce rough performance numbers and practical constraints for the
next design step. The project should learn from rendering pressure before
inventing APIs for boxes, masks, tracks, or labels.

Done when: the repo has a repeatable benchmark workspace that records browser,
device, Pixi backend, shape count, frame time or FPS, update strategy, whether
text is enabled, and any obvious bottlenecks.

Milestone 3 proof note: see the separate `/benchmark/initial` workspace and
[`milestone-3-dense-shape-measurement.md`](milestone-3-dense-shape-measurement.md)
for the current dense simple-shape measurement proof. It is a benchmark path
for renderer constraints, not an annotation API, not a `BoundingBox` model, and
not a performance target.

Current render strategy conclusions from that proof live in
[`render-strategy-guidelines.md`](render-strategy-guidelines.md). They keep the
first real rectangle path on Pixi `Graphics` with media-frame-keyed dirty
redraws, while leaving higher-density dynamic alternatives as future work.

Not included: final performance targets, worker architecture, masks, labels, or
general optimization work not required to understand the first bottlenecks.

Questions to answer:

- How many simple shapes can the first Pixi path render at target frame rates?
- Which operations are expensive: shape creation, per-frame mutation, text,
  masking, layer sorting, or upload bandwidth?
- Which data structures reduce churn without over-abstracting?

## Milestone 4: Introduce The Smallest Annotation Abstraction

Goal: define only the annotation concept needed by the renderer proof.

This is the first point where an abstract annotation model should appear. It
should be based on what the renderer needs to schedule, draw, update, and clear.
It should not try to cover every future primitive.

Done when: the smallest renderer-facing annotation concept is documented and
exercised by the existing renderer proof without exposing Pixi draw objects to
callers.

Not included: a comprehensive primitive taxonomy, serialization format, Python
parity layer, or multi-renderer abstraction beyond the boundary proven so far.

The abstraction should answer:

- how annotation data enters the renderer;
- how annotation lifetime is managed;
- how coordinate spaces are represented;
- how renderer-specific draw objects remain hidden from callers.

## Milestone 5: Add The First Concrete Annotation Type

Goal: add one concrete annotation type, likely a `BoundingBox`, after the
renderer has proven media rendering, synchronization, and dense simple shape
performance.

A bounding box is a good first candidate because it is common, visually simple,
and useful in demos. It should still be implemented as a measured response to
the previous milestones, not as the root of a complete primitive hierarchy.

Done when: the renderer can display and update a small set of 2D boxes through
the minimal annotation path from Milestone 4.

Not included: masks, polygons, labels, tracking semantics, editing, or parity
with Python `supervision` annotators.

## Deferred Until The Foundation Creates Constraints

The following areas are important but should wait:

- masks;
- polygons;
- labels;
- tracks and trajectories;
- keypoints and skeletons;
- dense temporal overlays;
- React integration;
- npm publishing and package ownership;
- 3D rendering and annotation.

Deferring these is not a lack of ambition. It keeps the first implementation
honest: prove renderer ownership, synchronization, and performance before
claiming an annotation framework.
