# React Native Unified Session Plan

## Goal

One React Native JavaScript interface where a host supplies a model and the
package owns everything else — frame lifecycle, backpressure, timing policy,
presentation — for both live camera and saved video.

This is not a new direction. It is the plan already recorded in
[`react-native-live-rendering.md`](react-native-live-rendering.md) under
"Next Architecture Step", including the sentence that defines the target:
"Inference should remain outside the package. ExecuTorch is only one producer."

## Context

The package currently has three session implementations:

| Implementation                                          | Lines | Worklets | Used by the demo |
| ------------------------------------------------------- | ----- | -------- | ---------------- |
| `sessions/media-session-core.ts` (`createMediaSession`) | 468   | 0        | no               |
| `sessions.ts` (saved-video pump)                        | 930   | 18       | yes              |
| `react/use-live-inference.ts` (live controller)         | 1086  | 23       | yes              |

The generic one has the right contracts and is publicly exported from both
`./media-session` and `./sessions`. Both real lanes bypass it.

That is not neglect. Two concrete blockers make convergence impossible today,
and both must be removed before any lane can move.

### Blocker 1: the generic core cannot run in a worklet

`media-session-core.ts` contains zero `"worklet"` directives. Its frame path is
`async onFrame()` awaiting `processor.process()`, `renderer.prepare()`, and
`renderer.present()`. `MediaFrameProcessor.process()` is typed
`Result | Promise<Result>`.

Both production lanes run per-frame work synchronously inside worklet runtimes
(the VisionCamera frame callback, and the saved-video pump runtime). A Promise
boundary per frame is not available there. So the contract-shaped core is
structurally unusable by the lanes that need it.

### Blocker 2: `DetectionFrame` has no hot-path mask encoding

In `packages/core/src/types/detections.ts`, `DetectionMask` resolves to exactly
one variant:

```ts
export type DetectionMask = CompressedRleDetectionMask;
```

whose payload is a `counts` **string**. That is the semantic cold-storage form,
correct for the browser package's IndexedDB path and for fixture manifests.

Normalizing a live mask into it would mean RLE-encoding a ~921,600-byte buffer
into a JavaScript string per detection per frame, on a worklet. That is why the
native lanes invented `ReactNativeLiveSerializedDetection` with a raw
`Uint8Array` instead. The parallel shape is a deliberate performance decision,
not drift.

`DetectionMaskEncoding` is already an enum with one member, so the design
anticipates a second encoding.

## Phase 0 — Remove the two blockers

Small in code, and nothing else can proceed without them.

**0.1 Add a dense mask encoding to core.** Introduce
`DenseBitmapDetectionMask` (`Uint8Array` data, `width`, `height`, and a
`rotatedCw` flag) alongside the RLE variant and widen the `DetectionMask`
union. This gives the hot path a zero-cost normalization target and keeps one
`Detection` shape serving both the web cold path and the native hot path.

The `rotatedCw` flag replaces `ReactNativeLiveSerializedDetection.maskRotatedCw`
with a vendor-neutral concept: it describes buffer layout, not a fact about
ExecuTorch.

**0.2 Add a synchronous processor contract.** Define the worklet-callable
variant of `MediaFrameProcessor` whose `process()` returns
`MediaFrameProcessorResult` with no Promise. Keep the async form for JS-thread
hosts. The session core selects the path; hosts pick whichever their runtime
allows.

**0.3 Do the same for the renderer adapter.** The Blocker 1 diagnosis names
three awaits, and 0.2 removes only the first. Apply the same discriminated
`sync: true` split to `MediaRendererAdapter`, covering `prepare`, `present`,
and `disposePacket`.

`disposePacket` belongs in the sync half even though it is not obviously on
the frame path: the session hands packets to `PreparedFrameStore`, whose
`releaseNow()` throws on a disposer that returns a Promise. A session with a
sync renderer must therefore construct the store with a sync disposer, or
every synchronous release fails at runtime.

Note that widening `MediaRendererAdapter` into a union makes
`implements MediaRendererAdapter<...>` invalid — a class can only implement an
object type. Class-based adapters must implement `AsyncMediaRendererAdapter`
or `SyncMediaRendererAdapter` directly.

`PreparedFrameStore` needs nothing: it already ships `presentNow()` and
`discardNow()` beside its async pair, which is the naming precedent 0.2 and
0.3 follow.

**Exit criteria.** Core tests cover both mask encodings. A session whose
processor and renderer are both sync is proven to run its whole frame path
with no microtask in it, and the async default is proven to still yield.

## Phase 1 — Open the producer contract (live camera first)

Today `UseReactNativeLiveInferenceOptions` requires
`inferenceMode: "segmentation" | "pose"` plus `segmentationProcessor:
ExecutorchLiveSegmentationProcessor` and `pose:
ExecutorchLivePoseConfiguration`. Vendor names appear in the package's public
option surface, and each new task type forces a package change.

