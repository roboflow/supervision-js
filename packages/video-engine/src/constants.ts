/**
 * READ_AHEAD_CANVAS is the playback decode-ahead depth: how many decoded frames
 * the controller keeps queued ahead of the playhead so a decode that overruns a
 * frame interval does not starve the next tick (the cause of stutter even on
 * small, well-encoded clips, where playback otherwise pulls one frame per paint
 * with no cushion). Applies to canvas blits, which are independent and cheap to
 * hold; sample (zero-copy) frames pin a decoder slot each, so the controller
 * keeps those at a depth of one to spare the WebCodecs pool.
 *
 * REANCHOR_TICK_GAP_MS is the wall time between two playing render ticks past
 * which the play walk re-anchors at the playhead. Below it the backlog a tick
 * finds is worked off frame by frame; above it, the frames in between are ones
 * no loop was running to show, so the walk seeks past them.
 *
 * Wall time is the reading that separates the two cases. A tick 16ms after the
 * last one is a display doing its job however far a high rate moved the media
 * clock; a tick seconds after the last one is a loop nothing was driving.
 *
 * Half a second is where the two costs cross at 1x. A backlog costs one decode
 * per source frame in it, measured at 240 frames a second on the 30fps demo clip
 * (4.2ms each), against a keyframe-anchored seek at p95 47ms on the same clip:
 * half a second of 30fps backlog is 15 frames, so 63ms of decode against that
 * 47ms, and every higher rate puts more frames in the same gap. It also sits an
 * order of magnitude above the worst gap a foreground loop produces, which
 * leaves a long task or a GC pause to the frame-by-frame path.
 *
 * The present cadence is how often playback puts a frame on screen: the rate's
 * whole demand cut to the share of it the machine has been paying for, and never
 * under the source's own frame rate. At a full share the pump declines nothing,
 * which is where a machine with headroom stays at every rate.
 * A step moves the share by PRESENT_CADENCE_STEP, taking a quarter off it when
 * the pipeline has fallen behind the playhead and putting that same quarter back
 * when it has room to spare. The share bottoms out at one over
 * PLAYBACK_RATE.MAX, which is the deepest cut that means anything: below it even
 * the fastest rate asks for less than the source rate the cadence floors at.
 *
 * What takes the share down is a running bill, in frames, between what the clock
 * asked the pipeline for and what the play walk delivered. The bill accumulates
 * rather than being read per tick, which is what tells a shortfall from noise:
 * counting whole frames against a fractional demand leaves every tick out by up
 * to one either way and those cancel, while a machine that cannot sustain the
 * rate falls short every tick and adds up. Measured over 100ms windows on an M3
 * Max at rates 2x to 8x, a pipeline with headroom stayed inside 1.5 frames of
 * its demand either way, so a bill of PRESENT_CADENCE_EVIDENCE_FRAMES frames is
 * one it cannot run up.
 *
 * What puts the share back is the walk holding a frame the clock has not run
 * past, unbroken for the wall time the source takes to produce that many frames.
 * That is the only evidence a pipeline can offer that it has room to spare: a
 * machine at equilibrium delivers exactly what the clock asks for however much
 * headroom it has, so waiting for a surplus in the bill would leave every
 * machine at whatever its worst stretch measured. It is a live reading and the
 * bill is a cumulative one, which is why each takes one direction: ground lost
 * still reads lost once the walk is keeping up again, and catch-up pulls are
 * what carry the walk back onto the playhead.
 *
 * Neither reading is the depth of the decode-ahead queue, which belongs to the
 * decode path and not to the machine: on the zero-copy path, which pins a
 * decoder slot per queued frame and so buffers one, a single frame in hand is
 * full depth and one tick from empty alike.
 *
 * How far behind the machine is therefore sets the pace rather than the size of
 * the step: the bigger the shortfall the sooner the bill reaches that figure and
 * the sooner the next step lands. Zeroing on each step makes the next one gather
 * its own evidence, which is what stops a share sitting at the machine's limit
 * from pulsing.
 *
 * Frames the clock passed, frames the walk delivered and wall time on the
 * playhead: nothing either reading is made of knows what the panel refreshes at,
 * so one machine lands on one cadence on any panel. A faster panel offers more
 * slots and a machine with the headroom fills them; what it cannot do is hold
 * the pump above what the machine pays for, because the share comes down until
 * the pipeline is back on the playhead.
 *
 * PRESENT_CADENCE_SLACK is how far under the interval still counts as a full
 * one. Presents land on display ticks, so a panel refreshing at the ceiling
 * measures each gap as one interval give or take rAF jitter, and an exact
 * comparison would decline every second frame there. A quarter leaves 4.2ms of
 * jitter room at 60Hz.
 *
 * PRESENT_CADENCE_HZ is the demand above which frames the pump culled or
 * declined dominate the dropped-frame ledger, so the discarded-frames rule in
 * evaluateWarnings stands down rather than reading a count it cannot attribute.
 */
