# Android Saved-Video Frame Source Plan

This plan implements the Android `VideoFrameSource` gap called out in
[`../../internal/react-native-architecture.md`](../../internal/react-native-architecture.md)
and Checkpoint 10 of
[`2026-08-05-rn-thin-wrapper-hardening.md`](2026-08-05-rn-thin-wrapper-hardening.md):
a Nitro C++ source using `AMediaExtractor` + `AMediaCodec` with an API-26+
`AImageReader`/`AHardwareBuffer` output that preserves presentation timestamps
and display orientation, exposes exactly-once buffer release, registers
CMake/Gradle autolinking, and is validated with the same buffer in ExecuTorch
and Skia on a physical device.

## Contract To Preserve

The JS side must not change shape. The pump worklet in
`packages/react-native/src/sessions.ts` consumes:

- `copyNextFrame()` blocking until the decode-ahead ring has a frame, or
  `undefined` at end of stream;
- a handle with `pointer: Int64`, `timestampMs`, `width`, `height`,
  `release()` (idempotent);
- `Skia.Image.MakeImageFromNativeBuffer(handle.pointer)` — on Android Skia
  resolves this pointer as an `AHardwareBuffer*`;
- the ExecuTorch adapter (`src/adapters/executorch.ts`) wraps the same handle
  in a VisionCamera-`Frame`-shaped object whose
  `getNativeBuffer().pointer` is the same address — on Android, VisionCamera
  frames expose `AHardwareBuffer*` there, so the runner already expects that
  payload.

Therefore the Android handle payload is a retained `AHardwareBuffer*`
(`AHardwareBuffer_acquire` on hand-out, `AHardwareBuffer_release` +
`AImage_delete` on release), mirroring the iOS retained `CVPixelBuffer`.

## Phase 0 — Prerequisite Validation (no native code)

Checkpoint 10 requires validating Android through the existing JS lanes before
adding native optimization.

- [ ] Build and run `examples/react-native` on a physical Android device
      (static example + live camera with the JS ID-mask fallback).
- [ ] Confirm the current failure mode: file sessions report
      `android-video-file-source-not-implemented-yet` from
      `src/video-frame-source.ts` and the capability state disables the mode
      cleanly rather than crashing.
