/*
 * Core compiles against `lib: ["ES2022"]` so no DOM, worker, or Node surface is
 * reachable from it. That hides the two timer functions as well, which every
 * host core runs in provides, so they are declared for this module alone and
 * core's lib stays closed.
 */
declare function clearTimeout(handle: unknown): void;
declare function setTimeout(handler: () => void, timeoutMs: number): unknown;

export interface WaitBound {
  readonly cancel: () => void;
  /** Resolves false once `timeoutMs` has passed, so a race reads as unmet. */
  readonly expired: Promise<false>;
}

export function startWaitBound(timeoutMs: number): WaitBound {
  let handle: unknown;
  const expired = new Promise<false>((resolve) => {
    handle = setTimeout(() => resolve(false), timeoutMs);
  });

  return { cancel: () => clearTimeout(handle), expired };
}