export const PLAYBACK = {
  READ_AHEAD_CANVAS: 3,
  PRESENT_CADENCE_EVIDENCE_FRAMES: 3,
  REANCHOR_TICK_GAP_MS: 500,
  PRESENT_CADENCE_STEP: 0.75,
  PRESENT_CADENCE_SLACK: 0.25,
  PRESENT_CADENCE_HZ: 60,
} as const;

/**
 * Forward playback-rate range the engine accepts. Reverse playback needs a
 * backwards decode strategy the runtime does not have, so zero and negative
 * rates are refused rather than approximated.
 *
 * MAX is an API bound, not a promise that every source plays smoothly there.
 * Sustaining rate r means decoding r x nativeFps frames a second, and the
 * decode-ahead cushion is fixed at PLAYBACK.READ_AHEAD_CANVAS frames (raising it
 * would outrun the CanvasSink pool and tear), so how high a given source really
 * goes is a property of that source's frame size and encode. The engine measures
 * it instead of guessing: DiagnosticsSnapshot carries the commanded rate beside
 * the presented one, and PLAYBACK_RATE_NOT_SUSTAINED fires when they diverge.
 * SUSTAINED_SHORTFALL is the share of the commanded rate the presented one has
 * to hold to count as sustained.
 */
export const PLAYBACK_RATE = {
  MIN: 0.25,
  MAX: 8,
  SUSTAINED_SHORTFALL: 0.8,
} as const;

/**
 * CanvasSink frame-pool size: how many decoded canvases the sink recycles
 * round-robin. The pool has no backpressure (a new decode overwrites the oldest
 * slot rather than blocking), and the playback queue hands the raw pool canvas
 * straight to the painter, so the pool must outnumber every canvas outstanding at
 * once: the full play read-ahead, the one in flight, and the one being painted.
 * Sized below that, a fresh decode stomps the pixels of a still-queued frame
 * before it paints (silent tearing). The cache is unaffected; it copies into its
 * own OffscreenCanvas. Derived from the read-ahead so the two cannot drift.
 */
export const SCRUB = {
  DEFAULT_POOL_SIZE: PLAYBACK.READ_AHEAD_CANVAS + 2,
} as const;

/**
 * Bounds on building a track's frame timeline, the presentation-order table of
 * every frame's timestamp in the container's own integer grain.
 *
 * MAX_FRAMES caps the metadata walk that builds it. A 70-second 30fps source
 * walks 2113 packets in a measured 5.7ms; the cap is four hundred times that,
 * which no ordinary file reaches and a fragmented or endless source does. Past
 * it the load fails, so nothing silently runs without frame identity.
 *
 * FALLBACK_TICK_RATE is for a track backing that cannot state its grain. A
 * microsecond is the finest timestamp WebCodecs carries, so no real timestamp is
 * lost at that rate; what is lost is the guarantee that every timestamp is a
 * whole tick.
 */
