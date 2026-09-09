import type { DiagnosticsSnapshot } from "./diagnostics";

/**
 * Sibling of MirrorStore for the diagnostics broadcast plane. A single
 * channel holding the latest snapshot, shaped for useSyncExternalStore. Fed only
 * by the 'diag' event; the playback mirror store and its subscribers never touch
 * it, so a 10Hz diagnostics push never wakes a playback consumer.
 *
 * getSnapshot returns the same reference between writes, so a selector using
 * Object.is short-circuits when nothing changed.
 */
export class DiagnosticsStore {
  private snapshot: DiagnosticsSnapshot | null = null;
  private readonly listeners = new Set<() => void>();

  getSnapshot(): DiagnosticsSnapshot | null {
    return this.snapshot;
  }

  write(snapshot: DiagnosticsSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
