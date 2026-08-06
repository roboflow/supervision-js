# React Native Live Rendering Plan

This is the target architecture for live camera/video rendering. It is not a
public API promise yet.

## Goal

React Native live rendering must follow the same core rule as the browser
renderer: media and detections are presented by one renderer-owned visual system.
For camera/live streams, that means the active camera frame and the prepared
annotation artifact are drawn in the same native/GPU render lane.

The demo should not prove “Skia overlay over camera preview.” It should prove
that a host can feed live frames and detections into one render scene.

## Required Pieces

- A native frame provider, currently VisionCamera frame output.
- A way to import the frame into the render backend without a CPU readback:
  `Frame.getNativeBuffer()` plus Skia `Image.MakeImageFromNativeBuffer()`.
- An inference producer, currently example-owned ExecuTorch RF-DETR Nano
  instance segmentation.
- A hot prepared artifact path that does not round-trip through React state:
  segmentation masks become one frame-level ID-mask image in the frame worklet.
- A Skia scene that draws:
  media frame image -> ID-mask shader artifact -> future interaction/debug layers.
- Throttled readouts only. React may display diagnostics, but it must not own
  per-frame presentation.

## Current V0 Demo

`examples/react-native` live mode currently has one timing mode:

- **Strict sync** presents a camera frame only after inference and ID-mask
  preparation have completed for that same frame callback. This trades camera
  throughput for a stronger no-drift guarantee. The demo intentionally does not
  have a "latest mask" mode because that mode can show an artifact from an older
  frame over a newer camera frame.

The package-owned VisionCamera adapter renders the camera frame and the
package-owned `ReactNativeLiveFrameStage` composes masks, vectors, boxes, and
labels. In strict-sync mode, the injected inference producer builds one bounded
`Alpha_8` ID-mask packet from model-resolution masks, hands it to
`useReactNativeLiveSkiaPresentation()`, then enqueues that same frame for
display. The presentation hook owns the shader, sentinel resources, one-frame
retirement, and disposal. Strict sync keeps the inference buffer in the
metadata-oriented coordinate contract expected by ExecuTorch, then
counter-rotates the native frame renderer view for presentation. This keeps
media and annotations synchronized without changing the mask coordinate system.
React receives throttled diagnostics only.

The debug HUD reports rolling p50/p90 timings instead of only the last frame:
segmentation, serialization, mask preparation, mask fill, Skia upload, total
strict-sync tick, dropped frames, artifact dimensions, artifact bytes, and mask
count. The rolling view is important because single-frame timings are noisy on
mobile and can hide whether the bottleneck is the model, JS/worklet mask fill,
Skia upload, or React diagnostics.

The example's **Instant CV** mode reuses this same strict-sync callback for
teach-by-touch rules. React owns infrequent authoring state, then mirrors a
bounded semantic rule packet into a shared value. The frame worklet evaluates
the packet against the matching segmentation or pose result, prepares the
normal mask/vector presentation, and reports only status transitions back to
React for rule cards and edge-triggered haptics. Touch feedback and static rule
geometry render in the synchronized stage without making React the frame clock.
Recipe changes also update a shared producer selector immediately, so the
stable camera worklet switches models on its next frame without waiting for a
React callback replacement.

The first example-owned recipes are Golden Pose, Safety Zone, and Privacy.
Golden Pose uses pose angles. Safety Zone uses RF-DETR segmentation, bounded
mask/zone overlap checks, rectangular or free-shape zones, and mask-aware
frame-local picking to build a removable list of prohibited classes. Privacy
uses the same picker to teach redacted classes, then reuses the live mask
shader's inexpensive mosaic mode inside each model-produced instance mask. A
narrow class-colored border from the same shader traces the mask silhouette in
Privacy without extracting vector polygons on every frame. Before any class is
selected, Privacy prepares zero-opacity masks for all detections so those
contours preview the tappable objects; after selection it returns to rendering
only the redacted classes. These recipes do not promise re-identification,
custom industrial classes, or saved/composited camera recording.

On iOS, the demo explicitly requests the RF-DETR Nano segmentation CoreML INT8
profile through ExecuTorch. ExecuTorch remains example-owned; it is a detection
producer, not a renderer dependency.

This is intentionally still a proof. The package now has a generic
`createMediaSession()` core, package-owned VisionCamera presentation, a shared
live/video stage, and a generic interaction layer. The remaining live boundary
is a generic session controller that owns host worklet plumbing while accepting
injected inference and product-rule producers. It also lacks native-thread
prepared windows, camera recording/export, Android saved-video decoding, and a
fully custom Skia/native renderer that imports and draws the camera frame
directly.

