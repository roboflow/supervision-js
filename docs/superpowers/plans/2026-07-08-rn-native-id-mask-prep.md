# RN Native ID-Mask Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` or
> `superpowers:executing-plans` to implement this plan checkpoint-by-checkpoint.
> Stop after each checkpoint for manual iPhone testing.

**Goal:** Move the React Native strict-sync live ID-mask fill path out of
JavaScript/worklet loops and into an experimental native JSI/Nitro builder,
while preserving the renderer-owned invariant: one camera frame is presented only
with the prepared annotation packet produced from that same frame.

**Why now:** Current iPhone debug numbers show RF-DETR Nano CoreML INT8
segmentation around `46-58ms` p50/p90 and mask prep/fill around `18-33ms`.
Upload/serialization are effectively `0ms`. That means rendering-side mask prep
is the next controllable bottleneck. If native prep reduces fill from roughly
`20-30ms` to low single digits, total strict-sync tick should approach model time
plus a small preparation margin.

**Architecture:** Keep `supervision-js-core` as the renderer-neutral semantic
layer. Keep ExecuTorch and VisionCamera example-owned. `packages/react-native`
owns the reusable live ID-mask artifact contract, JS fallback builder, and a new
optional native builder. The native builder accepts already-produced masks and
style metadata, writes one detection-indexed `Alpha_8` ID-mask artifact, and
returns the same artifact shape consumed by the strict-sync render packet.

**Tech Stack:** TypeScript, React Native, VisionCamera frame outputs,
react-native-worklets, React Native Nitro Modules, Swift/C++ iOS native code,
Skia in the example renderer, Vitest, Rollup, Expo development build.

---

## Current State

- `packages/core/src/utils/id-mask-frame.ts` owns the platform-neutral ID-mask
  semantics for normal detection frames.
- `packages/react-native/src/index.ts` already exposes:
  - `ReactNativeLiveIdMaskArtifact`
  - `ReactNativeLiveSerializedDetection`
  - `resolveReactNativeLiveIdMaskArtifactSize()`
  - `createReactNativeLiveIdMaskArtifact()` as the JS fallback builder.
- `examples/react-native/App.tsx` still has a duplicated worklet-only live fill
  path in `createLiveSkiaMaskFrame()`.
- The live demo is now strict-sync only: segmentation, mask packet creation, and
  `frameRenderer.renderFrame(frame)` happen in one frame callback.
- `react-native-nitro-modules`, `react-native-vision-camera-worklets`, and
  `react-native-nitro-image` are already installed by the RN example stack.

## Non-Goals

- Do not move ExecuTorch into `packages/react-native`.
- Do not move VisionCamera into `packages/react-native`.
- Do not reintroduce a "latest mask" mode.
- Do not increase mask artifact resolution by default.
- Do not solve RF-DETR mask quality in this pass. Native prep improves latency
  and headroom; if model masks are blocky, the quality fix is model/output or
  shader/post-processing work.
- Do not promise a stable public RN API yet.

## Target Contract

The reusable RN package should expose an automatic builder that hides native
availability:

```ts
export interface ReactNativeLiveIdMaskBuildDiagnostics {
  readonly builder: "native" | "js";
  readonly fillMs: number;
  readonly uploadMs?: number;
  readonly fallbackReason?: string;
}

export interface ReactNativeLiveIdMaskBuildResult {
  readonly artifact: ReactNativeLiveIdMaskArtifact;
  readonly diagnostics: ReactNativeLiveIdMaskBuildDiagnostics;
}

export function createReactNativeLiveIdMaskArtifactAuto(
  options: ReactNativeLiveIdMaskArtifactOptions,
): ReactNativeLiveIdMaskBuildResult | undefined;
```

The native implementation should match the JS builder's semantics exactly:

- same artifact width/height/scale;
- same detection ordering and top-most overlap behavior;
- same palette layout;
- same `MAX_ID_MASK_PALETTE_ENTRIES` limit;
- same `Alpha_8` byte layout;
- same empty/invalid-mask behavior.

## Key Design Choice

Start with a native builder that returns raw `Alpha_8` bytes plus metadata, not a
Skia image handle.

