# React Native Architecture

This note defines the current direction for the private experimental React
Native package. It is not a public API promise.

The package is being hardened toward release using the web API as the
blueprint; see the current phased extraction and API plan in
[`../superpowers/plans/2026-08-05-rn-thin-wrapper-hardening.md`](../superpowers/plans/2026-08-05-rn-thin-wrapper-hardening.md).

## Package Boundary

`packages/react-native` depends on `supervision-js-core`, not on
`packages/web`. The package should reuse semantic detections, timelines,
source-composition contracts, picking contracts, and style resolution from core.

It must not import Pixi, Mediabunny, DOM APIs, IndexedDB, browser workers, or the
browser package entrypoint.

## Rendering Direction

React Native rendering uses platform adapters around a renderer-neutral session
core. The `./react` entrypoint owns the static `MediaSessionView`, synchronized
frame packets, the live/video Skia stage, live resource presentation, and
generic interaction geometry. `./skia` remains an advanced lower-level entry
point, but the example must not import it: hosts pass semantic presentation
instructions and package-owned sessions to `ReactNativeLiveFrameStage` or
`ReactNativeVideoFrameStage` instead.

`useReactNativeLiveSkiaPresentation()` owns transparent sentinels, mask/vector
swap retirement, shader lifetime, and unmount disposal. It also prepares Skia
mask/vector packets with the native ID-mask builder when available and the JS
fallback otherwise. This keeps disposable GPU objects and native-builder
handles out of the product demo while retaining strict frame presentation.

The package should remain non-Expo-coupled. Expo may be a consumer environment,
but the library boundary should not require Expo APIs.

Mask rendering should follow the same performance principle as web: prepare one
frame-level ID-mask artifact from semantic detections, then let the native
renderer upload that artifact and apply style palettes in a shader. The shared
core concept is raw detection-indexed mask bytes plus palettes and metadata, not
PNG. PNG is a browser upload optimization; React Native may upload the raw bytes
directly through Skia or a future native GPU adapter.

## Media Direction

Mediabunny is browser-focused and stays in `packages/web`. React Native models
platform media through `MediaFrameSource`, `MediaFrameProcessor`, and
`MediaRendererAdapter`. The saved-video adapter wraps the optional Nitro
`VideoFrameSource`, implemented on iOS (AVFoundation/Swift) and on Android
(NDK MediaCodec/C++, experimental). The VisionCamera adapter owns the
camera/device/permission view, frame output, native frame renderer, and
orientation presentation. Native handles stay outside core.

## Storage Direction

IndexedDB is browser-only. React Native cold storage should eventually use
mobile storage primitives such as filesystem-backed chunks, SQLite, or MMKV-like
stores. Storage policies should mirror core retention policy concepts, but the
storage engine belongs to the React Native package or the host app.

## Inference Boundary

ExecuTorch and other on-device inference engines are detection producers, not
rendering dependencies. A host app may run a model with ExecuTorch and feed
detections into the same core-shaped pipeline, but `supervision-js-react-native`
does not import the ExecuTorch runtime to render detections.

The package's optional `./adapters/executorch` subpath accepts structural runner
and result shapes, owns worklet-safe serialization and coordinate repair, and
keeps model ownership with the host. The example app owns the actual ExecuTorch
models and hooks; neither core nor the React Native package takes a runtime
dependency on that producer.

## Current Proof

The current private package owns a generic `createMediaSession()` lifecycle,
source/processor/renderer contracts, stable state snapshots, prepared-frame
ownership, package defaults, and a React lifecycle adapter. Its static binding
and `MediaSessionView` map media-space geometry into a React Native Skia scene,
map touch coordinates back into media space, and delegate picking to core.

The React Native gesture adapter also delegates box creation, movement, handle
resizing, vertex deletion, and scaled-mask picking to the shared core editing
engine. The host retains selection, persistence, undo, and native drawing of
`AnnotationOverlayStyle` affordances; a native overlay-renderer is intentionally
not part of this proof.

Static and live examples use the same render-owned presentation shape: prepare
one frame packet, then draw media, masks, boxes, and labels through the same
synchronized frame stage. Static mode uses the package-owned React/Skia view;
live mode supplies VisionCamera's native frame renderer as the media source.
The annotation rendering lane stays shared rather than drifting into a second
renderer implementation.

The package also exposes a static-frame ID-mask proof:

- `supervision-js-core` prepares one raw ID-mask artifact per frame.
- `supervision-js-react-native` resolves that artifact into Skia-compatible
  shader uniforms and exports the SkSL shader source.
- The Expo example uploads the artifact as an `Alpha_8` Skia image and renders
  it in one shader pass before drawing boxes, labels, and selection.

`examples/react-native` is an Expo convenience app for quick phone/emulator
testing. It is allowed to depend on Expo and React Native Skia, but the reusable
`packages/react-native` package should remain non-Expo-coupled.

The example app also includes a live camera proof:

- The package-owned VisionCamera adapter owns frame output, frame disposal, the
  stable strict-sync callback, and native frame rendering.
- the optional `supervision-js-react-native/react/live-inference` entry owns
  `useReactNativeLiveInference()` and its Worklets dependency; it performs the
  one-frame packet handoff;
  it presents a camera frame only after the matching annotation packet is ready.
- ExecuTorch remains an injected structural model runner. The optional
  `adapters/executorch` factories serialize its segmentation/pose result into
  package-owned semantic frame data.
