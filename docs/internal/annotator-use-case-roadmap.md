# Annotator Use-Case Roadmap

Status: active contribution and sequencing guide

Last reviewed: August 21, 2026

Scope: browser visualization capabilities; this is not an API commitment

## Purpose

Python Supervision provides a useful catalog of computer-vision visualization
use cases. `supervision-js` should learn from that catalog without recreating
its class hierarchy or making one renderer implementation per Python
annotator.

This roadmap defines how contributors can expand those use cases safely:

- build on the session-first browser API;
- keep detections semantic and renderer-neutral;
- express familiar annotators as composable facades over a small set of recipes
  and rendering primitives;
- use reproducible, frozen fixture data rather than live inference in tests or
  demos;
- deliver one new annotator facade per pull request;
- land foundational geometry and runtime capabilities before compound facades.

The word **annotator** is used for the familiar user-facing capability. Inside
the library, an annotator should normally lower to reusable recipes, layers,
and backend primitives. This roadmap targets use-case parity where it is useful,
not API parity with Python Supervision.

## Relationship To The Renderer Roadmap

The [renderer-first roadmap](renderer-first-roadmap.md) records the foundation:
renderer-owned media composition, media-time synchronization, measured shape
rendering, and the smallest useful semantic model. Those constraints continue
to apply.

This document begins after that foundation. It does not replace the primary
`MediaSession` API, promote PixiJS into public types, or turn
`MediaRendererPresentation` into a Python compatibility layer.

## Goals

- Cover the most useful Python annotator scenarios in browsers.
- Make common visualizations discoverable through familiar names.
- Compose multiple visual treatments over the same semantic detections.
- Keep the normal API framework-agnostic and independent of React.
- Preserve existing presentation, editing, picking, timing, and cache behavior.
- Keep PixiJS private to the browser backend.
- Let other backends declare a supported subset explicitly.
- Build deterministic fixtures that Python and JavaScript reference renderers
  can consume.
- Make every new annotator independently reviewable and measurable.

## Non-Goals

- Reproduce Python constructor signatures or inheritance.
- Promise every Python annotator on a fixed schedule.
- Create one Pixi container or renderer class per facade.
- Guarantee pixel-identical OpenCV and PixiJS rasterization.
- Put tracking, persistence, or product-specific analytics in the renderer.
- Expose Pixi containers, shaders, filters, textures, or display objects as the
  public extension API.
- Change current rendering when no new layers are configured.
- Run inference from unit tests, documentation, or the hosted demo.

## Existing Foundation

The current package already separates the important responsibilities:

- `Detection` owns semantic geometry, class, confidence, metadata, and masks.
- `MediaRendererPresentation` owns renderer-neutral styles and interaction
  presentation.
- `MediaSession` owns media, detection-source, rendering, playback, and
  preparation lifecycles.
- `packages/web` owns PixiJS, Mediabunny, browser workers, storage adapters, and
  prepared browser artifacts.
- host applications own controlled product state, persistence, undo/redo, and
  domain analytics.
- the post-processing pipeline owns bounded causal ordering and browser-worker
  execution for semantic transforms such as SORT tracking; the renderer only
  consumes observed detections with derived tracking identity.

The presentation now has a built-in renderer list. A consumer can
configure the existing annotation renderers through one public surface while
the browser backend continues to use the established specialized box, mask,
label, polygon, polyline, and keypoint paths. The multi-instance `region`
renderer now composes both external assets and crops from the current media
frame without adding another decoder or canvas readback. The next missing
capability is replacement coverage and prepared region effects. A consumer
should eventually be able to request a presentation such as:

```text
mask + halo + box corners + label + confidence bar + trace
```

without adding a new singleton property to `MediaRendererPresentation` for
every possible feature.

## Capability Map

This inventory is based on the 32 public annotators in Python Supervision
0.30.0. It is a source of use cases, not a public delivery promise.

