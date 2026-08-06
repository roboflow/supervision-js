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
`MediaRendererAdapter`. The current iOS saved-video adapter wraps the optional
Nitro `VideoFrameSource`. The VisionCamera adapter owns the camera/device/
permission view, frame output, native frame renderer, and orientation
presentation. Native handles stay outside core, and Android saved-video
decoding is not yet implemented.

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

- VisionCamera owns native camera frames and gives the example a frame output.
- The frame worklet imports the native camera frame as a Skia image through
  `Frame.getNativeBuffer()` and `Skia.Image.MakeImageFromNativeBuffer()`.
- The same frame is passed to ExecuTorch RF-DETR Nano instance segmentation.
- ExecuTorch binary masks are converted directly into one bounded frame-level
  ID-mask artifact in the worklet.
- The same callback assigns the mask shader packet and then presents the
  matching camera frame through VisionCamera's native frame renderer. React
  receives throttled diagnostics only.

The reusable package now owns the live ID-mask artifact contract, artifact
sizing helper, Roboflow-style palette helper, worklet-callable JS fallback
builder, saved-video serializer, and pose conversion helpers. The example still
owns the hot VisionCamera/live-inference worklet because those are producer
choices.

The example also proves an Instant CV interaction layer without promoting a
product-specific rule schema into the package. Touch-authored rules remain
example state, are compiled into bounded worklet-safe packets, and are evaluated
beside the matching live inference result. Core/package capabilities remain the
coordinate mapping, semantic geometry, picking, styles, and prepared rendering
lanes; recipe UI, haptics, ExecuTorch outputs, and rule semantics stay
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
serialization/preparation worklets, shared file/live defaults, and the existing
analysis-paced `createReactNativeVideoSession()` compatibility factory. The
factory supports pause/resume/stop and intentionally reports seeking as
unsupported. New code should use `REACT_NATIVE_FILE_SESSION_DEFAULTS`; the old
video-defaults name is retained only as a deprecated alias.

The remaining package work is to migrate that saved-video compatibility path
onto the generic session core, move the live example lane behind reusable
adapters, add Android saved-video decoding, and introduce bounded prepared
windows where measurement justifies them. Inference engines remain injected
producers rather than renderer dependencies.

See [`react-native-live-rendering.md`](react-native-live-rendering.md) for the
live rendering target and current V0 demo shape.
