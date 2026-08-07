# React Native Thin-Wrapper API Hardening Plan

> **For agentic workers:** implement one checkpoint at a time. Each checkpoint
> is a reviewable delivery unit and must leave the focused tests green. Run the
> listed physical-device gate before starting the next checkpoint when native,
> Skia, worklet, or frame-lifecycle behavior changes.

**Goal:** make `supervision-js-react-native` own the reusable mobile media
session, strict-sync frame pipeline, Skia presentation, interaction, resource
lifecycle, state, and diagnostics so `examples/react-native` becomes a thin
product/demo wrapper.

**Architecture:** preserve the project-wide session-first rule: one media item
maps to one session; semantic detections and styles enter the session; the
renderer owns media plus annotation composition; prepared masks, Skia images,
shared values, shaders, frame handles, and packet-retirement rules stay inside
the package. Platform and producer dependencies remain behind optional adapter
subpaths. The demo owns model choice, assets, permissions, recipe semantics,
controls, and explanatory UI.

**Tech stack:** TypeScript, React Native 0.85, React 19, Expo 56, React Native
Skia, Reanimated/Worklets, VisionCamera, Nitro Modules, Swift/iOS,
Kotlin/Android, ExecuTorch adapters, Vitest, Rollup, Metro.

**Relationship to earlier plans:** this plan supersedes the unfinished parts
of [`2026-07-09-rn-api-hardening.md`](2026-07-09-rn-api-hardening.md). It keeps
that plan's completed core re-exports, shared color resolution, defaults, Skia
and ExecuTorch subpaths, native mask builder, and saved-video session. It also
keeps its worklet ordering constraints and the decision not to introduce a
"latest mask" presentation mode.

---

## Verified Baseline — 2026-08-05

- `packages/react-native` is private at `0.0.0` and exports `.`,
  `./adapters/executorch`, `./sessions`, and `./skia`.
- The root entry owns core re-exports, layout, picking, static frame
  preparation, live ID-mask preparation, shader contracts, and the optional
  iOS native mask builder.
- `./skia` owns mask/vector preparation and image/picture disposal helpers.
- `./sessions` owns a saved-video strict-sync pump, pause/play/stop,
  packet retirement, a package-owned worklet runtime, and teardown through a
  `MediaSession`-shaped file-session facade. Renderer implementation lanes
  (`SkImage`, shared values, mask uniforms) are private to the package stage.
- The Expo app has four modes: static, live camera, saved video, and Instant
  CV. `App.tsx` is about 5,000 lines.
- The live camera path, `SyncedFrameStage`, packet swapping, shader creation,
  vector-picture swapping, class-effect filtering, active-frame picking,
  error shaping, rolling diagnostics, and most defaults still live in the
  example.
- The saved-video mode consumes `createReactNativeVideoFileSession`; the
  package owns the worklet runtime and private Skia binding, while the demo
  retains its product overlays, effects, controls, and semantic readouts.
- The package tests verify pure helpers, JS/Swift mask parity, Skia helpers,
  exports, and off-device error behavior. They do not yet exercise a complete
  session with fake source/processor/renderer adapters.
- iOS has native mask preparation and saved-video frame decode. Android uses
  the JS mask fallback; saved-video decode is explicitly **not implemented
  yet** and reports a stable availability reason.
- Post-native physical-device benchmark numbers and a current full device
  matrix are not recorded.

## Definition Of Done

### Thin-wrapper finish line

The extraction is complete when all four example modes use the same package
session and renderer contracts and the example satisfies every rule below:

- `App.tsx` and example integration modules do not import
  `react-native-reanimated`, `react-native-worklets`, mask shader source,
  mask-uniform types, native builder handles, Skia disposal helpers, or
  prepared-artifact constructors.
- The example does not call `useFrameOutput`, `useFrameRenderer`,
  `scheduleOnRN`, `makeMutable`, `Skia.Image.MakeImageFromNativeBuffer`, or
  `dispose()` for renderer-owned frame resources.