| Python use case                 | Current JavaScript status | Proposed JavaScript expression                           |
| ------------------------------- | ------------------------- | -------------------------------------------------------- |
| `BoxAnnotator`                  | Covered                   | Existing box style and renderer                          |
| `RoundBoxAnnotator`             | Covered                   | Existing rounded box shape                               |
| `ColorAnnotator`                | Covered in essence        | Fill-only box recipe                                     |
| `MaskAnnotator`                 | Covered                   | Existing mask style and prepared artifacts               |
| `PolygonAnnotator`              | Covered in essence        | Polygon style or mask-derived polygon treatment          |
| `LabelAnnotator`                | Covered                   | Existing label style with extensible anchors             |
| `RichLabelAnnotator`            | Covered in essence        | Normal browser text and label recipe                     |
| `VertexAnnotator`               | Covered                   | Existing keypoint markers                                |
| `EdgeAnnotator`                 | Covered                   | Existing skeleton edges                                  |
| `OrientedBoxAnnotator`          | Partial                   | Oriented quadrilateral lowered to polygon/path geometry  |
| `BoxCornerAnnotator`            | Planned                   | Four open path segments                                  |
| `CircleAnnotator`               | Planned                   | Ellipse or marker derived from detection bounds          |
| `EllipseAnnotator`              | Planned                   | Ellipse/path derived from detection bounds               |
| `DotAnnotator`                  | Planned                   | Anchored marker                                          |
| `TriangleAnnotator`             | Planned                   | Anchored polygon marker                                  |
| `IconAnnotator`                 | Covered in essence        | Asset-backed region anchored to semantic geometry        |
| `PercentageBarAnnotator`        | Planned                   | Composite rectangles with numeric resolver               |
| `VertexLabelAnnotator`          | Planned                   | Per-keypoint text recipe                                 |
| `VertexEllipseAreaAnnotator`    | Planned                   | Covariance utility plus filled ellipse                   |
| `VertexEllipseOutlineAnnotator` | Planned                   | Covariance utility plus stroked ellipse                  |
| `VertexEllipseHaloAnnotator`    | Planned                   | Covariance utility plus halo effect                      |
| `HaloAnnotator`                 | Planned                   | Prepared mask halo effect                                |
| `BlurAnnotator`                 | Planned                   | Media effect clipped by semantic geometry                |
| `PixelateAnnotator`             | Planned                   | Pixelation clipped by semantic geometry                  |
| `BackgroundOverlayAnnotator`    | Partial                   | Generalized complement-of-region spotlight               |
| `CropAnnotator`                 | Covered in essence        | Media-backed region crop at a detection anchor           |
| `TraceAnnotator`                | Planned                   | Deterministic media-time trace                           |
| `HeatMapAnnotator`              | Planned                   | Deterministic timeline heat field                        |
| `ComparisonAnnotator`           | Planned                   | Pure two-source comparison transform plus normal recipes |
| `LineZoneAnnotator`             | Planned                   | Media-space guide consuming external analytical state    |
| `PolygonZoneAnnotator`          | Planned                   | Polygon guide consuming external analytical state        |
| `LineZoneAnnotatorMulticlass`   | Planned                   | Viewport HUD consuming external analytical state         |

`supervision-js` also supports polylines as a general primitive outside the
Python annotator catalog.

Sources:

