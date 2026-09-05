/**
 * Real work, held. On a warm machine this player's own waits pass under the
 * overlay's appear delay, so the states that report a wait cannot be reached at
 * all. Holding a real fetch lengthens the wait the session is already in; it
 * does not invent one.
 */

const listeners = new Set<() => void>();

let detectionFetchDelayMs = 0;

export function readDetectionFetchDelayMs(): number {
  return detectionFetchDelayMs;
}

export function setDetectionFetchDelayMs(delayMs: number): void {
  const next = Math.max(0, Math.round(delayMs));

  if (next === detectionFetchDelayMs) {
    return;
  }

  detectionFetchDelayMs = next;

  for (const listener of listeners) {
    listener();
  }
}

export function subscribeSlowWork(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/**
 * Read at call time, so a delay set while the clip plays reaches the next chunk
 * the buffer asks for.
 */
export async function delayDetectionFetch(): Promise<void> {
  const delayMs = detectionFetchDelayMs;

  if (delayMs <= 0) {
    return;
  }

  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
