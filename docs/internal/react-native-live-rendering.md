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

`examples/react-native` live mode currently has two explicit timing modes:

- **Strict sync** presents a camera frame only after inference and ID-mask
  preparation have completed for that same frame callback. This trades camera
  FPS for a stronger no-drift guarantee.
- **Latest masks** presents camera frames immediately and draws the latest
  prepared mask artifact. This is smoother, but the artifact can trail the
  displayed frame when inference is slower than the camera.

The current implementation uses VisionCamera's native `FrameRenderer` for the
camera frame and a Skia canvas for mask and label presentation. In strict-sync
mode, both are driven by the same frame callback: the worklet runs ExecuTorch,
builds one `Alpha_8` ID-mask image, updates Skia uniforms, then enqueues that
same frame for display. Strict sync keeps the inference buffer in the
metadata-oriented coordinate contract expected by ExecuTorch, then counter-
rotates the native frame renderer view for presentation. This keeps media and
annotations synchronized without changing the mask coordinate system. Latest mode
keeps a separate native preview output for smoother presentation. React receives
throttled diagnostics only.

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
- timing policy: strict packet presentation or low-latency latest-artifact mode;
- diagnostics output: throttled state snapshots for host UI.

Inference should remain outside the package. ExecuTorch is only one producer.
