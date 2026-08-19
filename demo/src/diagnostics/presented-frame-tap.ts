import type {
  FrameQuality,
  PresentedFrame,
  PresentedFrameHandler,
} from "@roboflow/video-engine";
import type { MediaRendererSource } from "supervision";

const DEFAULT_RING_CAPACITY = 300;
const RATE_WINDOW_MS = 1000;
const MILLISECONDS_PER_SECOND = 1000;

export interface PresentedFrameRecord {
  readonly mediaTimeMs: number;
  readonly quality: FrameQuality;
  readonly wallTimeMs: number;
}

export interface PresentedFrameTapSnapshot {
  readonly lastPresented: PresentedFrameRecord | null;
  readonly presentedCount: number;
  readonly presentedPerSecond: number | null;
  readonly records: readonly PresentedFrameRecord[];
}

export interface PresentedFrameTap {
  read(): PresentedFrameTapSnapshot;
  reset(): void;
  tap(source: MediaRendererSource): MediaRendererSource;
}

export interface PresentedFrameTapOptions {
  readonly capacity?: number;
  readonly now?: () => number;
}

interface PresentedFrameProducer {
  onPresentedFrame(handler: PresentedFrameHandler): void;
}

/**
 * Frames presented in the trailing window, as a per-second rate. Null when the
 * window holds none: a zero would read as a producer presenting at zero frames
 * per second.
 */
export function readPresentedPerSecond(
  records: readonly PresentedFrameRecord[],
  nowMs: number,
  windowMs: number = RATE_WINDOW_MS,
): number | null {
  const windowStartMs = nowMs - windowMs;
  let presentedInWindow = 0;

  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index].wallTimeMs <= windowStartMs) {
      break;
    }

    presentedInWindow += 1;
  }

  return presentedInWindow === 0
    ? null
    : (presentedInWindow * MILLISECONDS_PER_SECOND) / windowMs;
}

/**
 * Records what the producer presents, from outside the scene that draws it.
 *
 * The handler registered here writes the frame's identity into a fixed ring and
 * hands that same frame to the renderer's handler inside the producer's call:
 * no copy, no await, no reordering, and the renderer stays the one owner that
 * closes it. Wall time is read here, so the scene keeps its single clock.
 */
export function createPresentedFrameTap(
  options: PresentedFrameTapOptions = {},
): PresentedFrameTap {
  const capacity = Math.max(1, options.capacity ?? DEFAULT_RING_CAPACITY);
  const readWallTime = options.now ?? (() => performance.now());
  const ring: PresentedFrameRecord[] = [];
  let writeIndex = 0;
  let presentedCount = 0;

  const record = (presented: PresentedFrame) => {
    const entry: PresentedFrameRecord = {
      mediaTimeMs: presented.mediaTimeMs,
      quality: presented.quality,
      wallTimeMs: readWallTime(),
    };

    if (ring.length < capacity) {
      ring.push(entry);
    } else {
      ring[writeIndex] = entry;
    }

    writeIndex = (writeIndex + 1) % capacity;
    presentedCount += 1;
  };
  const readRecords = () =>
    presentedCount <= capacity
      ? [...ring]
      : [...ring.slice(writeIndex), ...ring.slice(0, writeIndex)];

  return {
    read() {
      const records = readRecords();

      return {
        lastPresented: records.at(-1) ?? null,
        presentedCount,
        presentedPerSecond: readPresentedPerSecond(records, readWallTime()),
        records,
      };
    },

    reset() {
      ring.length = 0;
      writeIndex = 0;
      presentedCount = 0;
    },

    tap(source) {
      return {
        async open() {
          const opened = await source.open();
          const producer = readPresentedFrameProducer(opened);

          return producer
            ? { ...opened, engine: tapProducer(producer, record) }
            : opened;
        },
      };
    },
  };
}

function readPresentedFrameProducer(
  opened: unknown,
): PresentedFrameProducer | null {
  if (typeof opened !== "object" || opened === null) {
    return null;
  }

  const { engine } = opened as { readonly engine?: unknown };

  if (typeof engine !== "object" || engine === null) {
    return null;
  }

  const candidate = engine as Partial<PresentedFrameProducer>;

  return typeof candidate.onPresentedFrame === "function"
    ? (engine as PresentedFrameProducer)
    : null;
}

function tapProducer<Producer extends PresentedFrameProducer>(
  producer: Producer,
  record: (presented: PresentedFrame) => void,
): Producer {
  return new Proxy(producer, {
    get(target, property, receiver) {
      if (property !== "onPresentedFrame") {
        return Reflect.get(target, property, receiver);
      }

      return (handler: PresentedFrameHandler) => {
        target.onPresentedFrame((presented) => {
          record(presented);
          handler(presented);
        });
      };
    },
  });
}
