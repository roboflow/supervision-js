# Library Contract Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strengthen `supervision-js` as a clean library by making `MediaSession` the primary contract and hardening the media, detection, render-preparation, state, and interaction boundaries.

**Architecture:** Keep one media item mapped to one `MediaSession`. The session wires default Mediabunny and Pixi implementations at the edge while exposing renderer-neutral media, detection, presentation, state, and interaction contracts. Internally, detections flow from cold storage to a hot window, then to prepared render artifacts, then to the active renderer frame.

**Tech Stack:** TypeScript, Mediabunny, PixiJS v8, IndexedDB-backed browser storage, Web Workers, Vitest, Rollup.

---

## File Structure

- `docs/internal/library-contract.md`: internal contract for the package surface.
- `docs/internal/agent-guidance.md`: points agents at the contract doc.
- `src/types/media-session.ts`: public session options, state, and methods.
- `src/sessions/media-session.ts`: session orchestration and state subscription.
- `src/sessions/media-session-state.ts`: aggregate state derivation.
- `src/sessions/media-session-defaults.ts`: sensible file/stream defaults.
- `src/sessions/media-session-detections.ts`: detection source/store wiring.
- `src/types/detections.ts`: minimal detection data model.
- `src/types/detection-timeline.ts`: source, buffer, retention, and playback gate contracts.
- `src/types/render-preparation.ts`: public diagnostics/configuration for prepared artifacts.
- `src/render-preparation/*`: internal worker and prepared-artifact pipeline.
- `src/renderers/*`: renderer-neutral orchestration and Pixi implementation layers.
- `src/interactions/*`: interaction and picking contracts.
- `src/index.ts`: minimal package boundary.

## Checkpoints

Each checkpoint should end with focused tests passing and the demo still building.
Stop after each checkpoint for manual demo testing.

### Checkpoint 1: Stabilize `MediaSession` As The Primary Primitive

**Files:**

- Modify: `src/types/media-session.ts`
- Modify: `src/sessions/media-session.ts`
- Modify: `src/sessions/media-session.test.ts`
- Modify: `docs/internal/agent-guidance.md`

- [ ] Add `MediaSessionStateListener` and `MediaSessionStateUnsubscribe` types.
- [ ] Add `session.subscribe(listener)` to emit the current state immediately and on future state changes.
- [ ] Keep `onState` as creation-time sugar, but route it through the same listener mechanism.
- [ ] Ensure `destroy()` emits the destroyed state exactly once and clears subscribers.
- [ ] Test subscription, unsubscribe, immediate state emission, and destroyed-state emission.
- [ ] Run `npm run test -- src/sessions/media-session.test.ts src/sessions/media-session-state.test.ts`.
- [ ] Run `npm run typecheck`.

### Checkpoint 2: Tighten The Public Detection Model

**Files:**

- Modify: `src/types/detections.ts`
- Modify: `src/types/detection-timeline.ts`
- Modify: `src/index.ts`
- Modify tests under `src/detections/` and `src/utils/detection-frames.test.ts`

- [ ] Document which detection fields are semantic input versus render styling.
- [ ] Keep styling out of `Detection`; style belongs to presentation style classes.
- [ ] Preserve RLE mask support as cold semantic data.
- [ ] Add tests that detection frames can be selected by frame index and media time without mutating inputs.
- [ ] Run `npm run test -- src/detections src/utils/detection-frames.test.ts`.
- [ ] Run `npm run typecheck`.

### Checkpoint 3: Clean Detection Ingestion And Retention

**Files:**

- Modify: `src/sessions/media-session-detections.ts`
- Modify: `src/detections/writable-detection-frame-source.ts`
- Modify: `src/detections/browser-cold-detection-frame-store.ts`
- Modify: `src/detections/memory-cold-detection-frame-store.ts`
- Modify: `src/types/detection-timeline.ts`

- [ ] Make static, chunked, source-owned, and writable detection modes explicit.
- [ ] Keep `appendable` and `writable` aliases compatible while preferring one canonical path internally.
- [ ] Confirm stream retention modes: persist all, persist window, memory-only.
- [ ] Ensure appending detections outside the current hot window does not reload the current window.
- [ ] Test retention behavior and range-version updates.
- [ ] Run `npm run test -- src/detections src/sessions/media-session.test.ts`.
- [ ] Run `npm run typecheck`.

### Checkpoint 4: Formalize Cold, Hot, Prepared, Active Pipeline

**Files:**

- Modify: `src/render-preparation/prepared-render-window.ts`
- Modify: `src/render-preparation/prepared-window-timeline.ts`
- Modify: `src/types/render-preparation.ts`
- Modify: `src/renderers/media-renderer-core.ts`
- Modify: `src/renderers/media-renderer-state.ts`