- The example contains no present/retire/dispose packet swap and no sentinel
  image/picture management.
- Static, saved-video, and live screens each create or bind one session,
  render one package-owned view, and map session state to controls/HUD.
- The example may retain `instant-cv.ts`: recipe definitions, dwell logic,
  haptics, rule cards, and product copy are app behavior. It must feed those
  rules through a generic package extension point rather than own the frame
  clock or render packet.
- The integration/orchestration portion of each mode is at most roughly
  150 lines, excluding UI components, styles, fixtures, and recipe logic.
- A boundary test enforces the forbidden low-level imports and calls above.
- A clean consumer fixture can render one static frame and typecheck one live
  adapter setup without importing package internals.

### API-hardening finish line

The mobile API is hardened when, in addition to the thin-wrapper gate:

- one primary `createMediaSession()` contract covers static, finite-file, and
  live-stream sources through source adapters;
- sessions expose aggregate state, subscription, capabilities, presentation,
  interaction, controls, diagnostics, and idempotent teardown without leaking
  backend resources;
- failed construction rolls back all acquired native/runtime resources;
- unsupported platform capabilities are explicit in session state/options and
  fail with stable errors rather than missing-module crashes;
- every public entrypoint has an exact export test and consumer type fixture;
- Metro, iOS, and Android build gates cover the optional peer layout;
- public docs distinguish stable primary API, advanced adapters, experimental
  features, and platform support.

## Ownership Boundary

| Concern                                                                 | Final owner                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------------ |
| Detection geometry, styles, lifecycle enums, picking semantics          | `supervision-js-core`                                  |
| Session lifecycle, state, defaults, frame identity, strict-sync policy  | `packages/react-native`                                |
| Prepared packet lifecycle and resource retirement                       | `packages/react-native` internal implementation        |
| Skia media/mask/vector composition and gestures                         | `supervision-js-react-native/react` backed by `./skia` |
| VisionCamera frame source and native frame presentation                 | `./adapters/vision-camera` optional adapter            |
| ExecuTorch output conversion                                            | `./adapters/executorch` optional adapter               |
| Inference model loading and model choice                                | Host/example                                           |
| Instant CV recipe semantics, authoring UI, haptics                      | Example                                                |
| Expo permissions, asset/image picking, navigation, branding, HUD layout | Example                                                |

## Public Shape To Converge On

The exact generics should be proven with consumer fixtures in Checkpoint 1,
but the common path should read approximately like this:

```tsx
import {
  createMediaSession,
  useMediaSession,
  MediaSessionView,
} from "supervision-js-react-native/react";
import { useVisionCameraMediaSource } from "supervision-js-react-native/adapters/vision-camera";
import { createExecutorchInstanceSegmentationProcessor } from "supervision-js-react-native/adapters/executorch";

const source = useVisionCameraMediaSource({ device, isActive });
const processor = createExecutorchInstanceSegmentationProcessor({
  runOnFrame: segmentation.runOnFrame,
});
const session = useMediaSession(() =>
  createMediaSession({ source, processor, presentation }),
);

return <MediaSessionView session={session} onPick={setSelection} />;
```

The non-React session factory remains independently testable. The React entry
owns only lifecycle binding and the package view; it does not become the frame
clock. `./skia` remains the advanced backend entrypoint. Vendor-specific
adapters remain optional peers and are never imported by the base entry.

The primary session should expose, subject to source capabilities:

- `play()`, `pause()`, `stop()`, and finite-source navigation when supported;
- `setPresentation()`, `setViewport()`, and render-quality controls;
- `pick()` and the active semantic detection frame;
- `subscribe()`, `getState()`, and throttled frame diagnostics;
- explicit `capabilities` such as `live`, `pausable`, and `seekable`;
- idempotent `destroy()` with post-destroy guards.

The primary session must not expose Skia images, shader uniforms, shared
values, raw native pointers, Nitro hybrid objects, or prepared ID-mask bytes.
Those may exist on advanced/internal renderer contracts only.