- [Python detection annotators](https://github.com/roboflow/supervision/blob/0.30.0/src/supervision/annotators/core.py)
- [Python keypoint annotators](https://github.com/roboflow/supervision/blob/0.30.0/src/supervision/key_points/annotators.py)
- [Python line-zone implementation](https://github.com/roboflow/supervision/blob/0.30.0/src/supervision/detection/line_zone.py)
- [Python polygon-zone implementation](https://github.com/roboflow/supervision/blob/0.30.0/src/supervision/detection/tools/polygon_zone.py)
- [Public annotator gallery](https://supervision.roboflow.com/latest/detection/annotators/)

## Composition Direction

Named facades are valuable for discoverability. They should lower to a smaller
set of renderer-neutral recipes:

- boxes and rounded boxes;
- open and closed paths;
- ellipses;
- anchored markers;
- text and labels;
- solid bars;
- sprites and media crops;
- mask and region effects;
- temporal fields;
- media-space guides;
- viewport-space HUD elements.

Examples:

```text
BoxCorner     -> four open paths
Circle        -> ellipse with equal radii
Dot           -> anchored circle marker
Triangle      -> anchored polygon marker
PercentageBar -> background rectangle + value rectangle + optional text
VertexLabel   -> one label per visible keypoint
PolygonZone   -> polygon path + count label
LineZone      -> line path + endpoint markers + count labels
```

The renderer-first public shape is:

```ts
session.setPresentation({
  renderers: [
    annotationRenderers.box({ style: boxStyle }),
    annotationRenderers.mask({ style: maskStyle }),
    annotationRenderers.label({ style: labelStyle }),
    annotationRenderers.boxCorners({
      stroke: detectionClassStroke,
    }),
    annotationRenderers.percentageBar({
      value: (detection) => detection.confidence ?? 0,
    }),
    annotationRenderers.trace({
      anchor: "bottom-center",
      identity: (detection) => detection.id,
      windowSeconds: 1.5,
    }),
  ],
});
```

The renderer names beyond the currently implemented set remain illustrative.
Each addition must justify its exact semantic API with tests and a real facade.

### Recipe Contract Requirements

The platform-neutral core should own only renderer-neutral recipe fields:

- stable renderer identity;
- explicit ordering only where the renderer contract supports it;
- media or viewport coordinate space;
- explicit pick behavior;
- static values or detection/style-context resolvers;
- backend capability validation.

Recipes must not expose PixiJS, DOM, worker, or Mediabunny types. The initial
public extension should contain supported built-in recipes, not an arbitrary
third-party Pixi hook.

### Compatibility Requirements

New recipes and facades must preserve these invariants:

1. Existing presentation fields and style subclasses continue to work.
2. New layers are additive; omitting them keeps current rendering behavior.
3. Decorations do not become independent editable annotations.
4. Picking is explicit and does not unexpectedly occlude existing geometry,
   handles, or labels.
5. Existing editing, interaction, guide, and label ordering remains stable.
6. Updating one layer does not rebuild the media session or invalidate
   unrelated masks, workers, media samples, viewport state, or editing state.
7. Visibility, loading, ephemeral, and creation state propagate consistently.
8. Temporal layers use canonical media time, including seek, loop, VFR, and
   non-zero media origins.
9. Media effects reuse renderer-owned media and do not create a second decoder
   or visible media element.
10. The browser package remains independent of React.

## Stateful And Media-Aware Recipes

### Trace

A trace must be reproducible from the detection timeline. It should require
stable identity, use a duration rather than an implicit frame count, rebuild
after seeking, and reset predictably at loop boundaries. It must not depend on
which frames the user happened to watch.

### Heat Map

Heat maps should expose explicit accumulation semantics:

- `trailing-window`: accumulate over the previous duration;
- `full-timeline`: precompute only when the implementation can establish a
  finite, complete source range.

An implicit “frames watched during this session” mode should not be the
default. The source capability that proves a complete range is intentionally
provisional and must be resolved by the temporal-foundation PR before this mode
becomes public.

### Media Effects

Blur, pixelate, halo, background overlay, and crop should sample the existing
renderer media and prepared semantic geometry. They must avoid full-canvas CPU
readback, bound effects to affected regions, and reuse shaders, textures, mask
artifacts, and geometry.

The crop facade is a view of the source media texture, not a bitmap copied after
annotations have been composited.

### Analytics

Zone facades visualize analytical state; the renderer should not decide whether
an object crossed a line or entered a polygon. The host or a platform-neutral
analytics utility supplies line, polygon, count, and per-class state.

Comparison should likewise be a pure transform over two semantic detection
sets. Normal recipes render the resulting regions and labels.

## Fixture And Data Plan

The Python gallery publishes rendered examples but not the exact detections
used to create them. Rendered PNGs are useful visual references, not canonical
detection data: antialiasing changes boundaries, effects destroy source pixels,
and temporal or covariance state cannot be recovered from final images.

Generate our own detections, preserve the raw model responses, normalize them
deterministically, and freeze them in the existing `demo/fixtures` structure.
Do not create a second fixture system.

### Existing Fixture Convention

```text
demo/fixtures/<fixture-name>/
  README.md
  fixture.meta.json
  raw-<model-or-stage>.jsonl
  detections.manifest.json
  detections/
    <one-second-chunks>.json
  <optional local media or shared-media reference>
```

The existing basketball and horse fixtures already demonstrate raw output
provenance, exact media times, compressed COCO RLE masks, derived polygons,
deterministic association policies, and timeline chunks. Future fixture
authoring should reuse those schemas and helpers.

### Current Visualization-Layer Delivery Ledger

This ledger is the source of truth for whether a public visualization page may
claim a live playground. A renderer primitive alone is not enough: the
playground must consume a committed fixture containing the matching semantic
field. Do not inject docs-only detections to simulate coverage.

| Visualization capability | Browser renderer and style        | Frozen fixture evidence                                                                               | Public docs state | Next required work                                                                     |
| ------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------- |
| Boxes                    | Implemented                       | `basketball_sam3.rect`                                                                                | Live playground   | Maintain regression coverage with the basketball fixture                               |
| Masks                    | Implemented                       | `basketball_sam3.mask` (compressed RLE)                                                               | Live playground   | Maintain mask-preparation and visual coverage                                          |
| Labels                   | Implemented                       | `basketball_sam3.className` and `confidence`                                                          | Live playground   | Maintain label layout and contrast coverage                                            |
| Polygons                 | Implemented                       | `basketball_sam3.polygon`                                                                             | Live playground   | Maintain contour and fill/stroke coverage                                              |
| Keypoints and skeletons  | Implemented                       | `basketball_sam3.keypoints` including edges and visibility                                            | Live playground   | Maintain pose association and visibility coverage                                      |
| Polylines                | Implemented (`BasePolylineStyle`) | `basketball_sam3` motion-gated basketball track plus mask (versioned bounded center trace)            | Live playground   | Maintain source-identity, path, timing, mask-color, and provenance regression coverage |
| Regions                  | Implemented (`region`)            | `basketball_regions` stabilized direct SAM3 head masks, original media, badges, and `player-fire.gif` | Live playground   | Add replacement coverage in its separately reviewed phase                              |

The basketball fixtures are therefore the current visual baseline for seven
renderers: boxes, masks, labels, polygons, polylines, keypoints/skeletons, and
regions backed by either assets or the current media frame.
The geometry fixture's polyline example is a transparent derived center trace
on one frozen segmentation identity. `basketball_regions` adds direct SAM3
`head` masks associated one-to-one with frozen team-player detections by their
top-center geometry. The authoring pass assigns stable player-backed identities,
admits lower-confidence candidates only for established tracks, repairs short
gaps, and temporally regularizes mask coverage and crop rectangles without any
runtime tracking or model dependency.
The Region renderer reuses the prepared exact mask as transparent media-crop
coverage and has no runtime keypoint dependency.

### Gaps Before New Facades

| Gap                                               | Status                                           | Earliest prerequisite                                                                            |
| ------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Open-path fixture for the existing polyline layer | Completed with `basketball_sam3`                 | Maintain frozen trace derivation, source identity, and visual regression evidence                |
| Oriented quadrilateral renderer                   | No first-class public annotation renderer        | Generic quadrilateral primitive plus a mask-derived or explicitly annotated fixture              |
| Markers and ellipses                              | No first-class public annotation renderer        | Generic marker/ellipse primitives plus a future pose fixture                                     |
| Prepared mask/media effects                       | Media crops covered by `region`; filters pending | Prepared filter primitive plus `people_walking_segmentation_v1`                                  |
| Temporal and analytic overlays                    | No public annotation renderer                    | Temporal/HUD primitives plus `vehicles_zone_v1` with frozen tracks, zone coordinates, and events |

No annotator facade may be added ahead of the matching row's primitive and
fixture evidence. Each facade remains one pull request after those prerequisites
land.

### Public Media References

The properties below were measured from the source files. MD5 values come from
Python Supervision 0.30.0's
[`assets/list.py`](https://github.com/roboflow/supervision/blob/0.30.0/src/supervision/assets/list.py).

| Source                                                                                           | Intended coverage                                                                         | Source properties                                             | Upstream MD5                       |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------- |
| [`people-walking.mp4`](https://media.roboflow.com/supervision/video-examples/people-walking.mp4) | Dense people, markers, labels, tracks, comparison, traces, heat maps, and privacy effects | 1920x1080 H.264, 25 fps, 13.64 s, 7,606,633 bytes             | `0574c053c8686c3f1dc0aa3743e45cb9` |
| [`people-walking.jpg`](https://media.roboflow.com/supervision/image-examples/people-walking.jpg) | Static geometry and screenshot reference                                                  | Published source still                                        | `e6bda00b47f2908eeae7df86ef995dcd` |
| [`vehicles-2.mp4`](https://media.roboflow.com/supervision/video-examples/vehicles-2.mp4)         | Traffic tracking, line crossings, polygon zones, and counts                               | 1920x1080 H.264, 30000/1001 fps, 42.5425 s, 29,782,444 bytes  | `830af6fba21ffbf14867a7fea595937b` |
| [`basketball-1.mp4`](https://media.roboflow.com/supervision/video-examples/basketball-1.mp4)     | Optional pose and articulation stress source                                              | 1920x1080 H.264, 60000/1001 fps, 8.042667 s, 27,178,650 bytes | `60d94a3c7c47d16f09d342b088012ecc` |
| [`skiing.mp4`](https://media.roboflow.com/supervision/video-examples/skiing.mp4)                 | Optional motion and occlusion stress source                                               | 1920x1080 H.264, 25 fps, 14.12 s, 8,896,267 bytes             | `d30987cbab1bbc5934199cdd1b293119` |

A public URL is not by itself a redistribution license. Record the rights and
provenance decision before committing new media. Store the upstream hash, an
exact FFmpeg derivation command, and the derived SHA-256 for every clipped or
normalized asset.

### Canonical Fixture Matrix

| Fixture                          | Media                                                              | Authoring model and deterministic processing                                                                                                                                                                                | Primary coverage                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Existing `basketball_sam3`       | Keep the committed normalized basketball media                     | Regenerated on `yolov8m-pose-640`; retain existing SAM3 masks, pose-to-mask association, compressed RLE, and the explicitly derived motion-gated bounded basketball trace. Derive explicitly marked covariance when needed. | Existing shapes, masks, polygons, polylines, keypoints, skeletons, oriented boxes, covariance, and media effects |
| `people_walking_segmentation_v1` | Deterministic representative 3 s interval                          | `yolov8s-seg-640`, `person` only, confidence >= 0.25; compressed RLE; polygons simplified to at most 48 points; versioned minimum-area rectangle derivation.                                                                | Oriented boxes, halo, blur, pixelate, background overlay, and crop                                               |
| `vehicles_zone_v1`               | Candidate 10.0-22.0 s interval, finalized after a tracking preview | `yolov8s-640`; car, truck, bus, and motorcycle; confidence >= 0.25; pinned ByteTrack at 30000/1001 fps; frozen line/polygon coordinates, open-path guides, and events.                                                      | Polylines, traces, line zones, polygon zones, counts, and multiclass HUD                                         |
| Optional `skiing_pose_stress_v1` | Full source or deterministic high-motion interval                  | `yolov8m-pose-640`; preserve missing and low-confidence joints                                                                                                                                                              | Seek, motion, and occlusion stress for pose and trace rendering                                                  |

The existing basketball fixture is the primary mask/keypoint reference.
`basketball-1.mp4` is a fallback or additional stress source, not a reason to
replace working fixture provenance.

### Local Inference Authoring

Use a local [Roboflow Inference](https://github.com/roboflow/inference) server
only to author fixtures. Self-hosted Inference does not require authentication
by default, so fixture authoring must bind it to loopback or use equivalent
network isolation. Follow the official
[self-hosting security guidance](https://inference.roboflow.com/install/security/)
and run a hardware-appropriate image by immutable digest, conceptually:

```bash
INFERENCE_IMAGE="roboflow/roboflow-inference-server-cpu@sha256:REPLACE_WITH_DIGEST"
docker run --rm \
  -p 127.0.0.1:9001:9001 \
  "$INFERENCE_IMAGE"
```

Do not publish the Inference port to an untrusted network, and do not enable the
development port when fixture generation does not need it. Submit frames to
`http://127.0.0.1:9001` through
the
[`InferenceHTTPClient`](https://inference.roboflow.com/inference_helpers/inference_sdk/)
using a documented
[`pre-trained model alias`](https://inference.roboflow.com/quickstart/aliases/).

A reproducible authoring run must:

1. pin the Inference server image digest, SDK, Python, Python Supervision,
   FFmpeg, and generator commit;
2. verify source media and any deterministic derived-media hash;
3. decode exact presentation timestamps and durations rather than deriving time
   as `frameIndex / fps`;
4. record the model alias, resolved model artifact or version, downloaded
   weight checksum, model-family license, confidence, IoU, resize, class-filter,
   and batching parameters;
5. fail provenance validation when the resolved model artifact cannot be
   identified and hashed;
6. preserve every raw response in JSONL before normalization;
7. normalize stable ids, classes, confidence, rectangles, keypoints, compressed
   RLE, and media times;
8. apply only named and versioned deterministic post-processing;
9. create and validate the existing one-second chunk manifest;
10. run Python and JavaScript references with network access disabled.

Conceptually:

```bash
<fixture-specific authoring command> \
  --server http://127.0.0.1:9001 \
  --source <licensed-source-media> \
  --model <documented-model-alias> \
  --model-license <model-license> \
  --model-weights-sha256 <verified-SHA-256> \
  --inference-image-digest sha256:<verified-digest> \
  --output <fixture-directory>/raw-<model>.jsonl
```

The concrete CLI may differ. Raw-output preservation, deterministic
normalization, and offline runtime behavior are the contract.

### Derived Geometry

Derived data must never be presented as direct model output.

- `mask-min-area-rect-v1` may derive an oriented quadrilateral from a mask
  contour.
- An initial `pose-covariance-v1` may derive uncertainty from keypoint
  confidence and person scale, align it with an adjacent skeleton edge, and
  clamp its radii.
- A later quality fixture may calculate empirical covariance through pinned
  test-time augmentation and inverse-transformed pose matching.

Every algorithm name, version, parameter, and output hash belongs in fixture
metadata.

### Reference Validation

For a frozen fixture:

1. a pinned Python Supervision reference generator produces expected outputs;
2. a JavaScript adapter feeds the same detections into `DetectionFrameSource`;
3. structural tests compare resolved geometry, labels, ordering, and temporal
   state;
4. browser tests capture JavaScript output;
5. tolerant image comparisons catch visual regressions without requiring two
   rasterizers to produce identical edge pixels.

## Platform Ownership

| Domain                                                                                 | Owner                   |
| -------------------------------------------------------------------------------------- | ----------------------- |
| Semantic geometry, recipe types, anchors, covariance math, and pure transforms         | `packages/core`         |
| Pixi batching, filters, textures, media crops, workers, and browser prepared artifacts | `packages/web`          |
| Skia mapping for an explicitly declared supported subset                               | `packages/react-native` |
| Persistence, undo/redo, product tools, and product analytics                           | Host application        |
| Fixtures, gallery, examples, and performance demonstrations                            | Docs and demo           |

Unsupported recipes must be reported through capabilities or validation. A
backend must not silently omit them.

## Performance Requirements

- Batch by primitive/runtime layer rather than facade or detection.
- Pool display objects and avoid per-frame create/destroy churn.
- Avoid rebuilding geometry when only color or alpha changes.
- Update text only when content or layout changes.
- Use texture atlases for icons.
- Bound filters and prepared effect textures to affected regions.
- Prepare expensive mask, halo, heat-map, and comparison work outside the
  critical frame loop.
- Add per-layer diagnostics through stable ids instead of one top-level metric
  per annotator.
- Benchmark dense detections, masks, labels, and temporal layers separately and
  in realistic compositions.

## Pull Request Contract

**Every new annotator facade is exactly one pull request.** Infrastructure PRs
may add a shared primitive or fixture capability without exposing an annotator,
but an annotator PR must not bundle a second annotator merely because both lower
to the same primitive.

Each annotator PR includes:

- one public facade and its lowering to existing recipes/primitives;
- fixture coverage using frozen data;
- pure resolution/lowering tests and browser renderer tests;
- a screenshot or visual-regression reference;
- public API docs and one focused playground/example control;
- package-boundary and clean-consumer verification;
- relevant performance evidence;
- proof that default presentation is unchanged when unused.

Any PR changing presentation semantics, masks, layer ordering, picking,
prepared-artifact caching, media time, workers, or package entrypoints must be
validated through the generated tarball in at least one external consumer. A
sibling source import or `npm pack --dry-run` is not sufficient evidence.

## Delivery Sequence

### Existing Foundation

`npm run package:tarball:smoke` already builds the portable package, installs it
in a temporary external consumer, imports the public entrypoints, and produces
a minimal Vite build. This clean-consumer baseline is complete; do not create a
duplicate compatibility-harness PR. Extend the smoke coverage only when a
roadmap change introduces a concrete consumer behavior that it does not already
exercise.

### Foundation PRs: No New Annotators

1. **Inference fixture authoring.** Reusable loopback-server generator,
   provenance schema, and fixture validation for the first future
   inference-authored fixture.
2. **Recipe composition contract.** Stable identity, phases, coordinate spaces,
   picking, backend capabilities, and diagnostics while compiling existing
   presentation unchanged.
3. **Generic vector primitives.** Path, ellipse, marker, text-anchor, and
   quadrilateral instructions justified by the first facades.
4. **Prepared media-effect primitives.** Bounded filters, mask reuse, worker
   ownership, invalidation, and fallback capability reporting.
5. **Temporal and HUD primitives.** Media-time windows, seek/loop behavior,
   cache bounds, viewport anchoring, and deterministic counters.

### Tier 1: Foundational Geometry Facades

1. `OrientedBoxAnnotator`
2. `BoxCornerAnnotator`
3. `CircleAnnotator`
4. `EllipseAnnotator`
5. `DotAnnotator`
6. `TriangleAnnotator`
7. `VertexLabelAnnotator`
8. `VertexEllipseAreaAnnotator`
9. `VertexEllipseOutlineAnnotator`
10. `VertexEllipseHaloAnnotator`

### Tier 2: Prepared Mask And Media-Effect Facades

11. `HaloAnnotator`
12. `BlurAnnotator`
13. `PixelateAnnotator`
14. `BackgroundOverlayAnnotator`

### Tier 3: Temporal Facades

15. `TraceAnnotator`
16. `HeatMapAnnotator`

### Tier 4: Compound And Analytics Facades

The crop and icon use cases are covered by media-backed and asset-backed
`region` renderers respectively. Remaining compound and analytics facades are:

17. `PercentageBarAnnotator`
18. `ComparisonAnnotator`
19. `LineZoneAnnotator`
20. `PolygonZoneAnnotator`
21. `LineZoneAnnotatorMulticlass`

The sequence may pause for platform or performance work, but compound facades
should not move ahead of the primitives and lifecycle rules they require.

## Review Checklist

Review every roadmap PR against these questions:

- Is the PR kind explicit? A foundation/infrastructure PR adds zero annotator
  facades; an annotator PR adds exactly one.
- Could the facade lower to existing primitives instead of adding a new
  renderer path? For a foundation PR, does the primitive have a documented
  near-term facade that justifies it?
- Does it preserve existing session, presentation, style, interaction, and
  editing contracts?
- Are picking and layer order explicit?
- Is cache invalidation scoped to the changed semantic inputs?
- Are temporal results deterministic across seek, loop, VFR, and non-zero
  media origins?
- Do media effects reuse the renderer-owned media and prepared artifacts?
- Is inference absent from runtime and test paths?
- Can the fixture be reproduced from pinned public inputs and raw outputs?
- Does the backend report unsupported behavior instead of silently dropping it?
- Do docs, package smoke, visual evidence, and relevant performance evidence
  match the actual change?

## Open Decisions

1. Which downloaded media have explicit redistribution terms suitable for the
   repository, rather than remaining linked references?
2. Should the first release expose only factory-built recipes or also a
   low-level custom recipe extension?
3. Does simultaneous segmentation-polygon and oriented-box data justify an
   `orientedBox` field, or should adapters continue lowering it to polygons?
4. Which recipes should the experimental React Native backend support first?
5. Which source capability should prove a finite, complete range for
   full-timeline heat maps?
6. Should pure zone counters live in core before a second non-renderer consumer
   needs them?
7. What browser matrix and image-diff tolerance define visual parity?
8. Which `vehicles-2` interval and zone coordinates produce the most stable
   zone fixture?
9. Is the skiing pose fixture necessary before basketball exposes a concrete
   coverage gap?
10. Which Inference image digest and aliases become the first frozen authoring
    toolchain?

## Decision

Proceed through composable use-case facades after the fixture, compatibility,
and composition foundations land. Reuse the existing fixture architecture,
generate detections through a pinned local Inference authoring workflow, and
freeze every runtime input.

Land annotators from foundational geometry to compound analytics, exactly one
new facade per PR. A facade may—and generally should—be a small composition of
primitives introduced earlier.

The central invariant is:

> A new visual facade may compile to existing primitives, but it must not change
> the meaning, lifecycle, identity, editability, or cache behavior of existing
> detections and presentation styles.