Reason:

- It keeps `packages/react-native` independent from Skia runtime objects.
- Current upload is measured near `0ms`, so the byte-to-Skia-image step is not
  the bottleneck yet.
- It gives us a correctness-preserving native seam quickly.

If profiling later shows byte transfer or Skia image construction is expensive,
add a second optional adapter that returns a native image/texture handle.

## Checkpoints

### Checkpoint 1: Consolidate The JS Live Builder In The RN Package

**Files:**

- Modify: `packages/react-native/src/index.ts`
- Modify: `packages/react-native/src/index.test.ts`
- Modify: `examples/react-native/App.tsx`

- [ ] Remove the duplicated live fill loop from `examples/react-native/App.tsx`.
- [ ] Reuse `createReactNativeLiveIdMaskArtifact()` from
      `packages/react-native` inside the live worklet.
- [ ] Add package-level tests that compare artifact dimensions, palette entries,
      overlap behavior, invalid masks, and empty detections.
- [ ] Keep example visuals and strict-sync behavior unchanged.
- [ ] Run:

```bash
npm run typecheck -w supervision-js-react-native
npx vitest run packages/react-native/src/index.test.ts
npm run example:react-native:typecheck
```

**Manual acceptance:** The iPhone demo still shows strict-sync masks/labels, and
debug metrics remain in the same rough range as the current baseline.

### Checkpoint 2: Add Native Builder Interface And Fallback Routing

**Files:**

- Add: `packages/react-native/src/native-id-mask-builder.ts`
- Modify: `packages/react-native/src/index.ts`
- Modify: `packages/react-native/src/index.test.ts`
- Modify: `examples/react-native/App.tsx`

- [ ] Define a small internal native builder interface with `isAvailable()` and
      `createArtifact(options)`.
- [ ] Add `createReactNativeLiveIdMaskArtifactAuto()` that tries native first
      and falls back to JS.
- [ ] Surface diagnostics: `builder`, `fillMs`, and `fallbackReason`.
- [ ] Do not require a native module to run package tests.
- [ ] Update the RN debug HUD to show `Prep native/js`.
- [ ] Run:

```bash
npm run typecheck -w supervision-js-react-native
npm run example:react-native:typecheck
```

**Manual acceptance:** Before native code exists, the demo should explicitly say
the JS fallback is active and keep working.

### Checkpoint 3: Scaffold The Nitro Native Module

**Files:**

- Add: `packages/react-native/nitro.json`
- Add: `packages/react-native/src/specs/IdMaskBuilder.nitro.ts`
- Add: `packages/react-native/ios/HybridIdMaskBuilder.swift`
- Add: `packages/react-native/ios/*` as required by Nitro generation
- Modify: `packages/react-native/package.json`
- Modify: `examples/react-native/package.json`
- Modify: `examples/react-native/scripts/patch-expo-xcode-project.mjs` only if
  Expo/Xcode generated project patches are needed.

**Reference resources:**

- `node_modules/react-native-nitro-modules/README.md`
- `node_modules/react-native-nitro-image/src/specs/ImageFactory.nitro.ts`
- `node_modules/react-native-nitro-image/ios/HybridImageFactory.swift`
- `node_modules/react-native-vision-camera-worklets/src/specs/WorkletQueueFactory.nitro.ts`

- [ ] Follow Nitro's generated-spec pattern instead of hand-rolling a legacy
      bridge.
- [ ] Keep `react-native-nitro-modules` as a peer dependency for the RN package
      and an example dependency for the Expo app.
- [ ] Generate the native bindings needed by the RN package.
- [ ] Verify Expo prebuild/pod install can see the local workspace package.
- [ ] Keep Android either unimplemented with a clear fallback or add a minimal
      Kotlin placeholder returning unavailable.
- [ ] Run:

```bash
npm run build -w supervision-js-react-native
npm run example:react-native:typecheck
```

**Manual acceptance:** The iOS development build installs and opens. If the
native module is not ready yet, the app still falls back to JS with a clear
debug message.

### Checkpoint 4: Implement The iOS Native Fill Loop

