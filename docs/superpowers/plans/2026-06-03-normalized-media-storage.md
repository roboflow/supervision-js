# Normalized Media Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan checkpoint-by-checkpoint. Stop after each checkpoint for demo testing.

**Goal:** Make progressive media normalization safe for long videos and stream-like sources by separating normalized encoded media bytes from in-memory playback caches.

**Why now:** Detection storage already has cold, hot, prepared, and active layers. Media normalization does not. `normalizeMediaProgressively()` currently streams normalized WebM bytes to the renderer, but it also stores every output chunk in memory for the final `Blob` and gives `ReadableStreamSource` a 512 MiB cache. That is acceptable for short demos, but it can grow badly for 1 hour videos.

**Architecture:** Treat normalized media as encoded byte chunks, not decoded frames. Mediabunny writes normalized WebM bytes; supervision-js stores those bytes according to a retention policy; the renderer reads from a bounded source. Decoded video frames remain transient and owned by playback.

---

## Current State

- `src/media/media-normalization.ts` uses `AppendOnlyStreamTarget` with WebM `appendOnly: true`.
- The progressive path copies each output chunk, writes it into a `TransformStream`, and pushes it into an unbounded `chunks[]` array.
- `completion` builds a final `Blob` from all accumulated chunks.
- The renderer source is a Mediabunny `ReadableStreamSource` with `maxCacheSize: 512 * 2 ** 20`.
- `ReadableStreamSource` is forward-stream friendly but weak for long random-access and seeking unless its cache grows.
- Mediabunny also exposes `StreamSource`, which can read byte ranges from a custom store with a much smaller cache.

## Non-Goals

- Do not persist decoded frames.
- Do not invent a full media CDN/cache abstraction.
- Do not promise browser support for arbitrary codecs beyond Mediabunny/browser capabilities.
- Do not make normalized media retention public until the internal policy is proven.

## Proposed Concepts

### Normalized Media Byte Store

Internal append/read/clear contract for encoded normalized bytes:

- append monotonic byte chunks from Mediabunny output.
- expose bytes written and completion status.
- read byte ranges for Mediabunny `StreamSource`.
- optionally evict old chunks for stream mode.
- destroy all owned resources.

### Retention Modes

Mirror detection retention at the session level, with media-specific caveats:

- `memoryOnly`: bounded memory queue; useful for short media and tests.
- `persistAll`: write all normalized bytes to browser storage; default for file mode.
- `persistWindow`: keep only the latest window; default candidate for stream mode.

For video files, `persistAll` is the safest default because seeking and replay need earlier bytes. For livestreams, `persistWindow` is reasonable because the source is naturally forward-moving.

### Storage Backends

- Start with an internal memory store for tests.
- Add browser persistent storage next:
  - Prefer OPFS/File System Access when available for large byte streams.
  - Fall back to IndexedDB chunk records when OPFS is unavailable.
- Keep the backend hidden behind the byte-store contract.

## Checkpoints

### Checkpoint 1: Stop The Immediate RAM Blowup

**Files:**

- Modify: `src/media/media-normalization.ts`
- Modify: `src/types/media-normalization.ts`
- Modify: `src/media/media-normalization.test.ts`

- [ ] Add an internal/default option that controls whether progressive normalization keeps a final completion `Blob`.
- [ ] Default streamed session normalization to not keep an unbounded final `Blob` unless explicitly requested.
- [ ] Lower the progressive `ReadableStreamSource` cache from 512 MiB to a documented bounded default.
- [ ] Keep output progress reporting byte-based.
- [ ] Add tests that progressive normalization does not accumulate chunks when final blob retention is disabled.
- [ ] Run `npm run test -- src/media/media-normalization.test.ts`.
- [ ] Run `npm run typecheck`.

### Checkpoint 2: Introduce A Normalized Byte Store Contract

**Files:**

- Add: `src/media/normalized-media-byte-store.ts`
- Add: `src/media/memory-normalized-media-byte-store.ts`
- Modify: `src/media/media-normalization.ts`
- Modify: `src/types/media-normalization.ts`

- [ ] Define the internal byte-store contract.
- [ ] Implement a memory-backed store with bounded diagnostics.
- [ ] Route progressive output through the byte-store contract before forwarding bytes to the renderer stream.
- [ ] Keep byte-store ownership and cleanup tied to `ProgressiveNormalizedMedia.cancel()` / session destroy.
- [ ] Test append, range read, completion, and destroy behavior.
- [ ] Run focused media tests and `npm run typecheck`.

### Checkpoint 3: Add Persistent Browser Storage

**Files:**

- Add: `src/media/browser-normalized-media-byte-store.ts`
- Modify: `src/sessions/media-session-media.ts`
- Modify: `src/sessions/media-session-defaults.ts`
- Modify: `src/types/media-session.ts`

- [ ] Add a session-level normalized-media retention policy.
- [ ] Default file mode to `persistAll`.
- [ ] Default stream mode to `persistWindow`.
- [ ] Prefer OPFS for large normalized byte streams when available.
- [ ] Fall back to IndexedDB chunk storage.
- [ ] Surface storage diagnostics: bytes written, retained bytes, retention mode, backend kind.
- [ ] Test file defaults, stream defaults, and cleanup.

### Checkpoint 4: Use A Seekable Stored Source For Long Media

**Files:**

- Add: `src/media/stored-normalized-media-source.ts`
- Modify: `src/media/mediabunny-media-source.ts`
- Modify: `src/media/media-normalization.ts`

- [ ] Build a Mediabunny `StreamSource` backed by the normalized byte store.
- [ ] Allow reads for already-written ranges.
- [ ] Wait or fail clearly for ranges that are not available yet.
- [ ] Keep a small Mediabunny read cache because byte-range reads come from storage.
- [ ] Verify seeking/replay does not require a giant `ReadableStreamSource` cache.
- [ ] Add sync/seek tests for progressive normalization using stored bytes.

### Checkpoint 5: Unify Session State And Demo Signals

**Files:**

- Modify: `src/types/media-session.ts`
- Modify: `src/sessions/media-session-state.ts`
- Modify: demo state mapping only as needed

- [ ] Add media storage activity/diagnostics without making background normalization look playback-blocking.
- [ ] Report normalized byte ranges separately from detection and prepared-artifact ranges.
- [ ] Keep playback gates based on active need: source frame availability, detection availability, and prepared render artifact availability.
- [ ] Confirm a long uploaded video can normalize, infer, store detections, and render without unbounded memory growth.

## Key Decisions

- Store normalized encoded bytes, not decoded frames.
- Keep detection cold storage and normalized media storage as separate systems with similar policy language.
- Use `ReadableStreamSource` only as a short-path/forward-stream source.
- Use `StreamSource` backed by stored bytes for long-file seek/replay behavior.
- Do not expose all storage knobs publicly until the internal behavior is proven in the demo and tests.

## Done

This plan is complete when a long uploaded video can normalize progressively without retaining the whole output in RAM, while still supporting replay/seek for file mode and bounded retention for stream mode.