## Non-Goals

- Do not move ExecuTorch model loading or inference runtime ownership into the
  base package.
- Do not make VisionCamera, Expo, ExecuTorch, or Nitro required by the base
  entrypoint.
- Do not promote Golden Pose, Safety Zone, Privacy, dwell rules, or haptics to
  reusable package concepts in this plan.
- Do not route per-frame state through React or emit full detections to the JS
  thread on every frame by default.
- Do not reintroduce a weak-sync "latest mask" mode.
- Do not expose prepared artifacts just to make the demo easier to write.
- Do not make the browser package depend on React Native code or weaken its
  package-boundary checks.
- Do not promise identical file-playback features on every source silently;
  expose capabilities and platform support explicitly.

---

## Checkpoint 1 — Freeze The Consumer Contract And Adapter Seams

**Purpose:** decide the small API before moving implementation. Build it
against fake adapters so native dependencies do not dictate the session shape.

**Files:**

- Add: `packages/react-native/src/types/media-session.ts`
- Add: `packages/react-native/src/types/frame-source.ts`
- Add: `packages/react-native/src/types/frame-processor.ts`
- Add: `packages/react-native/src/types/renderer.ts`
- Add: `packages/react-native/src/sessions/media-session-core.ts`
- Add: `packages/react-native/src/media-session.ts`
- Add: `packages/react-native/src/testing/fakes.ts`
- Add: `packages/react-native/src/media-session.consumer.test.ts`
- Modify: `packages/react-native/src/index.ts`
- Modify: `packages/react-native/package.json`
- Modify: `tools/package-smoke.test.mjs`

- [x] Define one renderer-neutral mobile `MediaSession` and
      `MediaSessionOptions` using core's `MediaSessionMode`,
      `MediaSessionLifecycleState`, `PlatformMediaFrame`, presentation, and
      picking contracts where they fit.
- [x] Define pull-source and push/live-source adapter contracts without
      importing Skia, VisionCamera, Nitro, or ExecuTorch types.
- [x] Define a worklet-capable frame processor result in semantic terms. Keep
      the hot binary-mask input private or advanced; do not make shader artifacts
      the inference contract.
- [x] Define a renderer adapter whose public session-facing side accepts one
      complete prepared packet identity and owns presentation/resource details.
- [x] Define source capabilities and stable unsupported-operation errors.
- [x] Define state snapshots and diagnostics before callbacks. `onState` is
      creation sugar over `subscribe()`.
- [x] Add fake source, processor, renderer, and resource tracker adapters for
      deterministic Node tests. The session uses source-provided media time, so
      it does not need a wall-clock adapter.
- [x] Add compile-only consumer fixtures for static, saved-video, live, custom
      processor, presentation updates, picking, and destroy.
- [x] Decide the final primary import location (`/react` for the React
      convenience layer, `/media-session` for the peer-free non-React factory)
      and record it in package exports. Keep the existing `/sessions` legacy
      runtime API intact.
- [x] Add exact-export tests for every touched subpath.

**Acceptance:** contract tests compile and a fully fake session can be created,
subscribed, presented once, and destroyed without loading any optional peer.
No demo behavior changes in this checkpoint.

**Verification:**

```sh
npx vitest run packages/react-native/src/media-session.consumer.test.ts
npm run typecheck -w supervision-js-react-native
npm run boundary:check
npm run package:smoke
```

## Checkpoint 2 — Internalize The Prepared-Packet Lifecycle

**Purpose:** create one resource owner used by static, file, and live modes.
This removes the bug-prone present/retire/dispose convention from consumers.

**Files:**

- Add: `packages/react-native/src/renderers/prepared-frame-packet.ts`
- Add: `packages/react-native/src/renderers/prepared-frame-store.ts`
- Add: `packages/react-native/src/renderers/prepared-frame-store.test.ts`
- Modify: `packages/react-native/src/skia.ts`
- Modify: `packages/react-native/src/sessions.ts`

