# RN API Hardening Plan — toward releasing core + web + react-native

> **For agentic workers:** implement checkpoint-by-checkpoint. Phase 1 is safe
> to land in one session (pure refactor, demo stays green). Phases 2–4 each
> deserve their own session and manual iPhone verification.

**Goal:** Bring `supervision-js-react-native` to the same API maturity as
`supervision-js` (web) so the three packages (core, web, react-native) can be
released as one coherent story. The web package and the vanilla demo are the
benchmark: one primary factory, curated core re-exports, owned lifecycles,
centralized defaults, diagnostics-over-throwing.

**Why now:** The RN pipeline works (live camera + saved video, native mask
prep, effects, strict sync), but it works as ~3,600 lines of example-app glue
over a bag of low-level helpers. A consumer today would have to rewrite the
demo by hand. Everything hard has already been proven in the demo — hardening
is mostly _moving proven code down a layer_ and matching web's API shape.

---

## Benchmark: what the web package does that RN doesn't

Verified against source, 2026-07-09:

1. **Session-first surface.** `createMediaSession()` is the whole story for
   normal consumers; `examples/vanilla/src/main.ts` consumes the entire
   library in ~180 lines (one factory call + style objects + `onState`).
   The RN demo is 3,613 lines because the pump, packet lifecycle, mask-frame
   orchestration, stage component, and defaults all live in app code.
2. **Thin curated barrel over core.** `packages/web/src/index.ts` re-exports
   the supported core surface _verbatim_ (same symbol names) and adds only
   platform factories + platform media I/O. RN re-exports almost nothing from
   core; the demo imports from `supervision-js-core` directly.
3. **Provider seam.** `createMediaRenderer` is a ~20-line adapter injecting
   Pixi (`createPixiMediaScene`) + Mediabunny (`openMediabunnyMediaSource`)
   into a provider-agnostic `createMediaRendererCore`. The RN analog is a
   Skia scene + a frame source (camera push / `VideoFrameSource` pull)
   injected into a live-session core; the strict-sync worklet pump plays the
   role of web's `createMediaPlaybackController`.
4. **Lifecycle discipline.** Every stateful web object exposes idempotent
   `destroy()` with cascading teardown, post-destroy guards, and leak-free
   failed construction. In RN, image disposal / packet retirement / handle
   release are conventions the app must know (source of past black-flash and
   disposed-image bugs).
5. **Centralized named defaults** (`media-session-defaults.ts`) merged with
   user options; RN's equivalents (`LIVE_MASK_ARTIFACT_MAX_PIXELS`, mosaic
   cell size, …) live in `examples/react-native/App.tsx`.
6. **Fallback + diagnostics pattern.** Web's worker→main-thread fallback
   (`createMaskFramePreparer`) is structurally identical to RN's
   native→JS mask-builder fallback (`createReactNativeLiveIdMaskArtifactAuto`
   - `ReactNativeLiveIdMaskBuildDiagnostics`). **RN already matches here** —
     keep this pattern as the template for future fallbacks.

Where RN is already sound: picking and id-mask building delegate to core
(`pickReactNativeDetectionAtPoint` → `pickDetectionAtPoint`,
`createReactNativeIdMaskFrame` → `createIdMaskFrame`); JS/Swift fill loops are
byte-parity tested; core itself is verified DOM-free and its session/renderer
contracts (`MediaSessionLifecycleState<…>`, `PlatformMediaFrame<TPayload>`)
are generic precisely so RN can instantiate them.

## The worklet constraint (shapes every phase)

Frame worklets can only call worklet-marked functions. There is exactly one
acceptable way to share logic with core, in priority order:

