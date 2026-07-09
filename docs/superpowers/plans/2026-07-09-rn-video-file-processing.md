# RN Saved-Video Processing Implementation Plan

> **For agentic workers:** implement checkpoint-by-checkpoint. Stop after each
> checkpoint for manual iPhone testing.

**Goal:** Process saved video files through the exact same strict-sync
rendering structure as the live camera: decode frames one at a time, run
RF-DETR instance segmentation, build the ID-mask packet, and present frame +
annotations together — starting immediately and running as fast as inference
allows.

**Why now:** The original blocker was the lack of a Mediabunny equivalent for
React Native: nothing demuxed/decoded video frame-by-frame into the pipeline.
That gap closes with a small native AVFoundation frame source. Everything
downstream already exists: the worklet pipeline, the native ID-mask builder,
the effects shader, and the packet-swap presentation are all source-agnostic
once frames arrive.

**Architecture:** `packages/react-native` gains an experimental native
`VideoFrameSource` (Nitro hybrid in the existing `SupervisionIdMask` pod —
the same role Mediabunny adapters play in `packages/web`). The example app
gains a "Video" mode that pumps decoded frames through the same worklet body
as live mode on a dedicated worklet thread. Inference stays example-owned
(ExecuTorch is a producer, not a renderer dependency).

**Tech stack:** AVFoundation (`AVAssetReader` + VideoToolbox hardware decode),
Nitro Modules, react-native-worklets custom runtimes
(`NativeThreadFactory` + `WorkletQueueFactory` from
react-native-vision-camera-worklets), RN Skia
(`MakeImageFromNativeBuffer`), ExecuTorch RF-DETR.

---

## Verified Facts (from source, 2026-07-09)

These three findings shape the whole design — re-verify only if dependency
versions change:

1. **ExecuTorch inference is structurally typed, not VisionCamera-typed.**
   `react-native-executorch/src/types/common.ts` defines
   `Frame { getNativeBuffer(): { pointer: bigint; release(): void };
orientation: string; isMirrored: boolean }` and the native side
   (`FrameExtractor.cpp`) consumes the pointer as a `CVPixelBufferRef`,
   accepting `kCVPixelFormatType_32BGRA`. Any object exposing a BGRA
   CVPixelBuffer pointer can be segmented — no VisionCamera involvement.

2. **VisionCamera's frame renderer accepts protocol-compatible frames.**
   `HybridFrameRenderer.renderFrame` casts its argument to the public
   `NativeFrame` protocol (`ios/Public/NativeFrame.swift`) and enqueues
   `.sampleBuffer` into an `AVSampleBufferDisplayLayer`. A custom hybrid
   conforming to the generated `HybridFrameSpec` + `NativeFrame` would work.
   We deliberately do NOT take this path in v1 (cross-pod Nitro spec
   dependencies add risk); it remains a documented fallback.

3. **RN Skia can wrap the decoded buffer zero-copy.**
   `Skia.Image.MakeImageFromNativeBuffer(pointer)` exists in the installed
   RN Skia, and the demo's `SyncedFrameStage` already supports a `mediaImage`
   prop (the static mode uses it). Presenting video frames inside the Skia
   canvas puts media and annotations in one renderer-owned scene — which the
   architecture docs prefer anyway, and which unlocks camera-content effects
   (real pixelation) on video for free later.

## Design

### Native frame source (packages/react-native)

New Nitro hybrid `VideoFrameSource` in the existing `SupervisionIdMask` pod
(one more entry in `nitro.json` autolinking; no new pod):

```ts
// src/specs/VideoFrameSource.nitro.ts
interface VideoFrameSource extends HybridObject<{ ios: "swift" }> {
  open(filePath: string): void;
  readonly durationMs: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly nominalFrameRate: number;
  /**
   * Returns the next decoded frame or undefined at end-of-stream.
   * Blocks briefly when the decode-ahead ring is empty.
   */
  copyNextFrame(): VideoFrameHandle | undefined;
  close(): void;
}

interface VideoFrameHandle extends HybridObject<{ ios: "swift" }> {
  /** Retained CVPixelBufferRef pointer (BGRA). */
  readonly pointer: bigint;
  readonly timestampMs: number;
  readonly width: number;
  readonly height: number;
  /** Releases the retained pixel buffer. Must be called exactly once. */
  release(): void;
}
```

Swift implementation notes:

- `AVAssetReader` + `AVAssetReaderVideoCompositionOutput` with output settings
  `kCVPixelFormatType_32BGRA`. The video-composition output bakes
  `preferredTransform` so frames arrive upright — orientation is always
  `"up"`, `isMirrored` false, and no rotation plumbing is needed anywhere
  downstream. If profiling shows the composition costs too much, switch to
  `AVAssetReaderTrackOutput` + orientation metadata (the live pipeline
  already knows how to counter-rotate).
