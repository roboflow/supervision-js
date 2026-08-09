# Generic Vector Primitives Proposal

Status: proposal for the annotator roadmap's third foundation PR; nothing in
this document is implemented

Last reviewed: August 9, 2026

Scope: renderer-neutral shape instruction contracts and their browser renderer
support; no annotator facades, no public API commitment until reviewed

## Purpose

The [annotator use-case roadmap](annotator-use-case-roadmap.md) sequences a
"generic vector primitives" foundation PR before the Tier 1 geometry facades.
This document proposes the concrete instruction contracts, renderer plan, and
compatibility rules for that PR so the work can be reviewed against real
consumers before any code lands.

## Evidence From The Demo Workbench

The demo's annotator picker (PR #59) pushed the existing primitives as far as
they go. Every shipped variant lowers to `BoxDrawInstruction`:

- Box corners reuse the dashed stroke with a per-detection dash pattern.
- Circles and dots reuse `BoxShape.RoundedRect` with a full corner radius.
- The ellipse ground marker is a capsule approximation of Python's
  `EllipseAnnotator` arc, documented as such in the demo source.

The remaining Tier 1 use cases cannot be expressed honestly:

- True elliptical arcs (`EllipseAnnotator` start/end angles, covariance
  ellipses for `VertexEllipse*`) have no instruction type.
- Anchored polygon markers (`TriangleAnnotator`) have no instruction type.
- `packages/web/src/renderers/pixi-vector-layer.ts` skips any detection with
  no semantic polygon, polyline, or keypoints before calling style resolvers,
  so resolver-synthesized geometry cannot render for box-only detections.
  That gate is correct today (it avoids resolving styles that cannot draw)
  and must stay for purely semantic styles.

## Design Principles

Restating the roadmap constraints this PR must satisfy:

- Instruction contracts live in `packages/core` and stay renderer-neutral: no
  Pixi, DOM, worker, or vendor types.
- New capabilities are additive. A presentation that configures none of them
  renders byte-for-byte as today, including the vector layer's early skip.
- Decorations do not become editable annotations and do not pick by default.
- Coordinate space is explicit per instruction, not implied.
- Backends declare a supported subset; unsupported recipes fail validation
  rather than silently dropping.
- Temporal behavior is out of scope; these primitives are stateless per frame.

## Proposed Instruction Contracts

Naming and field details are open; the shapes below are the proposal.

### Ellipse

```ts
export interface EllipseDrawInstruction {
  readonly center: Point;
  readonly radiusX: number;
  readonly radiusY: number;
  /** Rotation in radians around the center. */
  readonly rotation?: number;
  /** Arc range in radians; omitted means a closed ellipse. */
  readonly startAngle?: number;
  readonly endAngle?: number;
  readonly fill?: BoxFillStyle;
  readonly stroke?: BoxStrokeStyle;
}
```

Covers: `CircleAnnotator` (equal radii), `EllipseAnnotator` (arc range),
`VertexEllipseArea/Outline` (rotation plus covariance-derived radii). The
existing dashed-stroke contract applies by sampling the arc into a polyline
with a deterministic segment count.

### Marker

```ts
export enum MarkerShape {
  Circle = "circle",
  Cross = "cross",
  Square = "square",
  Triangle = "triangle",
}

export enum MarkerSizeSpace {
  Media = "media",
  Screen = "screen",
}

export interface MarkerDrawInstruction {
  readonly point: Point;
  readonly shape: MarkerShape;
  /** Marker diameter in the declared size space. */
  readonly size: number;
  readonly sizeSpace: MarkerSizeSpace;
  readonly rotation?: number;
  readonly fill?: BoxFillStyle;
  readonly stroke?: BoxStrokeStyle;
}
```

Covers: `DotAnnotator`, `TriangleAnnotator`, and future icon anchoring.
Screen-space sizing follows the existing convention that stroke widths are
screen pixels divided by the viewport scale. Keypoint markers
(`KeypointMarkerShape`) could eventually lower to this instruction, but that
unification is explicitly not part of the foundation PR.

### Path

```ts
export interface PathDrawInstruction {
  /** Disconnected subpaths sharing one style. */
  readonly segments: readonly (readonly Point[])[];
  readonly closed: boolean;
  readonly fill?: BoxFillStyle;
  readonly stroke: BoxStrokeStyle;
}
```

Covers: `BoxCornerAnnotator` as four true open subpaths (replacing the demo's
dash workaround), oriented quadrilaterals lowered from
`mask-min-area-rect-v1`, and later media-space zone guides. Reuses the
existing dashed-path renderer.