- **Mark the core function itself with the `"worklet"` directive.** The
  directive is an inert string everywhere except React Native's worklets
  Babel plugin (verified: it survives core's rollup build into `dist`, and
  Metro's Babel pass workletizes `node_modules` code — the same mechanism
  the RN package's own worklets already rely on). This keeps ONE central
  implementation for web and RN; `resolveDetectionClassColorStyle` is the
  first example. Small pure helpers only — no platform APIs, no heavy deps.
- **Capture plain data derived from core at module load** when only values
  (not logic) are needed inside the worklet.
- Mirrored reimplementations of core logic in the RN package are **not
  allowed** — a mirror was tried for color resolution and replaced with the
  core directive approach the same day.
- **Module order:** worklet helpers and any consts they capture must be
  defined above their captors (the plugin removes hoisting; vitest does not
  catch violations). This applies inside core files that carry directives
  too (`color-palette.ts` defines helpers first for this reason).

---

## Phase 1 — Align with core (pure refactor, this session)

No behavior changes on device beyond unknown-class colors (see CP2).

### CP1: Curated core re-export barrel

`packages/react-native/src/index.ts` re-exports, verbatim (mirroring web's
curation, scoped to what RN consumers need now):

- Values: `BaseBoxStyle`, `BaseLabelStyle`, `BaseMaskStyle`, `BoxShape`,
  `BoxStrokeAlignment`, `LabelPlacement`, `DetectionMaskEncoding`,
  `pickDetectionAtPoint`, `decodeCompressedRleMask`,
  `resolveDetectionClassColorStyle`, `normalizeDetectionClassName`,
  `DEFAULT_DETECTION_CLASS_STYLES`, `DEFAULT_DETECTION_COLOR_SEQUENCE`,
  `SUPERVISION_ROBOFLOW_COLOR` (+ existing `MAX_ID_MASK_PALETTE_ENTRIES`,
  `MAX_ID_MASK_STROKE_WIDTH`).
- Types: `Detection`, `DetectionFrame`, `DetectionMask`,
  `CompressedRleDetectionMask`, `DecodedDetectionMask`, `Rect`,
  `BoxDrawInstruction`, `LabelDrawInstruction`, `MaskDrawInstruction`,
  `BoxStyle`, `LabelStyle`, `MaskStyle`, `BaseBoxStyleOptions`,
  `BaseLabelStyleOptions`, `BaseMaskStyleOptions`, `DetectionPickOptions`,
  `DetectionPickPoint`, `DetectionPickResult`, `DetectionClassColorStyle`,
  `IdMaskFrame`, `IdMaskInstruction`, `MediaFrameMetadata`,
  `PlatformMediaFrame`, `MediaRendererPresentation`.

Acceptance: `examples/react-native` imports nothing from
`supervision-js-core` directly; smoke test export list updated.

### CP2: One central color resolver (core, worklet-marked)

- Delete `REACT_NATIVE_ROBOFLOW_PALETTE` and
  `resolveReactNativeLiveColorForClass` (a hardcoded class switch — demo
  content that leaked into the package; the demo has its own copy and never
  imports the package version).
- Mark core's `resolveDetectionClassColorStyle`, `normalizeDetectionClassName`
  and the internal `hashClassName` with the `"worklet"` directive (inert on
  web/Node) and reorder helpers-first. RN worklets — including the demo's
  pump lanes — call `resolveDetectionClassColorStyle(className).fill`
  directly: the SAME function web runs, no mirror, no parity test.
- Demo deletes `DEMO_ROBOFLOW_PALETTE` + `resolveDemoClassColor` and delegates
  (`resolveDemoDetectionColor` keeps the `metadata.color` override).
- Guards: an identity test asserts the RN barrel re-exports core's function
  itself, and the smoke test asserts RN dist and core dist hand out the same
  function object.
- Behavior note: unknown classes move from index-based fallback to core's
  name-hash fallback — colors become stable per class name and identical to
  web. This is the desired cross-platform consistency.

### CP3: Library defaults move into the package

- `REACT_NATIVE_LIVE_ID_MASK_DEFAULTS = { maxPixels: 720*1280, maxSide: 1280 }`
  (named record, web-defaults style). `maxPixels`/`maxSide` become optional in
  `ReactNativeLiveIdMaskArtifactSizeOptions`, resolved against the record in
  both JS and native builder paths.
- Demo drops `LIVE_MASK_ARTIFACT_MAX_PIXELS`/`LIVE_MASK_ARTIFACT_MAX_SIDE`.
- Mosaic cell default (12) already lives in the package; the demo's 14 stays
  a demo choice.

### CP4: Verification

- `tools/package-smoke.test.mjs` export list updated (sorted, deepEqual).
- Parity test in `packages/react-native/src/index.test.ts`.
- Repo typecheck, lint, vitest green; demo compiles with single-entry imports.
- Device check (manual): live + video modes render with unchanged colors for
  known classes.

## Phase 2 — Promote proven demo machinery into the package

The Skia decision: the base entry stays Skia-free (artifact math only); a new
**`supervision-js-react-native/skia` subpath** owns everything that imports
`@shopify/react-native-skia`, which becomes an optional peer (same posture as
`react-native-nitro-modules` today).

**Status 2026-07-09:** the first three items landed (subpaths resolve via
package `exports` with a `react-native` condition mapping to `src`, which
Metro ≥ RN 0.79 handles natively; needs one device pass). The packet
lifecycle and runtime helper are deferred to Phase 3 — they are entangled
with reanimated/worklets peer ownership and belong to the session design.

- ✅ `createLiveSkiaMaskFrame` (demo) → `createReactNativeSkiaMaskFrame` on
  the `skia` subpath (artifact build → `Skia.Data`/`MakeImage` upload →
  uniforms, stage-tagged worklet-safe errors), plus
  `disposeReactNativeSkiaImage`. Unit-tested against a mocked Skia module.
- ✅ ExecuTorch orientation adapters (`unrotateExecutorchUpBbox`, the
  `maskRotatedCw` contract docs) → `adapters/executorch` subpath with its
  round-trip tests. Inference itself stays outside the library boundary (per
  `public-api.md`); these are coordinate-space adapters, not inference
  bindings.
- ✅ `createEmptyReactNativeLiveIdMaskUniforms()` on the base entry, pinned
  to the shader by a test that parses the uniform declarations — the
  "Missing uniform value" class of bugs is now guarded in the package.
- ⏭ Packet lifecycle object (present/retire/dispose, one-tick retirement,
  single-writer contract) → Phase 3, as part of the session facade.
- ⏭ Dedicated-runtime helper (`NativeThreadFactory` +
  `createWorkletRuntimeForThread`, with `destroy()`) → Phase 3.

## Phase 3 — Session facade (web parity)

**Status 2026-07-09:** the video half landed on a new
`supervision-js-react-native/sessions` subpath (pending device pass).
`createReactNativeVideoSession()` owns source open, the strict-sync pump,
mask prep, the present→retire→dispose packet lanes (reanimated `makeMutable`
internally), pause/resume/stop, and an idempotent callback-silencing
`destroy()`; inference is an injected `serializeFrame` worklet and effects an
injected `resolveMaskEffects` worklet. `createReactNativeWorkletRuntime()`
ships alongside (vendor modules lazy-required, optional peers: reanimated,
worklets, vision-camera-worklets). The demo's `VideoFileProof` now contains
no pipeline code. Remaining below.

- `createLiveSession()` (camera push) sharing the packet machinery with the
  video session; both instantiate core's `MediaSessionLifecycleState` /
  activity / status contracts the way web's `MediaSessionState` does;
  `*State` / `*Diagnostics` naming matches web.
- A thin `SyncedFrameStage`-style component (RN package may ship components —
  the "React stays out" rule in `public-api.md` is about the _web_ package).
- **Naming pass:** drop the `ReactNative*` prefix where a web-parity concept
  name exists (web exports `createMediaSession`, not `createWebMediaSession`;
  the package name is the namespace). Do this with the facade so renames
  happen once.
- Target: the RN demo shrinks toward what `examples/vanilla` is — mode
  switching, style choices, effect menus; no pipeline code.

## Phase 4 — Release hygiene

- Android story: JS mask builder already covers Android for rendering;
  `VideoFrameSource` and the native mask builder are iOS-only — either Kotlin
  impls or a documented platform-support matrix before release.
- Un-private, version, publish dry-run (`files` already includes
  `src`/`ios`/`nitrogen`); export-surface guard extended to the `skia` and
  `adapters` subpaths.
- Docs: update the React Native section of `docs/public/guides/public-api.md`
  from "experimental and private" to the released contract; refresh
  `react-native-architecture.md`.

## Decision log

- **2026-07-09:** Skia becomes an optional peer behind a subpath (mirrors
  web's Pixi-as-dependency commitment while keeping the artifact math
  importable anywhere).
- **2026-07-09:** No worklet mirrors of core logic. Small pure core helpers
  needed inside frame worklets get the `"worklet"` directive in core itself
  (inert on other platforms); worklet-captured _data_ must be derived from
  core, never copied. Supersedes a mirror-with-parity-tests approach tried
  earlier the same day.
- **2026-07-09:** A saved-video look-ahead buffer/presenter was tried and
  rolled back (felt worse than present-on-inference); do not fold pacing into
  the Phase 3 video session without a new product decision.