Replace both with one producer that returns a `DetectionFrame`. The pose path
already demonstrates the pattern with
`createDetectionFrameFromExecutorchCocoPoses`; segmentation needs its
equivalent, which Phase 0.1 makes cheap.

Move every ExecuTorch-specific repair — `unrotateExecutorchUpBbox`,
`framePixelsAreUpright`, the `maskRotatedCw` plumbing — fully behind
`adapters/executorch.ts`, so exactly one file knows what ExecuTorch is.

**Exit criteria.** A second producer adapter (a fake one in tests is enough)
can be written without touching any file outside `adapters/`. No identifier
containing "Executorch" appears in the live hook's public options.

**Done.** The hook takes one `ReactNativeLiveDetectionProducer` and branches on
published geometry, so `ReactNativeLiveInferenceMode` is gone. Keypoint drawing
moved out of the adapter as `createReactNativeKeypointDrawInstructions`, which
was the last vendor name the hook imported.

Two notes for whoever picks this up. Detections still cross into the ID-mask
fill through `serializeReactNativeLiveDetectionFrame`, a shallow bridge to the
older flat shape; retiring it means teaching the fill loops to read `Detection`
directly, which is hot-path work worth measuring first. And a frame carrying
both keypoints and masks currently renders only the keypoints, because the two
lanes still evaluate different extension rules.

## Phase 2 — Make the clock a parameter

Add an explicit timing policy to the session options. The
`react-native-live-rendering.md` architecture step already reserves this axis
("timing policy: strict packet presentation first; any future low-latency mode
must be explicit about the weaker synchronization guarantee").

| Clock      | Behavior                                      | Status                                          |
| ---------- | --------------------------------------------- | ----------------------------------------------- |
| `realtime` | Drop frames that arrive while busy            | Exists, as VisionCamera's `dropFramesWhileBusy` |
| `analysis` | Process every frame as fast as possible       | Exists, as the saved-video pump                 |
| `media`    | Present on the frame's PTS; infer on a subset | New                                             |

`realtime` only needs to be lifted from a vendor option into a session policy.
`analysis` stays — it is the correct mode for producing a fully annotated
video, and the mistake was only that it was the sole mode and the playback
default. `media` is the new work, and it is what makes saved video play in real
time.

Decode cost is what makes `media` viable: the native decoders cost roughly
1-5 ms per frame (measured), so decoding at 30 fps while inferring at 8 fps is
comfortable.

**Exit criteria.** A 10-second clip plays in about 10 seconds under `media`,
with the overlay updating at inference rate. `analysis` output is unchanged.

## Phase 3 — Converge the lanes onto one core

With Phase 0 done, `media-session-core.ts` can host the worklet pump. Port the
live camera lane first (it is the current priority and has the shorter feedback
loop), then the saved-video lane.

Expected shape: JS-thread orchestration owns lifecycle, state, and diagnostics;
the worklet pump owns per-frame source → processor → renderer.

**Exit criteria.** `sessions.ts` and `use-live-inference.ts` shrink
substantially, and no per-frame pump logic exists outside the core.

## Phase 4 — The public surface

One factory taking source, producer, presentation, and clock. Move
application-level features currently living in the 1086-line live controller —
instant-CV rules, privacy/redaction, spotlight — into extensions, so the
interface meant to stay stable does not grow with every demo feature.

## Out of scope: native micro-optimizations

These are real but not on the critical path, and none of them change the
architecture. Track them separately:

- Upstream `inverseRotateMat` in `react-native-executorch` unconditionally
  applies `ROTATE_90_CLOCKWISE` for `orientation: Up`, rotating and reallocating
  every mask per frame. An `orientation: "none"` (identity in, identity out)
  would be a pure win; the repo already carries patches for this dependency.
- `HybridVideoFrameSource.cpp` allocates a fresh `AHardwareBuffer` per frame;
  a free-list would matter once inference stops dominating.
- The saved-video pump serializes presentation with inference; overlapping them
  becomes natural once the clock policy exists.

## Measurement gap to close first

The saved-video pump captures `tickStartedAt` _after_ `copyNextFrame()`
returns (`sessions.ts:542-548`), so time spent blocked on the decoder is
excluded from every reported metric. Add an explicit source-wait reading before
using these numbers to judge any change above.

## What this plan does not promise

The package can own frame lifecycle, backpressure, timing policy, presentation,
mask preparation, and GPU work. It cannot own model performance. A host that
supplies a 688 ms model gets a 688 ms detection rate under any clock.

The honest interface exposes that tradeoff through diagnostics and the clock
choice rather than hiding it.