export const FRAME_TIMELINE = {
  MAX_FRAMES: 1_000_000,
  FALLBACK_TICK_RATE: 1e6,
} as const;

/**
 * Tiered frame-cache tunables. Both tiers hold OffscreenCanvas blits, never
 * VideoFrames: a raw-frame cache pins decoder output, stalling the decoder and
 * growing VRAM without bound. The exact tier holds crisp full-resolution frames
 * around the scrub playhead; the preview tier is the coarse downscaled history
 * that answers a scrub anywhere else instantly while a crisp decode lands.
 *
 * Only the exact tier's window is worth holding at full resolution. A crisp
 * frame the playhead has moved off is one re-anchored decode away: on the
 * session path that is a probe plus a walk from the enclosing sync sample,
 * measured at 49ms mean / 80ms worst on a 2840x2840 15fps source, flat in how
 * far the jump travelled. Coverage past the window is worth having, not worth
 * having crisp, so it lives in the preview tier at a 79th of the bytes.
 *
 * resolveCacheBudgets turns these into a per-source budget from
 * navigator.deviceMemory and the decode frame size. A crisp slot costs
 * decodeWidth x decodeHeight x 4 bytes, which spans two orders of magnitude
 * across sources: 0.9MB for a 640x360 decode, 32.3MB for a square 8MP native
 * decode. So a byte figure alone sets the slot count only for small frames. For
 * large ones any byte figure worth spending buys fewer slots than the access
 * pattern needs, and a slot floor sets the count with the bytes following from
 * it. The exact tier is therefore both: EXACT_BUDGET_BYTES_PER_GB times reported
 * RAM clamped to [MIN, MAX], raised to whatever MIN_EXACT_SLOTS costs at this
 * frame size.
 *
 * MIN_EXACT_SLOTS: the scrub prefetch window, a center frame plus
 * SCRUB_WINDOW_FRAMES each side. DecodeScheduler narrows its window to whatever
 * the exact tier holds, so this floor is what keeps an 8MP source at the full
 * window width, and slots past it would be speculative history the preview tier
 * already answers.
 *
 * PREVIEW_SLOTS_*: the preview slot count is its byte budget over the downscaled
 * frame size, clamped to this range. At a 79th of a crisp slot it carries the
 * timeline coverage an 8MP source cannot afford crisply: 163 slots against the
 * exact tier's 13, 11s of a 15fps clip.
 *
 * SKIP_NEAR_MS: cache lookups that resolve to a frame within this many
 * milliseconds of what the visible canvas already shows are rejected so the
 * consumer falls through to a full-res decode. Keeps a frame-step gesture from
 * snapping back to the already-painted neighbor. Fixed in ms, so it spans one
 * frame at 15fps and three at 30fps.
 *
 * DEFAULT_BUCKET_MS: timestamp-bucket size when the source frame rate is
 * unknown. Finer than the frame interval at any rate up to 30fps, so distinct
 * frames never collapse onto one slot.
 *
 * DEFAULT_DEVICE_MEMORY_GB: the RAM assumed for every browser that reports
 * none, which is all of them outside Chromium and any page off a secure
 * context. It is a guess, and the byte clamps above are what bound a wrong
 * one: at 8 the exact tier sits on its ceiling and the preview tier at two
 * thirds of its own.
 */
export const FRAME_CACHE = {
  PREVIEW_WIDTH_PX: 320,
  SKIP_NEAR_MS: 100,
  DEFAULT_BUCKET_MS: 33,
  MIN_EXACT_SLOTS: 13,
  DEFAULT_DEVICE_MEMORY_GB: 8,
  EXACT_BUDGET_BYTES_PER_GB: 24 * 1024 * 1024,
  EXACT_BUDGET_BYTES_MIN: 64 * 1024 * 1024,
  EXACT_BUDGET_BYTES_MAX: 128 * 1024 * 1024,
  PREVIEW_BUDGET_BYTES_PER_GB: 8 * 1024 * 1024,
  PREVIEW_BUDGET_BYTES_MIN: 24 * 1024 * 1024,
  PREVIEW_BUDGET_BYTES_MAX: 96 * 1024 * 1024,
  PREVIEW_SLOTS_MIN: 48,
  PREVIEW_SLOTS_MAX: 512,
} as const;