- Decode-ahead ring: a background `DispatchQueue` keeps 2–3 frames decoded
  ahead; `copyNextFrame()` pops (blocking briefly if empty, which is fine on
  the dedicated video thread). This overlaps decode with inference so the
  model never waits — decode (~2–5ms hardware) hides entirely under
  inference (~50–60ms).
- Each handle retains its `CVPixelBuffer` (`Unmanaged.passRetained`);
  `release()` balances it. Handles crossing to the worklet runtime is the
  same boxed/unbox pattern proven with `IdMaskBuilder` — the source is
  loaded and boxed on the React thread, captured by the pump worklet.

JS wrapper mirrors the ID-mask builder pattern:
`loadReactNativeVideoFrameSource()` (React thread, boxed handle, fallback
reason on Android/missing pod) and a worklet helper that adapts a
`VideoFrameHandle` into the ExecuTorch structural frame:

```ts
function toExecutorchFrame(handle) {
  "worklet";
  return {
    getNativeBuffer: () => ({ pointer: handle.pointer, release: () => {} }),
    isMirrored: false,
    orientation: "up",
  };
}
```

(`release` is a no-op there because the packet lifecycle owns the buffer —
see presentation.)

### Pump loop (example app)

A dedicated worklet runtime, created exactly the way
react-native-vision-camera-worklets documents:

```ts
const thread = NativeThreadFactory.createNativeThread("video-pump");
const queue = WorkletQueueFactory.wrapThreadInQueue(thread);
const runtime = createWorkletRuntime({ name: "video", customQueue: queue });
```

`scheduleOnRuntime(runtime, pumpWorklet)` runs a while-loop:

```
while (videoPlayingShared.value):
  handle = source.copyNextFrame()        // blocks ≤ a few ms (ring prefetch)
  if handle == undefined: break          // EOS
  processVideoFrame(handle)              // same body as live tick
```

Pull-based looping gives natural backpressure: the loop only asks for the
next frame after the previous tick (inference + mask prep + packet swap)
finishes. That IS the strict-sync guarantee, same as live.

### Shared tick (`processFrame`)

Extract the live worklet body into a shared, source-agnostic worklet
(`examples/react-native/src/live-tick.ts` or inline in App):
serialize detections → class-effects filter → `createLiveSkiaMaskFrame` →
packet swap → present. The only source-specific seams:

- **acquire**: camera `onFrame(frame)` vs pump `copyNextFrame()`.
- **inference input**: VisionCamera `Frame` vs `toExecutorchFrame(handle)`.
- **present**: live keeps `frameRenderer.renderFrame(frame)`;
  video assigns `Skia.Image.MakeImageFromNativeBuffer(handle.pointer)` into a
  `videoFrameImage` shared value rendered by `SyncedFrameStage`'s existing
  `mediaImage` slot. The frame image, mask image, and uniforms swap in the
  same closure — one packet, strictly synced by construction.
- **retire**: the deferred-disposal pattern already built for mask images,
  extended to `{ skiaImage, handle }` pairs: dispose the Skia image AND call
  `handle.release()` one packet late, so the UI thread can never sample a
  freed CVPixelBuffer.

Everything else — native ID-mask prep, mosaic/spotlight/mute effects, tap
menu, HUD metrics — works on video with zero changes because it only sees
serialized detections and packets.

### Pacing

- **v1 — "process every frame, as fast as possible":** video time advances at
  inference speed (~12–15fps of video per wall-second). Right default for an
  analysis demo, zero extra machinery.
- **v2 — realtime playback:** skip decoded frames until the wall clock
  catches up (decode is cheap; only inference is rationed). A HUD toggle.

## Current State

- Live pipeline: `onLiveInferenceFrame` worklet in `examples/react-native/App.tsx`
  (serialization → effects → `createLiveSkiaMaskFrame` → packet swap →
  `renderFrame`), stable-identity callback, shared-value state, deferred
  image disposal.
- `packages/react-native` owns the `SupervisionIdMask` Nitro pod (nitrogen
  configured, `-O` forced), the ID-mask artifact/builders, the effects
  shader, and the boxed-native-builder worklet pattern.
- `SyncedFrameStage` renders mediaLayer OR `mediaImage` + mask shader +
  boxes/labels in one canvas, with `onPress` picking.
- Worklet constraints documented: define module-level worklets before their
  captors; new shader uniforms require cold restart during dev.

## Non-Goals

- Android decode (MediaCodec adapter later; the source loader reports a
  fallback reason like the ID-mask builder does).
- Audio, seeking/scrubbing UI, variable playback rate (v2+).
- Recording/exporting the annotated video (needs the capture story).
- A stable public API — this stays experimental, like the rest of the RN
  package.
- Constructing real VisionCamera `Frame` hybrids (fallback path only).

## Checkpoints

### Checkpoint 1: Native VideoFrameSource

**Files:**

- Add: `packages/react-native/src/specs/VideoFrameSource.nitro.ts`
- Add: `packages/react-native/ios/HybridVideoFrameSource.swift`
- Add: `packages/react-native/ios/HybridVideoFrameHandle.swift`
- Modify: `packages/react-native/nitro.json` (two new autolinking entries)
- Regenerate nitrogen; pod install.