### Explicitly Deferred

- Text anchors: needed by `VertexLabelAnnotator` and `PercentageBarAnnotator`
  text, but they belong with the label layer and should be designed with the
  first facade that needs them.
- Solid bars: `PercentageBarAnnotator` composes two filled paths plus text;
  blocked on text anchors, not on these primitives.
- Media effects, temporal fields, and HUD elements: separate foundation PRs
  per the roadmap.

## Exposure Through The Composition Contract

The roadmap forbids new singleton `MediaRendererPresentation` properties per
feature. These primitives should surface through the recipe composition
contract (foundation PR 2), conceptually:

```ts
session.setPresentation({
  boxStyle,
  layers: [
    annotationLayers.markers({
      anchor: "bottom-center",
      shape: MarkerShape.Triangle,
      size: 12,
    }),
  ],
});
```

A shape recipe declares stable identity, phase and ordering, coordinate
space, pick behavior (none by default), and a resolver from detection and
style context to zero or more instructions.

Recommended sequencing: land the composition contract first, then this
primitives PR against it. The contracts above are written so both PRs can be
reviewed together; if the composition contract slips, an interim internal-only
consumer (for example lowering keypoint markers) could exercise the renderer
without any public exposure, at the cost of throwaway wiring.

## Renderer Plan (packages/web)

- A pooled shape layer mirrors the vector layer's retained-entry model:
  per-detection display objects, cleared and redrawn only when the frame,
  style version, or viewport scale changes.
- The semantic-geometry skip stays for semantic styles. Detections are
  offered to shape recipes based on the recipe's declared anchor requirement
  (for example `rect`), so a frame with no active shape recipes takes exactly
  today's path.
- Batching per primitive kind, not per facade, per the roadmap's performance
  requirements; no per-frame create/destroy churn.
- Ellipse rendering uses the backend's native ellipse/arc path; dashed arcs
  sample deterministically so both rasterizers agree structurally.
- Picking: shape instructions are not pickable. A facade that needs picking
  must map to an existing semantic pick target explicitly; extending
  `DetectionPickTarget` is out of scope here.

## Capability Reporting

`supervision-js-react-native` declares which instruction kinds its Skia
mapping supports. Configuring an unsupported recipe on a backend produces a
validation error listing the unsupported kinds. No silent omission.

## Facades Unblocked

Each remains exactly one PR after this foundation lands, with frozen fixture
evidence per the delivery ledger:

| Facade                          | Lowering                                  |
| ------------------------------- | ----------------------------------------- |
| `TriangleAnnotator`             | one triangle marker at a box anchor       |
| `DotAnnotator`                  | one circle marker at a box anchor         |
| `CircleAnnotator`               | ellipse with equal radii                  |
| `EllipseAnnotator`              | ellipse arc (replaces demo capsule)       |
| `BoxCornerAnnotator`            | four open subpaths (replaces demo dashes) |
| `OrientedBoxAnnotator`          | closed path from derived quadrilateral    |
| `VertexEllipseAreaAnnotator`    | covariance utility plus filled ellipse    |
| `VertexEllipseOutlineAnnotator` | covariance utility plus stroked ellipse   |

The demo workbench migrates its approximations to the true primitives in the
same PRs, keeping its picker UI unchanged.

## Fixture And Validation Plan

- `basketball_geometry` already provides rects, masks, and keypoints for
  marker and ellipse coverage; `people_walking_detection_v1` (foundation
  PR 1) is the roadmap's dense-marker target and should precede or accompany
  the first marker facade.
- Pure resolution tests in core; browser renderer tests in web; tolerant
  visual comparisons per the roadmap's reference-validation section.
- The dense-shape benchmark gains marker and ellipse layers; the PR must show
  unchanged numbers when no shape recipes are configured.
- Presentation semantics change, so tarball validation in an external
  consumer (`package:tarball:smoke`) is required.

## Open Questions

1. Land after the composition contract (recommended above), or first with an
   internal-only consumer?
2. One generic shape layer or per-primitive layers, given batching goals?
3. Should keypoint markers eventually lower to `MarkerDrawInstruction`, and
   if so, in which PR?
4. Is `MarkerSizeSpace` the right sizing model, or should markers follow the
   stroke-width convention of always being screen pixels?
5. Do the first facades justify `rotation` on markers, or should it wait for
   the icon/atlas work?
6. Which anchor vocabulary should recipes use (`bottom-center`, keypoint
   index, polygon centroid), and does it belong to the composition contract
   instead of this PR?
