# Vector Shape Renderer Kinds Proposal

Status: proposal for the annotator roadmap's vector-primitives foundation and
its first renderer kinds; revised for the unified annotation renderer
presentation

Last reviewed: August 11, 2026

Scope: internal shape instruction contracts, their browser lowering, and the
delivery contract for the annotation renderer kinds built on them

## Purpose

The [annotator use-case roadmap](annotator-use-case-roadmap.md) sequences a
"generic vector primitives" foundation before the Tier 1 geometry facades.
`MediaRendererPresentation.renderers` is now the single authoritative
rendering surface, so this document proposes:

- the internal shape instruction contracts and their vector-layer lowering;
- how each visible capability enters as a registered `AnnotationRenderer`
  kind; and
- the delivery bundle every renderer-kind PR must ship.

## Architecture

### Renderer kinds are the public unit

Each new capability is one entry in the established registry pattern:

- a kind literal added to `annotationRendererKinds`;
- a typed descriptor (`{ id, kind, style? }`) in the descriptor union;
- a factory on `annotationRenderers`;
- a registry entry pairing the kind with its presentation style field and
  canonical default style.

The renderer list keeps full authority: `renderers: []` disables the
capability, listed order and identity semantics apply unchanged, and source
overrides refine a listed renderer without re-enabling an omitted one.

```ts
session.setPresentation({
  renderers: [
    annotationRenderers.box(),
    annotationRenderers.ellipse(),
    annotationRenderers.triangleMarker({ style: triangleStyle }),
  ],
});
```

### Shape instructions are internal lowering

Kind styles resolve semantic detections into renderer-neutral shape
instructions; backends translate those into drawing commands. The instruction
contracts live in `packages/core` behind the internal package boundary and do
not appear in the public `supervision` entrypoint:

- `EllipseShapeInstruction` — center, independent radii, rotation, optional
  arc range. Lowers `CircleAnnotator` (equal radii), `EllipseAnnotator`
  (open arc), and later `VertexEllipse*` (covariance-derived radii).
- `MarkerShapeInstruction` — anchored circle/cross/square/triangle with an
  explicit media-or-screen size space. Lowers `DotAnnotator`,
  `TriangleAnnotator`, and later icon anchoring.
- `PathShapeInstruction` — disconnected subpaths sharing one style, reusing
  the dashed-stroke contract. Lowers `BoxCornerAnnotator`, oriented
  quadrilaterals, and later zone guides.

The browser vector layer consumes them through an internal hook and keeps its
semantic-geometry skip byte-identical whenever no shape-backed kind is
configured. This half is implemented internally by the shape foundation PR
and stays without public surface until the first kind lands.

## Delivery Contract

Every renderer-kind PR ships, in the same PR:

1. the kind, descriptor, factory, and registry entry;
2. the scene wiring from the registry to the internal shape hook;
3. a focused public docs page and navigation entry under
   `docs/public/annotation-renderers/`;
4. a playground backed by committed real fixture data with focused controls
   (no docs-only detections);
5. a synchronized minimal `session.setPresentation({ renderers: [...] })`
   snippet;
6. pure resolution tests, browser lowering tests, and visual evidence;
7. package-smoke and docs-contract updates for the new public names.

Exactly one renderer kind per PR. A checklist item without its consumer proof
does not count as complete.

## Proposed Renderer Kind Sequence

| Kind (working name) | Lowers to                                        | Fixture evidence              |
| ------------------- | ------------------------------------------------ | ----------------------------- |
| `ellipse`           | ellipse arc at the box base                      | basketball / horse rects      |
| `dotMarker`         | circle marker at the box center                  | basketball / horse rects      |
| `triangleMarker`    | triangle marker above the box                    | basketball / horse rects      |
| `boxCorner`         | four open subpaths                               | basketball / horse rects      |
| `circle`            | ellipse with equal radii                         | basketball / horse rects      |
| `percentageBar`     | track and value closed paths                     | basketball rects + confidence |
| `icon`              | image icon instruction (separate primitive PR)   | basketball / horse classes    |
| `maskHalo`          | blurred prepared id mask (separate primitive PR) | basketball / horse masks      |
| `vertexEllipse*`    | covariance utility plus ellipse                  | basketball keypoints (later)  |

Naming is open; kinds stay camelCase alongside the existing vocabulary.

## Sizing, Determinism, And Capability Rules

- Marker sizing declares its space explicitly; screen-space sizes divide by
  the viewport scale exactly like stroke widths.
- Ellipse arcs sample into a deterministic segment count so every backend
  rasterizes the same structural geometry, including dashed strokes.
- Shape decorations are presentation only: never pickable, never editable,
  no caching or media-time semantics.
- `supervision-js-react-native` declares its supported kinds; configuring an
  unsupported kind fails validation instead of silently dropping.

## Open Questions

1. Should keypoint markers eventually lower to `MarkerShapeInstruction`, and
   in which PR?
2. Do the first kinds justify marker `rotation`, or does it wait for the
   icon/atlas work?
3. Registry style fields: one presentation field per kind (matching the
   existing pattern) — confirm the naming convention for shape-backed kinds.
4. Which kinds should the React Native backend support first?

## Decision

Land the internal shape foundation first (no public surface), then one
renderer kind per PR through the registry with the full delivery bundle. The
central invariant is unchanged:

> A new renderer kind may compile to internal shape instructions, but it must
> not change the meaning, lifecycle, identity, editability, or cache behavior
> of existing detections and renderers, and `renderers` remains the single
> authoritative surface.
