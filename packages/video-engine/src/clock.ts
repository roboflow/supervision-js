/**
 * Media clock. Models playback time, NOT wall time. `now()` is frozen while
 * paused and advances at real-time rate while playing. This is the same
 * model the official mediabunny media-player example uses for its playback
 * loop (audioContext.currentTime - audioContextStartTime + playbackTimeAtStart).
 *
 * Engine never imports AudioContext directly. The default PerformanceMediaClock
 * is correct for muted scrubbing; an AudioContextMediaClock is the documented
 * seam for future audio-bearing consumers needing sample-accurate A/V sync.
 *
 * Lifecycle:
 *   - play(t?): captures t (default = current media time) as the anchor; from
 *               here `now()` advances at wall-clock rate.
 *   - pause():  freezes `now()` at its current value. Subsequent reads return
 *               that frozen value until play() or seek() runs.
 *   - seek(t):  sets the anchor to t. If currently playing, time continues to
 *               advance from t. If paused, `now()` returns t.
 *   - setRate(r): media seconds per wall second from here on. Only the slope
 *               changes; where the playhead is does not.
 */
export interface MediaClock {
  /** Current media time in seconds. Frozen while paused. */
  now(): number;
  /** Begin advancing from t (default: current value of now()). */
  play(t?: number): void;
  /** Freeze now() at its current value. */
  pause(): void;
  /** Jump to media time t. Subsequent play/pause behavior is preserved. */
  seek(t: number): void;
  /** True iff play() is in effect. */
  readonly playing: boolean;
  /** Media seconds per wall second. Forward only, so always above zero. */
  readonly rate: number;
  /**
   * Changes the slope from now on. Implementations re-anchor on the current
   * media time first, so the elapsed span already accrued keeps the rate it
   * was accrued at and the playhead does not jump.
   */
  setRate(rate: number): void;
}

/**
 * Default wall-clock-driven media clock. Uses performance.now() as the wall
 * source. Suitable for muted scrubbing where A/V sync is not a concern.
 */
export class PerformanceMediaClock implements MediaClock {
  private mediaTimeAtAnchor = 0;
  private wallTimeAtAnchorMs = 0;
  private _playing = false;
  private _rate = 1;

  get playing(): boolean {
    return this._playing;
  }

  get rate(): number {
    return this._rate;
  }

  now(): number {
    if (this._playing) {
      return (
        this.mediaTimeAtAnchor +
        ((performance.now() - this.wallTimeAtAnchorMs) / 1000) * this._rate
      );
    }
    return this.mediaTimeAtAnchor;
  }

  setRate(rate: number): void {
    this.mediaTimeAtAnchor = this.now();
    this.wallTimeAtAnchorMs = performance.now();
    this._rate = rate;
  }

  play(t?: number): void {
    if (t === undefined) {
      this.mediaTimeAtAnchor = this.now();
    } else {
      this.mediaTimeAtAnchor = t;
    }
    this.wallTimeAtAnchorMs = performance.now();
    this._playing = true;
  }

  pause(): void {
    if (this._playing) {
      this.mediaTimeAtAnchor = this.now();
      this._playing = false;
    }
  }

  seek(t: number): void {
    this.mediaTimeAtAnchor = t;
    this.wallTimeAtAnchorMs = performance.now();
  }
}

/**
 * Documented future implementation for audio-bearing consumers needing
 * sample-accurate A/V sync. NOT shipped. Kept as a TSDoc anchor so the
 * seam exists when an audio consumer wires up.
 *
 * @example
 *   const ctx = new AudioContext()
 *   const clock = new AudioContextMediaClock(ctx)
 *   const engine = new EngineCore({ emit, clock })
 */
export class AudioContextMediaClock implements MediaClock {
  private mediaTimeAtAnchor = 0;
  private ctxTimeAtAnchor = 0;
  private _playing = false;
  private _rate = 1;

  constructor(private readonly ctx: AudioContext) {
    this.ctxTimeAtAnchor = ctx.currentTime;
  }

  get playing(): boolean {
    return this._playing;
  }

  get rate(): number {
    return this._rate;
  }

  now(): number {
    if (this._playing) {
      return (
        this.mediaTimeAtAnchor +
        (this.ctx.currentTime - this.ctxTimeAtAnchor) * this._rate
      );
    }
    return this.mediaTimeAtAnchor;
  }

  setRate(rate: number): void {
    this.mediaTimeAtAnchor = this.now();
    this.ctxTimeAtAnchor = this.ctx.currentTime;
    this._rate = rate;
  }

  play(t?: number): void {
    if (t === undefined) {
      this.mediaTimeAtAnchor = this.now();
    } else {
      this.mediaTimeAtAnchor = t;
    }
    this.ctxTimeAtAnchor = this.ctx.currentTime;
    this._playing = true;
  }

  pause(): void {
    if (this._playing) {
      this.mediaTimeAtAnchor = this.now();
      this._playing = false;
    }
  }

  seek(t: number): void {
    this.mediaTimeAtAnchor = t;
    this.ctxTimeAtAnchor = this.ctx.currentTime;
  }
}
