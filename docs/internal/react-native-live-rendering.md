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

`examples/react-native` live mode now uses this shape:

1. VisionCamera emits a frame to a worklet.
2. The worklet imports the camera frame as a Skia image.
3. ExecuTorch RF-DETR Nano instance segmentation runs against the same frame.
4. The worklet converts binary instance masks into one `Alpha_8` ID-mask image.
5. Shared Skia values are updated with the camera image, mask image, and shader
   uniforms.
6. One Skia canvas draws the current camera image and mask shader.
7. React receives throttled diagnostics only.

This is intentionally still a proof. It does not yet have a reusable
`createReactNativeLiveSession()` API, native-thread prepared windows, interaction
layers, or recorded-video providers.

## Next Architecture Step

Move the live lane from example code into `packages/react-native` behind a small
renderer contract:

- frame input: native frame handle plus metadata;
- artifact input: prepared ID-mask image/uniforms or raw binary masks;
- presentation output: one render scene with media and annotations;
- diagnostics output: throttled state snapshots for host UI.

Inference should remain outside the package. ExecuTorch is only one producer.