- React receives throttled diagnostics and semantic detections only.

The reusable package owns the live ID-mask artifact contract, artifact sizing
helper, Roboflow-style palette helper, worklet-callable JS fallback builder,
saved-video serializer, pose conversion helpers, and the strict-sync
live-inference controller. The example owns actual ExecuTorch model hooks and
serializable configuration, not a camera worklet.

The example also proves a live-inference interaction extension without
promoting its recipe UI into the primary session API. Touch-authored rules remain
serializable example state and are mirrored into the package-owned worklet. The
controller evaluates them beside the matching live inference result and returns
semantic runtime/pick events. Core/package capabilities remain coordinate
mapping, semantic geometry, picking, styles, prepared rendering, and the hot
lane; recipe UI, haptics, ExecuTorch model ownership, and persistence stay
example-owned until another consumer validates a reusable boundary.

Golden Pose consumes the pose producer. Safety Zone and Privacy consume
segmentation masks. Safety Zone accepts rectangular or free-shape polygon zones;
Privacy teaches class-wide GPU mosaic redaction through object taps. The live
mask lane uses a transparent one-pixel sentinel while no mask packet exists, so
an empty detection frame or model transition cannot feed a null image into the
Skia shader and paint the camera stage black.

The package also ships an experimental Nitro-based native builder
(`IdMaskBuilder`, Swift/iOS, `SupervisionIdMask` pod) that runs the same
Alpha_8 fill loop natively and returns raw artifact bytes plus palette buffers
in the exact JS artifact shape. `createReactNativeLiveIdMaskArtifactAuto()`
hides the platform split: it uses the boxed native hybrid object when the host
loaded one via `loadReactNativeLiveIdMaskNativeBuilder()` and falls back to the
JS builder otherwise, surfacing builder/fallback diagnostics. The package keeps
`react-native-nitro-modules` as an optional peer dependency; package tests run
without any native module. Android intentionally has no native implementation
yet and always uses the JS fallback.

The package also owns the iOS saved-video source, reusable ExecuTorch
serialization/preparation worklets, and shared file/live defaults.
`createReactNativeVideoFileSession()` exposes the common `MediaSession`
controls, state subscription, and capability surface while its strict-sync
native-pointer pump and Skia presentation lanes remain package-private.
`createReactNativeVideoSession()` is retained only as a deprecated forwarding
alias. File sessions support pause/play/stop and report seeking as unsupported.

Pacing is a session option, not a fixed property. `clock: "analysis"` remains
the default and infers on every decoded frame, so playback runs at inference
speed — correct for producing a fully annotated video. `clock: "media"`
presents frames on their own timeline, so a ten second clip takes ten seconds,
inferring on whatever subset the measured model cost affords and holding the
most recent detections across the frames in between. See
[`react-native-unified-session-plan.md`](react-native-unified-session-plan.md)
for the pacing policy and what remains.

Android saved-video decoding is implemented (experimental) as a Nitro C++
`VideoFrameSource` under `packages/react-native/android/`: `AMediaExtractor`

- `AMediaCodec` decode into a YUV_420_888 `AImageReader` (API 26+), and each
  frame is converted on the decode thread into a source-allocated RGBA
  `AHardwareBuffer` before entering the iOS-parity decode-ahead ring. The
  conversion exists because MediaCodec renders YUV into an ImageReader surface
  (an RGBA reader rejects the buffers), while ExecuTorch's Android
  `FrameExtractor` only reads RGBA-family hardware buffers; a GPU blit is the
  documented follow-up if device profiling shows the CPU convert dominating,
  and it would also unlock rotated videos, which the source currently rejects
  with an explicit error. Two hard-won constraints: the reader must keep
  `GPU_SAMPLED_IMAGE` usage even though frames are read on the CPU (the codec
  produces through gralloc and stalls against a CPU-only consumer), and the
  handle `pointer` crosses JS as `UInt64`, not `Int64` — arm64 heap pointers
  are top-byte-tagged, so a signed pointer goes negative and consumers reading
  the BigInt with `asUint64()` (ExecuTorch, Skia) reject it. The pipeline is
  validated end-to-end on an emulator (decode → ExecuTorch segmentation → Skia
  masks); the physical-device same-buffer gate and performance numbers are
  still pending. `patches/` carries two node_modules patches, applied
  automatically by the root `postinstall` (`patch-package --error-on-fail
--error-on-warn`), so a clean `npm install` is enough to build a working
  Android app. The VisionCamera surface-validity fix is required on every
  Android host: without it `HybridFrameRendererView.setRenderer` connects an
  `ImageWriter` to a not-yet-valid Surface during Fabric view creation and the
  app dies on first camera mount with "The surface has been released"
  (reproduced deterministically on a Pixel 10 Pro; upstream-worthy, no
  released VisionCamera contains the fix as of 5.2.2). The ExecuTorch
  scalar-sigmoid workaround is emulator-only — its body is gated on
  `ro.kernel.qemu`, so it is dead code on physical devices, confirmed by a
  full device segmentation run with the patch reverted.

The remaining package work is Android physical-device validation, the GPU
blit/rotation follow-up, and measurement for bounded prepared windows.
Inference engines remain injected producers rather than renderer
dependencies.

See [`react-native-live-rendering.md`](react-native-live-rendering.md) for the
live rendering target and current V0 demo shape.
