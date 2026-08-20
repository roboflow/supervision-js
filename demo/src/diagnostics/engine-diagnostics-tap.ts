import type { DiagnosticsSnapshot } from "@roboflow/video-engine";
import type { MediaRendererSource } from "supervision";

/** Matches the engine's own broadcast rate, so the demo's readings and the
 *  storybook panel's are sampled over the same interval. */
export const engineDiagnosticsBroadcastHz = 10;

/** Matches the worker's snapshot ring, so an armed capture here spans the same
 *  window the engine's own recorder captures. */
export const engineTraceWindowMs = 60_000;

/**
 * The slice of the engine handle the diagnostics surface needs, named
 * structurally so the tap can refuse a media source that is not the engine.
 */
interface EngineDiagnosticsProducer {
  armTrace(windowMs: number): void;
  disarmTrace(): void;
  exportTrace(): Promise<unknown>;
  getLatestDiagnostics(): DiagnosticsSnapshot | null;
  startDiagnostics(hz?: number): void;
  stopDiagnostics(): void;
  subscribeDiagnostics(listener: () => void): () => void;
}

export interface EngineDiagnosticsTap {
  /** Allocates the worker's rolling trace rings; disarm keeps what they hold. */
  armTrace(): void;
  disarmTrace(): void;
  /** The assembled capture, or null when nothing was armed. */
  exportTrace(): Promise<unknown>;
  /** Null until a video engine source opens, and again after it closes. */
  read(): DiagnosticsSnapshot | null;
  /** Turns the worker broadcast on, and off again through the returned stop.
   *  Idempotent: repeated starts share one broadcast. */
  start(): () => void;
  subscribe(listener: () => void): () => void;
  tap(source: MediaRendererSource): MediaRendererSource;
}

/**
 * Captures the engine handle as a media source opens, so the demo can read the
 * same DiagnosticsSnapshot the engine's own panel renders.
 *
 * The engine only assembles snapshots while something is subscribed, so the
 * broadcast is reference counted against the surfaces that asked for it: a
 * closed Debug tab leaves the worker paying nothing.
 */
export function createEngineDiagnosticsTap(): EngineDiagnosticsTap {
  let producer: EngineDiagnosticsProducer | null = null;
  let unsubscribeProducer: (() => void) | null = null;
  let readers = 0;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const attach = () => {
    if (!producer || unsubscribeProducer || readers === 0) {
      return;
    }

    producer.startDiagnostics(engineDiagnosticsBroadcastHz);
    unsubscribeProducer = producer.subscribeDiagnostics(notify);
  };

  const detach = () => {
    unsubscribeProducer?.();
    unsubscribeProducer = null;
    producer?.stopDiagnostics();
  };

  return {
    armTrace() {
      producer?.armTrace(engineTraceWindowMs);
    },

    disarmTrace() {
      producer?.disarmTrace();
    },

    async exportTrace() {
      return (await producer?.exportTrace()) ?? null;
    },

    read() {
      return producer?.getLatestDiagnostics() ?? null;
    },

    start() {
      readers += 1;
      attach();
      let stopped = false;

      return () => {
        if (stopped) {
          return;
        }

        stopped = true;
        readers -= 1;

        if (readers === 0) {
          detach();
        }
      };
    },

    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    tap(source) {
      return {
        async open() {
          const opened = await source.open();
          detach();
          producer = readEngineDiagnosticsProducer(opened);
          attach();
          notify();
          return opened;
        },
      };
    },
  };
}

function readEngineDiagnosticsProducer(
  opened: unknown,
): EngineDiagnosticsProducer | null {
  if (typeof opened !== "object" || opened === null) {
    return null;
  }

  const { engine } = opened as { readonly engine?: unknown };

  if (typeof engine !== "object" || engine === null) {
    return null;
  }

  const candidate = engine as Partial<EngineDiagnosticsProducer>;

  return typeof candidate.armTrace === "function" &&
    typeof candidate.disarmTrace === "function" &&
    typeof candidate.exportTrace === "function" &&
    typeof candidate.getLatestDiagnostics === "function" &&
    typeof candidate.startDiagnostics === "function" &&
    typeof candidate.stopDiagnostics === "function" &&
    typeof candidate.subscribeDiagnostics === "function"
    ? (engine as EngineDiagnosticsProducer)
    : null;
}