- [ ] AVAssetReader + video-composition output, BGRA, decode-ahead ring (3).
- [ ] Retained-pointer handles with explicit `release()`; `close()` drains
      the ring and cancels reading.
- [ ] Clear native errors: missing file, no video track, reader failure.
- [ ] `npm run typecheck -w supervision-js-react-native && npm run build -w supervision-js-react-native`
- [ ] Rebuild dev client (`npm run example:react-native:ios -- --device`).

**Manual acceptance:** a debug button opens a bundled sample video and logs
frame count / decode fps to the console (no rendering yet). Expect decode
well above 100fps for 720p.

### Checkpoint 2: JS wrapper + package tests

**Files:**

- Add: `packages/react-native/src/video-frame-source.ts`
- Modify: `packages/react-native/src/index.ts`, `index.test.ts`,
  `tools/package-smoke.test.mjs` (export list)

- [ ] `loadReactNativeVideoFrameSource()` — boxed handle + fallbackReason
      (same shape as the ID-mask builder loader; lazy require, Node-safe).
- [ ] Worklet helpers: `toExecutorchVideoFrame(handle)` adapter and typed
      pump helpers. Mind worklet definition order.
- [ ] Tests with a fake boxed source (same fixture pattern as the builder).

### Checkpoint 3: Decode → present (no inference)

**Files:**

- Modify: `examples/react-native/App.tsx` (Video mode scaffold)
- Add: bundled sample video under `examples/react-native/assets/`

- [ ] "Video" entry in the mode switch; `VideoFileProof` reusing
      `SyncedFrameStage` with `mediaImage`.
- [ ] Dedicated worklet runtime (NativeThreadFactory + WorkletQueueFactory +
      `createWorkletRuntime`); pump loop with `videoPlayingShared` stop flag.
- [ ] Packet = frame image only; deferred `{image, handle}` retirement.
- [ ] HUD: decode ms p50/p90, presented fps, progress (timestamp/duration).

**Manual acceptance:** the sample video plays smoothly at decode speed with
no leaks (Xcode memory graph steady over a full loop), start/stop works.

### Checkpoint 4: Full pipeline parity

**Files:**

- Modify: `examples/react-native/App.tsx` (extract shared tick worklet)

- [ ] FIRST: validate ExecuTorch `runOnFrame` works from the custom worklet
      runtime (biggest open risk — test with a single frame before wiring
      the loop).
- [ ] Extract the shared `processFrame` tick from the live worklet; both
      camera and video call it (acquire/present/retire seams only).
- [ ] Effects menu, tap picking, chips, and HUD metrics all live on video.
- [ ] Strict-sync check: pause on any frame — masks belong to the shown frame.

**Manual acceptance:** tap a person in the video → redact/spotlight/mute all
work; processing throughput ≈ segmentation p50 (fill/upload stay negligible).

### Checkpoint 5: Pacing + polish + docs

- [ ] Fast/realtime pacing toggle (skip stale frames against the wall clock).
- [ ] Restart-at-end; simple progress bar.
- [ ] Update `docs/internal/react-native-live-rendering.md` +
      `react-native-architecture.md`: the RN package now owns a native media
      frame source (the Mediabunny-role adapter), example owns pacing/UI.
- [ ] Record benchmarks: decode fps, e2e video-seconds-per-wall-second,
      memory ceiling.

## Risks

- **ExecuTorch on a custom worklet runtime** — the model module is loaded on
  the React runtime; calling `runOnFrame` from our runtime may need the same
  boxing treatment as the mask builder, or may just work like it does on the
  camera runtime. Validate first in CP4; fallback is scheduling inference
  onto the camera-style runtime pattern vision-camera-worklets provides.
- **MakeImageFromNativeBuffer constraints** — BGRA CVPixelBuffers may need
  IOSurface backing (`kCVPixelBufferIOSurfacePropertiesKey` in the reader's
  output settings) for zero-copy GPU import. Set it from the start.
- **Buffer lifetime** — a released CVPixelBuffer under a live Skia image is
  the black-flash class of bug again; the one-packet retirement pattern must
  cover both the Skia image and the native handle atomically.
- **Pool exhaustion** — AVAssetReader recycles pixel buffers from a fixed
  pool; holding too many retained handles (ring + in-flight + retired) can
  stall the reader. Keep total outstanding ≤ 5 and make the ring size + the
  retirement depth explicit constants.
- **Worklet definition order** (known constraint) and **new-uniform cold
  restarts** (none expected — this plan adds no uniforms).

## Verification Commands

```bash
npm run typecheck && npm run lint && npm run test && npm run build && npm run package:smoke
npm run example:react-native:typecheck
npm run example:react-native:ios -- --device   # native checkpoints
```

## Done

The demo has a Video mode that opens a saved file, starts rendering
annotated frames immediately, processes at inference-bound speed with
decode fully hidden, supports the same tap effects as live, and leaks no
buffers across a full playback loop.