## Next Architecture Step

Move the live lane from example code into `packages/react-native` behind the
existing generic session contracts:

- `MediaFrameSource`: native frame handle plus metadata;
- `MediaFrameProcessor`: inference-produced detections and prepared semantic
  input;
- `MediaRendererAdapter`: one render scene with media and annotations;
- timing policy: strict packet presentation first; any future low-latency mode
  must be explicit about the weaker synchronization guarantee;
- diagnostics output: throttled state snapshots for host UI.

Inference should remain outside the package. ExecuTorch is only one producer.

## Native ID-Mask Preparation (Experimental)

The native/JSI escalation path now exists. `packages/react-native` owns:

- the renderer-neutral live ID-mask artifact shape, sizing helper, palette
  helper, and JS fallback builder (`createReactNativeLiveIdMaskArtifact()`),
  all worklet-callable — the example no longer duplicates the fill loop;
- an experimental Nitro hybrid object (`IdMaskBuilder`, iOS/Swift only) that
  runs the same Alpha_8 fill loop natively and returns raw artifact bytes plus
  palette buffers, byte-identical to the JS builder;
- `loadReactNativeLiveIdMaskNativeBuilder()`, which loads and boxes the hybrid
  object on the React thread so worklets can capture the handle; and
- `createReactNativeLiveIdMaskArtifactAuto()`, which tries the native builder
  first and falls back to the JS builder, reporting
  `{ builder: "native" | "js", fillMs, fallbackReason }` diagnostics.

The native builder intentionally returns raw bytes instead of a Skia image
handle: measured upload cost is ~0ms today, and raw bytes keep the package free
of Skia runtime objects. If profiling later shows byte transfer or Skia image
construction dominating, the next adapter should return a native image/texture
handle instead.

Masks are drawn exactly as the model produced them: both fill loops use
nearest sampling and never reshape the mask geometry. Edge quality is the
detection producer's job — the live demo requests RF-DETR masks at original
resolution (`returnMaskAtOriginalResolution: true`) now that native prep
created the headroom for it. (An earlier bilinear/tent-blur smoothing pass was
removed on purpose: reshaping model output in the renderer hid what the model
actually predicted.)

The shader still smooths _alpha only_: the artifact carries
`edgeFeatherTexels` (half the largest mask cell size in artifact texels,
clamped to [1, 12]) and edge alpha feathers over that radius with a smoothstep
ramp. High-resolution masks resolve to a 1-texel feather, which is plain
anti-aliasing.

The live demo also disables the mask stroke: a crisp border retraces the
low-res staircase and defeats the feathering (and skips the shader's expensive
border sampling loop). The native artifact additionally reports `fillMs` (pure
fill-loop time measured in Swift) so the HUD's Fill metric excludes JSI
argument/result conversion — the Prep-minus-Fill gap is bridging plus Skia
upload cost.

Two hard-won implementation constraints:

- The worklets Babel plugin turns `"worklet"` function declarations into
  non-hoisted assignments whose closures capture other module-level worklets
  by value at module-init time. Every worklet must be defined before any
  module-level worklet that captures it, or the captured value is `undefined`
  on the worklet runtime (tests do not catch this because vitest does not run
  the plugin).
- Debug app builds compile pods with `-Onone`, which makes the native fill
  loop 10-30x slower and can erase its advantage over the JS fallback. The
  `SupervisionIdMask` podspec forces `SWIFT_OPTIMIZATION_LEVEL=-O` for all
  configurations.

The demo also defers Skia mask-image disposal by one packet (the UI thread may
still be drawing the previous image when the worklet swaps in a new one —
rendering a disposed image paints the media rect black) and keeps the camera
frame callback identity render-stable (per-render state reaches the worklet
through shared values) so `useFrameOutput` does not re-serialize and swap the
callback on the live camera thread on every HUD readout.

Android has no native implementation; the auto builder falls back to JS there
with an explicit `fallbackReason`. The demo HUD shows which builder ran, the JS
fallback count, and the fallback reason next to the rolling p50/p90 metrics.

### Benchmark Status

Baseline before native prep (iPhone debug build, RF-DETR Nano CoreML INT8,
720x1280 artifact): segmentation ~46-58ms p50/p90, mask prep/fill ~18-33ms,
upload/serialization ~0ms. Target for native prep: fill under ~8-12ms p90 so
the strict-sync tick approaches model time. Post-native numbers are pending a
manual device run; record them here and decide whether the next bottleneck is
model inference, ArrayBuffer transfer, or Skia image construction.
