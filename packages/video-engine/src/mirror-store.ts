import type { FrameId, FrameLanding } from "./frame-timeline";
import {
  asPaintSeq,
  type EngineChannel,
  type PaintSeq,
  type PlaybackState,
  PlaybackStatus,
} from "./types";

/**
 * Tiny external store powering useSyncExternalStore subscriptions. Five
 * emit channels by mutation cadence:
 *
 *   - time: emits when the playhead moves to a different frame. Consumers
 *           wanting a slower rerender cadence apply their own selector.
 *   - frame: emits on every settled cursor-yielded frame, for marker rails.
 *   - state: status transitions only. Rare. Driven by load, play, pause,
 *            seek, end, error.
 *   - duration: emits once per loaded source.
 *   - seeking: emits when the cursor transitions in/out of an in-flight
 *              scrub. Powers an opt-in scrub-in-flight indicator. Cache-hit
 *              scrubs typically don't trip this because the cache paint is
 *              synchronous, so the engine writes true only when the cursor
 *              is actually doing a decode walk.
 *   - rate:    emits on a playback-rate change. Rarest channel of the six.
 *
 * Channels are separate so a status-only consumer does not wake up at
 * 60Hz when only time advances.
 */
export class MirrorStore {
  private playhead: FrameLanding = {
    frame: { index: 0, ticks: 0 },
    mediaTimeS: 0,
  };
  private paintSeq: PaintSeq = asPaintSeq(0);
  private durationMs = 0;
  private status: PlaybackStatus = PlaybackStatus.Idle;
  private error: PlaybackState["error"] = null;
  private seeking = false;
  private rate = 1;
  // Cached so getPlaybackState returns a stable reference between state
  // emits. Selectors using Object.is can short-circuit without the caller
  // having to thread a custom equality fn.
  private playbackStateSnapshot: PlaybackState = {
    status: PlaybackStatus.Idle,
    error: null,
  };

  private readonly channelListeners: Record<EngineChannel, Set<() => void>> = {
    time: new Set(),
    frame: new Set(),
    state: new Set(),
    duration: new Set(),
    seeking: new Set(),
    rate: new Set(),
  };

  getPlayhead(): FrameLanding {
    return this.playhead;
  }
  getDurationMs(): number {
    return this.durationMs;
  }
  getStatus(): PlaybackStatus {
    return this.status;
  }
  getError(): PlaybackState["error"] {
    return this.error;
  }
  getPaintSeq(): PaintSeq {
    return this.paintSeq;
  }
  getPlaybackState(): PlaybackState {
    return this.playbackStateSnapshot;
  }
  getSeeking(): boolean {
    return this.seeking;
  }
  getRate(): number {
    return this.rate;
  }

  /**
   * Moves the playhead onto a frame. Ticks are integers, so the same frame
   * arriving twice is recognised as the same frame and wakes nobody; the
   * millisecond plane this replaced could not tell two positions apart at all,
   * and emitted on every paint.
   */
  writePlayhead(frame: FrameId, mediaTimeS: number): void {
    if (this.playhead.frame.ticks === frame.ticks) return;
    this.playhead = { frame, mediaTimeS };
    this.emit("time");
  }

  writePaintSeq(value: PaintSeq): void {
    if (value === this.paintSeq) return;
    this.paintSeq = value;
    this.emit("frame");
  }

  writeDurationMs(value: number): void {
    if (value === this.durationMs) return;
    this.durationMs = value;
    this.emit("duration");
  }

  writeStatus(
    status: PlaybackStatus,
    error: PlaybackState["error"] = null,
  ): void {
    if (status === this.status && error === this.error) return;
    this.status = status;
    this.error = error;
    this.playbackStateSnapshot = { status, error };
    this.emit("state");
  }

  writeSeeking(isSeeking: boolean): void {
    if (isSeeking === this.seeking) return;
    this.seeking = isSeeking;
    this.emit("seeking");
  }

  writeRate(value: number): void {
    if (value === this.rate) return;
    this.rate = value;
    this.emit("rate");
  }

  subscribe(channel: EngineChannel, listener: () => void): () => void {
    this.channelListeners[channel].add(listener);
    return () => {
      this.channelListeners[channel].delete(listener);
    };
  }

  private emit(channel: EngineChannel): void {
    for (const l of this.channelListeners[channel]) l();
  }
}