- [ ] Introduce one internal packet containing packet/frame identity, media
      resource, mask resource, vector resource, resolved draw instructions,
      active semantic frame, and diagnostics.
- [ ] Implement a single-writer store with explicit `prepare`, `present`,
      `retire`, and `dispose` transitions.
- [ ] Preserve the one-packet retirement delay required by Skia's UI thread.
- [ ] Preserve non-null live sentinels internally where Skia requires them;
      never expose sentinel ownership to consumers.
- [ ] Make packet and store disposal idempotent. Dispose each owned image,
      picture, native handle, surface, and builder result exactly once.
- [ ] Roll back partially prepared packets when inference, mask preparation,
      vector preparation, media import, or presentation fails.
- [ ] Attach packet identity to diagnostics and assert that media, masks, and
      vectors presented together came from the same frame.
- [ ] Move the saved-video session onto this store without changing its public
      behavior yet.
- [ ] Add stress tests for thousands of swaps, empty detections, processor
      errors, pause/resume, destroy during work, and repeated destroy.

**Acceptance:** no session implementation contains a second packet-retirement
algorithm, and resource-tracker tests report zero leaked/double-disposed
resources across success and failure paths.

**Device gate:** saved video on iPhone must show no black flashes, stale masks,
or use-after-dispose crash through start, pause, resume, stop, replay, and
screen unmount.

## Checkpoint 3 — Package-Owned Skia Renderer And React View

**Purpose:** move `SyncedFrameStage`, shader setup, layout binding, vector
layers, labels, gestures, and resource-facing presentation into the package.

**Files:**

- Add: `packages/react-native/src/renderers/skia-media-renderer.ts`
- Add: `packages/react-native/src/react/MediaSessionView.tsx`
- Add: `packages/react-native/src/react/use-media-session.ts`
- Add: `packages/react-native/src/react/index.ts`
- Add tests under: `packages/react-native/src/renderers/` and `src/react/`
- Modify: `packages/react-native/package.json`
- Modify: `examples/react-native/App.tsx`

- [ ] Create a Skia renderer that owns frame, mask, vector, box, label,
      selection/focus, interaction, and debug lanes in one scene.
- [ ] Move runtime-effect creation, nearest mask sampling, layout mapping,
      label layout/font setup, box conversion, and vector-picture presentation out
      of the example.
- [ ] Make `MediaSessionView` read an opaque renderer binding from the session;
      do not put `SkImage`, uniforms, or shared values on `MediaSession`.
- [ ] Route taps/gestures through session layout and picking contracts so the
      active presented packet is the interaction source of truth.
- [ ] Support a generic application overlay/instruction lane for Instant CV
      without accepting arbitrary Skia objects as the primary extension API.
- [ ] Add `useMediaSession()` as lifecycle sugar that creates once, subscribes,
      replaces only when its explicit identity changes, and destroys on unmount.
- [ ] Migrate the static mode first. It should pass a media frame, detections,
      styles, visibility, and selection callback only.
- [ ] Delete the example's `SyncedFrameStage`, box/label mapping helpers,
      shader construction, static mask upload, and vector disposal after migration.

**Acceptance:** static mode renders and picks through the package view; its
integration code imports no mask artifact, shader, Skia disposal, or layout
helper APIs.

**Device gate:** static boxes, labels, masks, polygons, keypoints, selection,
rotation, and resizing match the pre-migration screenshot/behavior on iOS and
Android.

## Checkpoint 4 — Session State, Defaults, Controls, And Diagnostics

**Purpose:** turn the orchestration shell into a product-quality session before
adding the camera source.

**Files:**

- Add: `packages/react-native/src/sessions/media-session-state.ts`
- Add: `packages/react-native/src/sessions/media-session-defaults.ts`
- Add: `packages/react-native/src/sessions/media-session.ts`
- Add tests under: `packages/react-native/src/sessions/`
- Modify: `packages/react-native/src/live-defaults.ts`
- Modify: `packages/react-native/src/sessions.ts`

