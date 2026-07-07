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

The current implementation uses VisionCamera's native `FrameRenderer` for the
camera frame and a Skia canvas for mask and label presentation. In strict-sync
mode, both are driven by the same frame callback: the worklet runs ExecuTorch,
builds one bounded `Alpha_8` ID-mask image from model-resolution masks, updates
Skia uniforms, then enqueues that same frame for display. Strict sync keeps the
inference buffer in the metadata-oriented coordinate contract expected by
ExecuTorch, then counter-rotates the native frame renderer view for
presentation. This keeps media and annotations synchronized without changing the
mask coordinate system. React receives throttled diagnostics only.

The debug HUD reports rolling p50/p90 timings instead of only the last frame:
segmentation, serialization, mask preparation, mask fill, Skia upload, total
strict-sync tick, dropped frames, artifact dimensions, artifact bytes, and mask
count. The rolling view is important because single-frame timings are noisy on
mobile and can hide whether the bottleneck is the model, JS/worklet mask fill,
Skia upload, or React diagnostics.

On iOS, the demo explicitly requests the RF-DETR Nano segmentation CoreML INT8
profile through ExecuTorch. ExecuTorch remains example-owned; it is a detection
producer, not a renderer dependency.

This is intentionally still a proof. It does not yet have a reusable
`createReactNativeLiveSession()` API, native-thread prepared windows, interaction
layers, recorded-video providers, or a fully custom Skia/native renderer that
imports and draws the camera frame directly.

## Next Architecture Step

Move the live lane from example code into `packages/react-native` behind a small
renderer contract:

- frame input: native frame handle plus metadata;
- artifact input: prepared ID-mask image/uniforms or raw binary masks;
- presentation output: one render scene with media and annotations;
- timing policy: strict packet presentation first; any future low-latency mode
  must be explicit about the weaker synchronization guarantee;
- diagnostics output: throttled state snapshots for host UI.

Inference should remain outside the package. ExecuTorch is only one producer.
If strict mode still spends too much time in ID-mask preparation after bounded
artifacts and model-resolution masks, the next escalation path is a native/JSI
ID-mask builder that keeps the same one-artifact-per-frame contract while moving
the fill/upload work closer to the renderer. `packages/react-native` now exposes
the renderer-neutral live ID-mask artifact shape, sizing helper, palette helper,
and JS fallback builder so a native implementation can replace the fill path
without changing the higher-level packet contract.