/**
 * Diagnostics instrument tunables. Inert unless a consumer opts in: the worker
 * broadcasts a snapshot at BROADCAST_HZ only while subscribed, the trace rings
 * allocate only while armed, and SCRUB_LATENCY_RING bounds the percentile sample.
 */
export const DIAGNOSTICS = {
  BROADCAST_HZ: 10,
  TRACE_EVENT_CAP: 2000,
  TRACE_SNAPSHOT_CAP: 600,
  SCRUB_LATENCY_RING: 64,
} as const;

/**
 * What an armed capture actually keeps. The snapshot ring is fed at the fixed
 * broadcast rate, so its capacity converts to a wall-clock window; the event
 * ring is fed by paints and gestures at no fixed rate, so its bound is a count
 * and nothing more. A readout that states one number for "the capture" is
 * describing neither ring.
 */
export const TRACE_RING_BOUNDS = {
  snapshotWindowMs:
    (DIAGNOSTICS.TRACE_SNAPSHOT_CAP / DIAGNOSTICS.BROADCAST_HZ) * 1000,
  snapshotCap: DIAGNOSTICS.TRACE_SNAPSHOT_CAP,
  eventCap: DIAGNOSTICS.TRACE_EVENT_CAP,
} as const;

/**
 * Hang-recovery bounds for the worker video runtime. mediabunny's getCanvas/
 * getSample take no AbortSignal, so a decode that never settles cannot be
 * cancelled. These two timeouts bound the damage: a decode that outruns its
 * ceiling is abandoned and its provider rebuilt, and a main-thread caller
 * blocked on a wedged worker surfaces an error.
 *
 * DECODE_HANG_TIMEOUT_MS bounds a random-access decode operation, not a single
 * frame. A seek or a play-start lands mid-GOP and decodes the whole
 * keyframe-to-target prefix, so an 8-second GOP of 8MP frames legitimately runs
 * tens of seconds. A ceiling sized for one frame fires on healthy progress and
 * kills the decode it exists to protect.
 *
 * SEED_HANG_TIMEOUT_MS bounds the first-frame seed alone, which is why it is a
 * fraction of the figure above: the seed anchors on the track's own first
 * sample, so it walks no GOP prefix, and the one cost it carries that a later
 * decode does not is the decoder's cold hardware configuration. A re-anchored
 * decode of a 2840x2840 source measured 49ms mean / 80ms worst, so this leaves
 * two orders of magnitude of headroom over the decode plus its cold start, and
 * SEED_DECODE_ATTEMPTS of it still finish inside WORKER_COMMAND_TIMEOUT_MS with
 * the rebuilds between them. That is what lets a decoder which never starts
 * reach the caller as an error rather than as the facade giving up.
 *
 * That budget is the mediabunny sink paths', which carry no ceiling of their
 * own. The long-lived decode session bounds its own wait for output more
 * tightly and can tell a decoder that never started from one that went quiet
 * after working, so on that path the seed ends on the session's word and these
 * attempts go unspent.
 *
 * WORKER_COMMAND_TIMEOUT_MS is the main-thread backstop for an awaitable command
 * (load, commit, step). It derives from the decode ceiling so the two cannot
 * drift: the worker has to be able to reach its own hang path, recover, and
 * reply before the facade gives up on it.
 */
const DECODE_HANG_TIMEOUT_MS = 30_000;

export const HANG_RECOVERY = {
  DECODE_HANG_TIMEOUT_MS,
  SEED_HANG_TIMEOUT_MS: 8_000,
  SEED_DECODE_ATTEMPTS: 3,
  WORKER_COMMAND_TIMEOUT_MS: DECODE_HANG_TIMEOUT_MS + 15_000,
} as const;