- [ ] Implement aggregate mobile state with core lifecycle enums: media/source
      readiness, playback, processor readiness, render preparation, active frame,
      dropped frames, fallback builder, and errors.
- [ ] Centralize file/stream/static defaults. Remove policy constants from the
      example when they are not intentionally demo-specific.
- [ ] Implement immediate subscription, unsubscribe, current state, throttled
      diagnostics, destroyed-state emission, and callback silencing after destroy.
- [ ] Add post-destroy guards to every mutating method.
- [ ] Make construction transactional: a failure after opening a source,
      creating a runtime, or allocating a renderer releases everything already
      acquired.
- [ ] Expose source capabilities rather than inferring features from platform
      or source kind in the UI.
- [ ] Keep detailed per-frame timings opt-in and off the React state hot path.
- [ ] Consolidate error codes and stage details. User-facing state should not
      require parsing native error strings.
- [ ] Keep `createReactNativeVideoSession` as a temporary compatibility wrapper
      over `createMediaSession` until the saved-video migration is complete.

**Acceptance:** fake-adapter lifecycle tests cover loading, ready, processing,
playing, paused, stopped, error, and destroyed states; failed construction and
all control methods have deterministic behavior.

## Checkpoint 5 — Saved Video Becomes A Source Adapter

**Purpose:** replace the special saved-video session with the common session
plus an iOS native file-source adapter.

**Files:**

- Add: `packages/react-native/src/adapters/video-file.ts`
- Modify: `packages/react-native/src/video-frame-source.ts`
- Modify: `packages/react-native/src/sessions.ts`
- Modify: `packages/react-native/ios/HybridVideoFrameSource.swift`
- Modify: `examples/react-native/App.tsx`
- Add focused tests for the adapter and session integration

- [ ] Wrap `VideoFrameSource` behind the common pull-source contract.
- [ ] Move the decode pump, worklet runtime scheduling, memory guards, frame
      rasterization, and timestamp reporting under session/source/renderer owners.
- [ ] Replace `serializeFrame` and `resolveMaskEffects` callbacks with the
      common processor and presentation-extension contracts.
- [ ] Preserve strict packet identity and bounded high-resolution behavior.
- [ ] Decide and document whether v1 file sessions are analysis-paced or
      media-clock paced. Report the decision in state/diagnostics; do not make the
      UI infer it from wall time.
- [ ] Add seek only after the native source can implement it correctly. Until
      then `capabilities.seekable` must be false and `seek()` must fail with the
      stable unsupported-operation error.
- [ ] Migrate `VideoFileProof` to one session/view plus asset picker and UI
      controls.
- [ ] Remove direct shared values, mask effects shader, layout overlays,
      builder loading, worklet runtime, and resource management from video mode.

**Acceptance:** the video mode's integration code owns the URI, processor,
presentation/effect choices, and controls only. The old specialized factory is
deleted or a trivial deprecated forwarding wrapper with a removal issue.

**Device gate:** sample and picked 720p/1080p/4K videos on iPhone; verify
pause/resume/stop/unmount, memory bounds, orientation, effect picking, end of
stream, and corrupted/unsupported input errors.

## Checkpoint 6 — Live Session Core And VisionCamera Adapter

**Purpose:** move the largest remaining block — camera frame processing and
strict-sync presentation — from `App.tsx` into reusable package code.

**Files:**

- Add: `packages/react-native/src/sessions/live-media-session.ts`
- Add: `packages/react-native/src/adapters/vision-camera.tsx`
- Add: `packages/react-native/src/adapters/vision-camera.test.ts`
- Modify: `packages/react-native/package.json`
- Modify: `examples/react-native/App.tsx`

- [ ] Implement the common push/live-source path using the same packet store,
      processor, renderer, state, and diagnostics as saved video.
- [ ] Put `useFrameOutput`, stable frame callback identity,
      `dropFramesWhileBusy`, target resolution, buffer rotation, native frame
      renderer, and frame disposal in the VisionCamera adapter.