- [ ] Record JS-fallback mask fill p50/p90 on the device in
      [`../../internal/react-native-live-rendering.md`](../../internal/react-native-live-rendering.md)
      (this also feeds the separate "native Android mask builder only if
      measured" decision).

## Phase 1 — Spike: Same-Buffer Proof (throwaway allowed)

De-risk the two integration unknowns before building the real module:

- [ ] Minimal NDK decode of a bundled fixture video:
      `AMediaExtractor` → `AMediaCodec` configured with an `AImageReader`
      surface (`AIMAGE_FORMAT_RGBA_8888` if the codec accepts the RGBA
      surface path, otherwise `AIMAGE_FORMAT_PRIVATE` with
      `AHARDWAREBUFFER_USAGE_GPU_SAMPLED_IMAGE`), then
      `AImage_getHardwareBuffer()`.
- [ ] Feed that exact `AHardwareBuffer*` to
      `Skia.Image.MakeImageFromNativeBuffer()` and draw it.
- [ ] Feed the same pointer through the ExecuTorch runner
      (VisionCamera-frame-shaped wrapper) and confirm detections come back.
- [ ] Record which output format worked per test device (RGBA surface vs
      implementation-defined YUV). If Skia or ExecuTorch rejects the YUV
      external format on any target device, the design needs a GPU blit pass
      (GLES/`ANativeWindow`) into an RGBA `AHardwareBuffer` — decide here, not
      after the module is built.
- [ ] Verify rotation behavior: decode a portrait phone recording
      (`KEY_ROTATION` = 90/270) and observe whether frames leave the
      `AImageReader` upright or unrotated on the spike devices.

**Exit decision:** output format (RGBA surface / YUV external / blit pass) and
orientation strategy are fixed and written into this plan before Phase 2.

## Phase 2 — Nitro Scaffolding

- [ ] Extend `src/specs/VideoFrameSource.nitro.ts` platforms to
      `{ ios: "swift", android: "c++" }` for both `VideoFrameSource` and
      `VideoFrameHandle`; keep the doc comments honest about the per-platform
      pointer payload (`CVPixelBufferRef` vs `AHardwareBuffer*`).
- [ ] Run nitrogen; commit `nitrogen/generated/android` and updated shared
      output (the repo commits generated code).
- [ ] Add `packages/react-native/android/`: - `build.gradle` — library module, `minSdkVersion 26` for this native
      module (or RN's minSdk plus a hard runtime API-level gate; document
      the choice), CMake wiring, prefab/Nitro conventions copied from an
      existing Nitro module. - `CMakeLists.txt` — sources plus `mediandk`, `android`, `nativewindow`,
      `log` link libraries; register against `SupervisionIdMask`
      (`androidCxxLibName` already declared in `nitro.json`). - Kotlin `OnLoad`/package glue only as required by Nitro autolinking.
- [ ] Update `nitro.json` autolinking with the Android `c++` entries for
      `VideoFrameSource` (and the handle) using the generated hybrid class
      names.
- [ ] Wire the example app: confirm Expo/Gradle autolinking picks the module
      up in `examples/react-native` android build.

## Phase 3 — C++ Implementation

Mirror `ios/HybridVideoFrameSource.swift` structure and semantics:

- `android/cpp/HybridVideoFrameSource.{hpp,cpp}`
  - `open(filePath)`: accept plain paths and `file://` URIs (strip scheme);
    open via `AMediaExtractor_setDataSource` (use fd variant for robustness);
    select the first video track; read width/height/duration/frame-rate and
    `KEY_ROTATION` from `AMediaFormat`; report **display-orientation**
    dimensions (swap width/height for 90/270 exactly as decided in Phase 1).
  - Create `AImageReader` with `maxImages = ringCapacity + in-flight +
one-packet retirement + headroom` (start at 6; the decoder stalls rather
    than corrupts if the consumer leaks, which is a useful leak detector);
    configure `AMediaCodec` with the reader's `ANativeWindow`.
  - Decode thread (std::thread + std::mutex/std::condition_variable, the
    NSCondition analog): extractor → input buffers → codec;
    `AImageReader_acquireNextImage` on the image-listener callback or drain
    loop; push `(AImage*, ptsMs)` into a ring bounded at 3, blocking while
    full, exactly like the Swift `decodeLoop()`.
  - Preserve PTS from `AMediaCodec` output buffer info
    (`presentationTimeUs / 1000.0`); do not re-derive from frame index.
  - `copyNextFrame()`: block while ring empty and not finished/closed;
    pop; wrap in a handle; broadcast so the decoder refills. Return
    `nullptr`-equivalent at EOS (`AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM`).
  - `close()`: idempotent; set closed, drain/delete ring images, stop codec,
    delete codec/extractor/reader, join thread. Destructor calls close.
- `android/cpp/HybridVideoFrameHandle.{hpp,cpp}`
  - Owns the `AImage*` plus an acquired `AHardwareBuffer*`;
    `pointer` returns `reinterpret_cast<int64_t>(buffer)`;
    `release()` is guarded by an atomic flag (safe to call more than once):
    `AHardwareBuffer_release` then `AImage_delete` returns the slot to the
    reader.
- Error mapping: every failure path throws a Nitro error with a
  `VideoFrameSource:`-prefixed message matching the iOS wording style
  (missing file, no video track, codec configure/start failure).

If Phase 1 chose a blit pass for format/rotation, add
`android/cpp/FrameBlitter.{hpp,cpp}` as an isolated GLES helper producing
upright RGBA `AHardwareBuffer`s; keep it out of the handle contract.

## Phase 4 — JS Capability Flip

- [ ] `getReactNativeVideoFilePlatformAvailability()` in
      `src/video-frame-source.ts`: Android becomes available when
      `Platform.Version >= 26`; below that, keep a stable reason such as
      `android-video-file-source-requires-api-26`. Keep the not-implemented
      reason only if the module genuinely failed to load (existing catch path
      already reports load errors).
- [ ] Update capability docs in the same change (the checkpoint requires the
      capability state and docs to match):
      `docs/internal/react-native-architecture.md`,
      `docs/internal/react-native-live-rendering.md`,
      `docs/public/guides/public-api.md` platform notes.
- [ ] Vitest: extend the availability tests for the new platform/API-level
      matrix; package tests must still pass with no native module present.

## Phase 5 — Validation Gates (repo definition of done)

TypeScript + Vitest alone never qualify RN work as done here.

- [ ] `npm run verify` and `npm run boundary:check` (optional peers stay
      optional; no new required dependency).
- [ ] Example app `assembleDebug` builds; add the Android build job to CI
      (`.github/workflows/ci.yml`) per Checkpoint 10.
- [ ] Physical-device gate (the mandated one): open a saved video on Android,
      run the file session end-to-end — ExecuTorch detections and Skia
      presentation from the **same** `AHardwareBuffer`, PTS monotonically
      increasing and matching the fixture, upright orientation for a portrait
      recording.
- [ ] Lifecycle gate: full-video run to EOS, mid-video stop, repeated
      open/close, and a leak check (an unreleased handle must surface as a
      visible stall/diagnostic, never a crash); double-`release()` is a
      no-op.
- [ ] Record decode/serialize/prepare p50/p90 for the Android device in the
      benchmark section of
      [`../../internal/react-native-live-rendering.md`](../../internal/react-native-live-rendering.md).
- [ ] Compare frame count/PTS sequence against iOS decoding the same fixture.

## Phase 6 — PR Shape

One checkpoint-sized PR (or two: scaffolding+implementation, then CI+docs),
using the repository PR template. Update the stale Checkpoint 10 checkboxes it
satisfies, and note device evidence (device model, OS version, measured
timings) under `Notes For Reviewers`.

## Known Risks

- **Orientation.** `AImageReader` output does not apply `KEY_ROTATION`; iOS
  bakes the transform via `AVMutableVideoComposition`. The honest v1 options
  are a GPU blit rotation (true parity) or reporting rotated dimensions plus
  a documented presentation counter-rotation (what the live camera lane
  already does). Decide in Phase 1; do not silently ship sideways frames.
- **Format negotiation variance.** Codec → `AImageReader` RGBA output is the
  clean path but is device/vendor dependent; implementation-defined YUV via
  `AIMAGE_FORMAT_PRIVATE` is broadly supported but pushes format handling to
  Skia's external-image support and the ExecuTorch preprocessor. The Phase 1
  spike exists to pick per-format reality over documentation.
- **Buffer pool starvation.** The Swift comment about staying "well below the
  decoder's fixed pixel-buffer pool size" translates directly: `maxImages`
  must cover ring + in-flight + one-packet Skia retirement, and a leaked
  handle stalls `acquireNextImage`. Surface a diagnostic when acquisition
  stalls beyond a threshold instead of hanging silently.
- **Threading.** `copyNextFrame()` blocks a worklet-runtime thread, same as
  iOS; all codec/extractor teardown must happen on or be synchronized with
  the decode thread to avoid NDK use-after-free during `close()` races.

## Status — 2026-08-18 (emulator bring-up complete)

Phases 2–4 are implemented and the pipeline runs end-to-end on an Android 16
arm64 emulator: NDK decode → RGBA conversion → ExecuTorch RF-DETR
segmentation → Skia mask presentation, with `assembleDebug` green and
`libSupervisionIdMask.so` packaged for all four ABIs. The Phase 1 spike was
effectively executed inside Phase 3 via emulator iteration; its exit
decisions and other empirical findings:

- **Output format (decided):** MediaCodec renders `YUV_420_888` into an
  ImageReader surface — an RGBA reader rejects the buffers
  ("Output buffer format: 0x23, configured 0x1"). ExecuTorch's Android
  `FrameExtractor` accepts only RGBA-family hardware buffers, so the source
  converts each frame on the decode thread (BT.601, generic pixel-stride
  indexing) into a source-allocated RGBA `AHardwareBuffer`
  (`CPU_READ | CPU_WRITE | GPU_SAMPLED`). The converted buffer is accepted by
  both consumers; the `AImage` returns to the reader immediately, simplifying
  lifecycle. A GPU blit remains the perf follow-up and would also unlock
  rotation.
- **Orientation (decided):** rotated videos are rejected with an explicit
  error in v1; the GPU blit follow-up is the path to parity.
- **Reader usage:** `GPU_SAMPLED_IMAGE` must stay in the reader usage even
  for CPU consumption — the codec produces through gralloc and stalls
  against a CPU-only consumer.
- **Pointer signedness:** the handle `pointer` spec type must be `UInt64`.
  arm64 heap pointers are top-byte-tagged; as `Int64` the BigInt goes
  negative and ExecuTorch/Skia `asUint64()` reads throw (masked as
  "Unknown error in vision function" by cross-library RTTI).
- **JNI registration:** a Nitro C++ Android library needs the
  `cpp-adapter.cpp` `JNI_OnLoad` calling the generated `registerAllNatives()`
  — `System.loadLibrary` alone leaves the registry empty.
- **node_modules patches (in `patches/`, not yet wired to postinstall):**
  `react-native-vision-camera+5.2.2.patch` fixes the frame-renderer view
  connecting an `ImageWriter` to a not-yet-valid surface at Fabric view
  creation (`surface != null` → `surface.isValid`; upstream-worthy,
  affects real devices). `react-native-executorch+0.9.3.patch` is an
  emulator-only scalar sigmoid replacing a `cv::exp` SIMD kernel that
  raises SIGILL on Apple-Silicon-hosted emulators.
- **Emulator limits (expected, documented):** camera HAL buffers fail
  `AHardwareBuffer_lock` with -38, so live-camera inference stays
  device-only; decoder-allocated buffers lock fine.

Remaining before the checkpoint closes: Phase 5 physical-device gates
(same-buffer validation, PTS/orientation checks, lifecycle/leak runs,
p50/p90 benchmarks recorded in `react-native-live-rendering.md`), the
Android CI job, deciding patch-package wiring, and the upstream VisionCamera
PR. Phase 6 (PR) intentionally not started.