**Files:**

- Modify: `packages/react-native/ios/HybridIdMaskBuilder.swift`
- Modify generated native spec files as required by Nitro.
- Modify: `packages/react-native/src/native-id-mask-builder.ts`
- Modify: `packages/react-native/src/index.test.ts`

- [ ] Accept serialized detections with:
      `bbox`, `mask`, `maskWidth`, `maskHeight`, `color`, `confidence`,
      and `className`.
- [ ] Allocate one `UInt8` buffer of `artifactWidth * artifactHeight`.
- [ ] Fill detection IDs in declaration order so later detections render on top.
- [ ] Write palettes and stroke widths into contiguous numeric arrays matching
      the JS shader uniforms.
- [ ] Avoid per-pixel allocations.
- [ ] Precompute row offsets and source-step mapping where possible.
- [ ] Return artifact bytes and metadata in the same shape as the JS fallback.
- [ ] Throw clear native errors for unsupported masks, too many detections, or
      invalid dimensions.
- [ ] Add tests that compare native-like fixture output against the JS builder.

**Manual acceptance:** Debug HUD shows `Prep native`, and p50/p90 prep/fill
should drop materially compared with JS fallback. Target: under `8-12ms` p90 for
the current `720x1280` artifact.

### Checkpoint 5: Preserve Strict-Sync Packet Semantics In The Example

**Files:**

- Modify: `examples/react-native/App.tsx`
- Modify: `examples/react-native/src/debug-logging.ts` if needed.

- [ ] Keep segmentation, native prep, shared-value assignment, and
      `frameRenderer.renderFrame(frame)` in the same strict-sync callback.
- [ ] Keep labels/colors/confidences from the same prepared packet.
- [ ] Keep React state updates throttled to diagnostics only.
- [ ] Add debug metrics:
      `builder`, `native fill p50/p90`, `JS fallback count`, and
      `fallback reason`.
- [ ] Confirm there is no path that renders a camera frame with an older mask
      packet.

**Manual acceptance:** Moving the phone quickly should not show stale masks; the
demo may drop frames, but presented frames should be synchronized.

### Checkpoint 6: Benchmark And Decide Next Native Escalation

**Files:**

- Modify: `docs/internal/react-native-live-rendering.md`
- Modify: `docs/internal/react-native-architecture.md`
- Add or modify RN benchmark notes under `benchmark/` only if useful.

- [ ] Record before/after p50/p90 for segmentation, prep/fill, upload, and total
      tick.
- [ ] If prep/fill drops below roughly `8-12ms` p90, mark model inference as the
      current ceiling.
- [ ] If prep/fill remains high, profile whether the cost is native fill,
      ArrayBuffer transfer, or Skia image construction.
- [ ] If transfer/upload becomes visible, plan a second native adapter that
      returns a native image/texture handle instead of bytes.
- [ ] Update docs with the measured result and next bottleneck.

**Manual acceptance:** We can explain, with numbers, whether the renderer is now
bounded mostly by RF-DETR or still by annotation preparation.

## Risks

- Nitro module changes require rebuilding the iOS development app; hot reload is
  not enough.
- Worklet-thread compatibility needs validation. A Nitro method callable from
  normal JS is not automatically enough if it cannot be called from the
  VisionCamera/worklet lane.
- Returning raw bytes is intentionally conservative. If byte transfer becomes
  expensive, we will need a Skia/native-image interop pass.
- Native prep will not fix rough RF-DETR mask geometry. It only creates enough
  performance headroom to spend time on shader smoothing or higher-quality model
  output later.

## Verification Commands

Run these after each completed native checkpoint:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
npm run package:smoke
npm run example:react-native:typecheck
```

For native checkpoints, also rebuild/install the iOS development app:

```bash
npm run example:react-native:ios -- --device
npm run example:react-native:dev-client:ios
```

## Done

This plan is complete when the RN live demo defaults to native ID-mask prep on
iOS, falls back cleanly to JS when native support is unavailable, preserves
strict-sync rendering, and shows measured prep/fill improvement enough that the
remaining bottleneck is clearly model inference or a documented native transfer
cost.