- [ ] Keep strict sync: the adapter presents a camera frame only after the
      processor and render packet for that exact frame are ready.
- [ ] Keep React limited to permissions/device selection, session state, and
      throttled readouts. No per-frame annotation or packet data flows through
      React state.
- [ ] Normalize camera orientation/mirroring into explicit frame metadata and
      test all supported orientations.
- [ ] Convert dropped-frame, processor, preparation, render, and native-buffer
      failures into stable session diagnostics.
- [ ] Ensure adapter teardown detaches the frame callback before disposing
      packet/native resources.
- [ ] Add a Metro/Babel worklet test or build fixture that catches capture
      order problems that Vitest cannot see.
- [ ] Migrate standard live segmentation and live pose modes to the common
      session/view.
- [ ] Delete the example's live frame callback, shared-value metric bank,
      swap helpers, native builder loading, frame renderer calls, and error-shaping
      helpers.

**Acceptance:** the example never imports VisionCamera frame-output/renderer
hooks directly and has no frame worklet. Switching segmentation/pose changes
the injected processor without recreating the camera renderer or losing the
current session lifecycle.

**Device gate:** physical iPhone camera with segmentation and pose, portrait
and landscape, foreground/background, permission denial/recovery, model
switching, repeated screen mount/unmount, and intentional processor failures.

## Checkpoint 7 — Producer, Effects, And Derived-Overlay Extensions

**Purpose:** make realistic producers and app-owned rules fit cleanly without
leaking the renderer hot path back into the demo.

**Files:**

- Modify: `packages/react-native/src/adapters/executorch.ts`
- Add: `packages/react-native/src/presentation/frame-effects.ts`
- Add: `packages/react-native/src/presentation/derived-overlay.ts`
- Add focused worklet and parity tests
- Modify: `examples/react-native/App.tsx`
- Modify: `examples/react-native/src/instant-cv.ts` only where adapter wiring
  requires it

- [ ] Add ExecuTorch processor factories that accept structural `runOnFrame`
      functions and emit the common processor result for instance segmentation and
      COCO pose. The package still does not load models.
- [ ] Centralize orientation, mask metadata, bbox conversion, class color,
      confidence, and pose-to-core conversion in the adapter.
- [ ] Define renderer-owned per-detection mask effects such as normal, hidden,
      mosaic, and spotlight only because both camera and saved-video modes already
      prove the need. Recipe selection remains app-owned.
- [ ] Define a bounded, worklet-safe derived-overlay contract using core draw
      instructions or semantic overlay data, not Skia pictures supplied by apps.
- [ ] Keep application rule state infrequent and serializable; mirror it into
      the frame runtime without replacing the frame callback.
- [ ] Make active-frame picking session-owned, including mask-aware picking.
      Return semantic pick results to the host only for requested interactions.
- [ ] Migrate Golden Pose, Safety Zone, and Privacy to the generic processor,
      effects, derived-overlay, and picking seams.
- [ ] Remove demo-owned detection serialization, mask filtering, vector-frame
      preparation, pose instruction conversion, and live/video picking helpers.

**Acceptance:** `instant-cv.ts` still defines product rules, but none of its
callers build masks, Skia pictures, shader uniforms, or present camera frames.
Standard live, video effects, and Instant CV share the same session renderer.

**Device gate:** Golden Pose calibration/status, rectangular and free-shape
Safety Zone, class teaching/removal, Privacy preview/selection/mosaic/contour,
and haptic edge transitions all remain frame-synchronized.

## Checkpoint 8 — Demo Convergence And Enforced Thin Boundary

**Purpose:** finish the extraction, remove compatibility scaffolding, and make
future regressions obvious.

**Files:**

- Refactor: `examples/react-native/App.tsx`
- Add focused screen/UI modules under: `examples/react-native/src/screens/`
- Add: `tools/react-native-example-boundary.test.mjs`
- Modify: `package.json`
- Modify: `examples/react-native/README.md`
- Modify: `docs/internal/react-native-architecture.md`
- Modify: `docs/internal/react-native-live-rendering.md`