- [ ] Keep generic artifact diagnostics by artifact kind, not mask-only names.
- [ ] Ensure prepared windows use continuous refill, low-water/high-water behavior, and loop-aware retention.
- [ ] Keep active-frame render preparation separate from background preparation.
- [ ] Ensure prepared artifact cleanup closes image resources and destroys Pixi textures.
- [ ] Run `npm run test -- src/render-preparation src/renderers/media-renderer-core.test.ts`.
- [ ] Run `npm run typecheck`.

### Checkpoint 5: Harden Worker-Backed Mask Preparation

**Files:**

- Modify: `src/workers/worker-rpc-client.ts`
- Modify: `src/render-preparation/mask-frame-preparer.ts`
- Modify: `src/render-preparation/mask-preparation-worker-count.ts`
- Modify: `src/render-preparation/mask-frame-compositor.ts`
- Modify: `src/renderers/pixi-mask-layer.ts`
- Modify: `src/renderers/pixi-id-mask-shader.ts`

- [x] Keep worker pool defaults bounded and explainable.
- [x] Keep active-frame jobs prioritized over background prefetch.
- [x] Keep PNG ID-mask path as the preferred artifact and RGBA as fallback.
- [x] Make style changes avoid unnecessary worker rebuilds when the ID-mask shader can handle them.
- [x] Add tests around worker fallback, cancellation, destroyed worker clients, and artifact closure.
- [x] Run focused worker/render-preparation tests.
- [x] Run `npm run benchmark:masks:gpu:build`.

### Checkpoint 6: Define Renderer Layer Contracts

**Files:**

- Modify: `src/renderers/media-renderer-scene.ts`
- Modify: `src/renderers/pixi-media-scene.ts`
- Modify: `src/renderers/pixi-box-layer.ts`
- Modify: `src/renderers/pixi-mask-layer.ts`
- Modify: `src/renderers/pixi-label-layer.ts`
- Modify: `src/types/media-renderer.ts`

- [x] Keep media, box, mask, label, and interaction layers separately testable.
- [x] Keep Pixi types out of public renderer options.
- [x] Ensure presentation updates route through layer contracts instead of direct Pixi access.
- [x] Run focused renderer tests and `npm run typecheck`.

### Checkpoint 7: Promote Interaction And Picking To Library Feature

**Files:**

- Modify: `src/types/interaction.ts`
- Modify: `src/interactions/detection-picker.ts`
- Modify: `src/renderers/pixi-interaction-layer.ts`
- Modify: `src/renderers/pixi-mask-layer.ts`
- Modify: `src/renderers/pixi-box-layer.ts`

- [ ] Keep picking synchronized to active media frame and detection frame.
- [ ] Support mask and box targets with clear priority.
- [ ] Support paused-only interaction mode.
- [ ] Return detection, detection index, frame, media time, point, and target.
- [ ] Run `npm run test -- src/interactions src/renderers/pixi-interaction-layer.test.ts`.
- [ ] Run `npm run typecheck`.

### Checkpoint 8: Make Loading And Processing State Ergonomic

**Files:**

- Modify: `src/types/media-session.ts`
- Modify: `src/sessions/media-session-state.ts`
- Modify: `src/sessions/media-session-state.test.ts`

- [ ] Keep `MediaSessionState.activities` as the canonical high-level state list.
- [ ] Mark activities that block playback separately from activities that block presentation.
- [ ] Ensure background normalization and background render prep are not reported as active blocking overlays.
- [ ] Add tests for media opening, normalization, detection loading, playback buffering, render preparation, errors, and destroyed state.
- [ ] Run `npm run test -- src/sessions/media-session-state.test.ts`.
- [ ] Run `npm run typecheck`.

### Checkpoint 9: Add Sync Regression Coverage

**Files:**

- Modify: `src/utils/detection-frames.test.ts`
- Modify: `src/detections/buffered-detection-timeline.test.ts`
- Modify: `src/playback/media-playback-controller.ts`
- Modify: `src/renderers/media-renderer-core.test.ts`

- [ ] Test frame-index selection on a 30fps grid.
- [ ] Test timestamp selection for interval frames.
- [ ] Test one-frame gaps.
- [ ] Test seek, pause, loop, and missing frames.
- [ ] Test normalized media timing does not drift from detection timing.
- [ ] Run the focused tests and `npm run typecheck`.

### Checkpoint 10: Keep Benchmarks Decision-Oriented

**Files:**

- Modify: `benchmark/masks/findings.md`
- Modify: `benchmark/masks/findings.csv`
- Modify: `benchmark/masks/run.mjs`
- Modify: `benchmark/masks/run-gpu.mjs`

- [ ] Keep benchmark tables focused on RLE preparation cost, prepared artifact size, worker throughput, frame timing, and hot-window memory.
- [ ] Add notes that RLE is semantic cold storage and PNG ID-mask is runtime representation.
- [ ] Keep commands reproducible from the repo root.
- [ ] Run `npm run benchmark:masks` and `npm run benchmark:masks:gpu:build`.

## Done

This plan is complete when the package has a small, coherent session-first
contract, detection ingestion and render preparation are internally clean, sync
has regression coverage, and benchmark docs can explain the architecture with
numbers.
