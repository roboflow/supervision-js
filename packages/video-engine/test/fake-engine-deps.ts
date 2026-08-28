import type { MediaClock } from "../src/clock";
import { type FrameId, FrameTimeline } from "../src/frame-timeline";
import {
  ScrubCursorState,
  type FrameQuality,
  type ScrubCursor,
  type ScrubFrame,
  type ScrubFrameListener,
  type VideoSampleLike,
} from "../src/scrub-cursor";
import { asSec, type Sec, SourceKind } from "../src/types";
import type { EngineLoadConfig } from "../src/worker-protocol";

/**
 * Records every interaction the runtime makes with a VideoSample: how many times
 * it was closed, drawn, and converted to a VideoFrame. The close-discipline
 * tests assert against these counts. close() is NOT made idempotent here; the
 * runtime wraps raw samples in idempotentSample, so a fake that counts every
 * raw close call exposes a missing wrap.
 */
export class FakeVideoSample implements VideoSampleLike {
  closeCount = 0;
  drawCount = 0;
  toVideoFrameCount = 0;
  readonly drawArgs: Array<[number, number, number?, number?]> = [];

  constructor(
    readonly timestamp: number = 0,
    readonly duration: number = 0,
  ) {}

  toVideoFrame(): VideoFrame {
    this.toVideoFrameCount += 1;
    // The fake renderer never touches the returned frame's pixels; it only
    // needs an object identity to assert the import/copy call received it.
    return { close: (): void => undefined } as unknown as VideoFrame;
  }

  draw(
    _ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    dx: number,
    dy: number,
    dWidth?: number,
    dHeight?: number,
  ): void {
    this.drawCount += 1;
    this.drawArgs.push([dx, dy, dWidth, dHeight]);
  }

  close(): void {
    this.closeCount += 1;
  }
}

/**
 * Shared test doubles for the engine seam. The cursor and clock are the two
 * collaborators every engine-side suite injects (EngineCore directly, the
 * worker dispatcher and the facade through a real EngineCore behind a fake
 * port), so they live in one place rather than being re-stubbed per file.
 */

/** Deterministic media clock: time only moves when a test moves it. */
export class FakeClock implements MediaClock {
  private t = 0;
  private _playing = false;
  private _rate = 1;
  now(): number {
    return this.t;
  }
  play(t?: number): void {
    if (t !== undefined) this.t = t;
    this._playing = true;
  }
  pause(): void {
    this._playing = false;
  }
  seek(t: number): void {
    this.t = t;
  }
  get playing(): boolean {
    return this._playing;
  }
  get rate(): number {
    return this._rate;
  }
  setRate(rate: number): void {
    this._rate = rate;
  }
}

export interface FakeCursor extends Omit<ScrubCursor, "state"> {
  state: ScrubCursorState;
  seekToCalls: Sec[];
  seekToKeyCalls: Sec[];
  attachPlayCalls: number;
  detachPlayCalls: number;
  closed: boolean;
  /** Echoed by seekToFrame when set; otherwise the fake answers with the frame
   *  the table names, which is what a real decode does. */
  seekToFrameResult: ScrubFrame | null;
  /** Every frame seekToFrame was asked for, in order. */
  seekToFrameCalls: FrameId[];
  nextCalls: number;
  /** Stands in for pullForwardOne, which emits synchronously inside the pull.
   *  A fake whose next() only records the call cannot observe the refill chain
   *  that builds the play queue. */
  onNext: (() => void) | null;
  emit(timestampS: Sec, quality?: FrameQuality): void;
}

export function makeScrubFrame(
  timestampS: number,
  quality: FrameQuality = "exact",
): ScrubFrame {
  return {
    kind: "canvas",
    timestampS: asSec(timestampS),
    source: {} as OffscreenCanvas,
    width: 1280,
    height: 720,
    isKeyFrame: false,
    quality,
  };
}

export function makeFakeCursor(): FakeCursor {
  let listener: ScrubFrameListener | null = null;
  const cursor: FakeCursor = {
    state: ScrubCursorState.Idle,
    track: {
      width: 1280,
      height: 720,
      decodeWidth: 1280,
      decodeHeight: 720,
      nativeFps: 30,
      durationS: asSec(10),
      firstTimestampS: asSec(0),
      timeline: FrameTimeline.uniform(30, 1000),
    },
    isIdle: true,
    seekToCalls: [],
    seekToKeyCalls: [],
    attachPlayCalls: 0,
    detachPlayCalls: 0,
    closed: false,
    seekToFrameResult: null,
    seekToFrameCalls: [],
    nextCalls: 0,
    onNext: null,
    async open(): Promise<void> {},
    seekTo(t: Sec): void {
      cursor.seekToCalls.push(t);
    },
    seekToKey(t: Sec): void {
      cursor.seekToKeyCalls.push(t);
    },
    next(): void {
      cursor.nextCalls++;
      cursor.onNext?.();
    },
    attachPlay(): void {
      cursor.attachPlayCalls++;
    },
    detachPlay(): void {
      cursor.detachPlayCalls++;
    },
    async seekToFrame(frame: FrameId): Promise<ScrubFrame | null> {
      cursor.seekToFrameCalls.push(frame);
      return (
        cursor.seekToFrameResult ??
        makeScrubFrame(cursor.track.timeline.timeAt(frame.index))
      );
    },
    async idle(): Promise<void> {},
    async seekSettled(): Promise<void> {},
    subscribe(l: ScrubFrameListener): () => void {
      listener = l;
      return (): void => {
        listener = null;
      };
    },
    peekCached(): ScrubFrame | null {
      return null;
    },
    async close(): Promise<void> {
      cursor.closed = true;
    },
    emit(timestampS: Sec, quality?: FrameQuality): void {
      listener?.(makeScrubFrame(timestampS, quality));
    },
  };
  return cursor;
}

export class FakeOffscreenCanvas {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  getContext(): {
    drawImage: () => void;
    clearRect: () => void;
    canvas: FakeOffscreenCanvas;
  } {
    return {
      drawImage: (): void => undefined,
      clearRect: (): void => undefined,
      canvas: this,
    };
  }
}

/**
 * Installs the worker-realm globals the engine touches under a node test env:
 * OffscreenCanvas (ring + sink) and a setTimeout-backed rAF (the render loop).
 */
export function installWorkerGlobals(): void {
  (globalThis as { OffscreenCanvas?: typeof OffscreenCanvas }).OffscreenCanvas =
    FakeOffscreenCanvas as unknown as typeof OffscreenCanvas;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number =>
    setTimeout(
      () => cb(0),
      0,
    ) as unknown as number) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((handle: number): void => {
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  }) as typeof cancelAnimationFrame;
}

export const LOAD_CONFIG: EngineLoadConfig = {
  source: { kind: SourceKind.Url, url: "https://example.test/video.mp4" },
};

/**
 * Writes a property the cursor interface declares readonly. Both callers patch a
 * double they just made, so there is nothing to restore afterwards.
 */
export function replaceProperty<T, K extends keyof T>(
  target: T,
  key: K,
  value: T[K],
): void {
  (target as { -readonly [P in K]: T[P] })[key] = value;
}