- [ ] Split demo-owned screens, controls, styles, recipes, and fixtures from
      session integration so line-count metrics are meaningful.
- [ ] Enforce the forbidden imports/calls in the thin-wrapper definition with
      a repository test.
- [ ] Remove obsolete low-level imports and compatibility factories from the
      example.
- [ ] Remove stale docs that call saved video a future proof.
- [ ] Add one concise consumer example per source kind to the README.
- [ ] Record before/after ownership and line counts. Do not optimize for line
      count by hiding app logic in an unowned "utils" file.
- [ ] Run the complete four-mode manual script and attach device/build evidence
      to the checkpoint PR.

**Acceptance:** every thin-wrapper rule at the top of this document passes.
At this point the extraction goal is complete even if later release/platform
work remains.

## Checkpoint 9 — Tighten Names, Errors, Exports, And Compatibility

**Purpose:** make the private experimental surface coherent before it becomes
public.

**Files:**

- Modify public files under: `packages/react-native/src/`
- Modify: `packages/react-native/package.json`
- Modify: `tools/package-smoke.test.mjs`
- Add/update public API and consumer fixtures

- [ ] Name primary concepts without redundant `ReactNative` prefixes inside
      the `supervision-js-react-native` namespace: `createMediaSession`,
      `MediaSession`, `MediaSessionState`, `MediaSessionView`, and source/processor
      adapters.
- [ ] Keep backend-specific names explicit (`SkiaRenderer`,
      `VisionCameraSource`, `ExecutorchFrameProcessor`).
- [ ] Classify every export as primary, advanced, adapter-specific, or
      internal. Delete accidental exports and duplicated concepts.
- [ ] Move low-level mask builder, shader, and prepared-artifact APIs to an
      explicitly advanced/internal subpath if external consumers do not need them.
- [ ] Add exact runtime/declaration export manifests for all entrypoints.
- [ ] Use stable error codes plus causes for optional peer absence, unsupported
      platform/capability, source open, processor, render preparation, and native
      resource failures.
- [ ] Decide compatibility posture while the package is private: prefer direct
      renames. If an internal consumer already depends on old names, add one
      documented deprecation window and tests for aliases.
- [ ] Confirm package entrypoints do not execute native/vendor code at import
      time and base imports work under Node.

**Acceptance:** the primary API reads like one coherent mobile session product,
not a bag of `ReactNative*` helpers; a generated/export-manifest diff is small
enough for human review.

## Checkpoint 10 — Android And Native Capability Hardening

**Purpose:** make "mobile" support honest and explicit rather than silently
iOS-shaped.

**Files:**

- Add Android native sources under: `packages/react-native/android/`
- Modify Nitro specs and generated code
- Modify package/example native configuration
- Add/update platform support docs and build workflows

- [ ] Validate static and live rendering on Android through the JS mask
      fallback before adding native optimization.
- [ ] Implement the Android saved-video frame source or explicitly exclude
      saved-video support from the first Android contract. The session capability
      state and docs must match the decision.
- [ ] Profile the JS mask path. Implement a Kotlin/C++ Nitro mask builder only
      if it is needed to meet the measured frame budget; do not add native code for
      symmetry alone.
- [ ] Add Android autolinking/codegen and `assembleDebug` CI coverage.
- [ ] Add iOS pod install/build CI coverage so Nitro generation and Swift
      compilation cannot drift unnoticed.
- [ ] Verify missing optional native capability produces fallback diagnostics,
      not a crash or import failure.
- [ ] Publish a source-kind/platform capability matrix.

**Acceptance:** every advertised Android mode passes on a physical device or
emulator, and unsupported modes are disabled by capability state with a clear
reason.

## Checkpoint 11 — Performance, Packaging, Documentation, And Release Gate

**Purpose:** prove the extracted package is portable and does not regress the
hot path before removing `private`.

**Files:**

- Add/update React Native packaging scripts under: `tools/`
- Modify: `packages/react-native/package.json`
- Modify: root `package.json`
- Modify: `.github/workflows/`
- Modify: `docs/public/guides/public-api.md`
- Modify internal RN architecture/live-rendering docs
- Add a public mobile guide and platform matrix

- [ ] Add an RN tarball/dry-run that makes the private core dependency portable
      for an external consumer; do not assume the browser tarball script covers it.
- [ ] Install the archive in a clean Expo/Metro fixture outside the monorepo and
      build all documented entrypoints with no `file:` dependency leakage.
- [ ] Validate optional peers: base import, React/Skia view, VisionCamera
      adapter, ExecuTorch adapter, and native Nitro features fail or resolve exactly
      as documented.
- [ ] Record physical-device p50/p90 for producer, serialization, mask fill,
      upload, total strict-sync tick, dropped frames, and memory for representative
      static/live/video cases.
- [ ] Compare against the pre-extraction baseline. Investigate regressions;
      avoid inventing absolute budgets without device/model evidence.
- [ ] Assert no unbounded frame queue, packet/resource count, diagnostic buffer,
      or React state growth during a sustained run.
- [ ] Run a 10-minute live-camera soak and repeated mount/unmount leak test on
      supported iOS and Android devices.
- [ ] Update public docs from "future private package" to the exact supported
      contract only after all gates pass.
- [ ] Remove `private`, choose the version, and run publish dry-run only after
      ownership, npm release, platform, CI, and clean-consumer checks are complete.

**Acceptance:** `npm run verify`, RN clean-consumer smoke, Metro bundle, iOS
build, Android build, device matrix, soak, and performance comparison pass for
the exact release candidate. Publishing remains a separate explicit action.

---

## Cross-Cutting Test Matrix

Every checkpoint should add the narrowest relevant cells and keep existing
cells green.

| Layer              | Required evidence                                                            |
| ------------------ | ---------------------------------------------------------------------------- |
| Pure/core          | layout, style resolution, picking, orientation, effect mapping               |
| Session with fakes | state, controls, strict packet identity, errors, teardown                    |
| Resource lifecycle | failed prepare, swap, retirement, destroy, double destroy                    |
| Worklet            | Babel/Metro transform, capture order, serializable inputs, no React hot path |
| Package boundary   | no web/DOM/Pixi/Mediabunny imports; optional peers stay optional             |
| Consumer           | exact exports, declarations, static fixture, live adapter fixture            |
| Native build       | iOS pods/Swift/Nitro; Android Gradle/Kotlin/Nitro                            |
| Physical device    | static, live segmentation, live pose, video, Instant CV, lifecycle           |
| Performance        | p50/p90 timing, dropped frames, packet/resource bounds, soak memory          |

## Mandatory Implementation Guardrails

- Re-fetch and test the exact branch head before each checkpoint handoff.
- Keep commits/checkpoints small enough to compare the demo before and after.
- Use dependency injection for source, processor, renderer, runtime, scheduler,
  clock, and resource tracking in tests; do not make Node tests load native
  modules.
- Keep all worklet helpers declared before module-level worklets that capture
  them. Vitest alone is not proof; include a Metro/Babel/device gate.
- Keep inference producer failures separate from renderer/preparation failures
  in state and diagnostics.
- Keep media and annotations in one renderer-owned composition.
- Keep prepared resources private and semantic detections as the host contract.
- Do not promote demo-specific rules without a second independent consumer.
- Do not mark the package release-ready based only on TypeScript/Vitest; native
  compilation and physical-device evidence are required.

## Recommended Delivery Sequence

Use one PR per checkpoint by default. Checkpoints 2, 3, 5, 6, 7, and 10 change
runtime/device behavior and require manual device evidence before merge.
Checkpoint 8 is the extraction milestone. Checkpoint 11 is the release-readiness
milestone; it does not authorize publishing.
