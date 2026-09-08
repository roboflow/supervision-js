/**
 * A timeout whose budget advances only while its owner is visible. The owner
 * still decides which work is eligible: this helper never pauses the work
 * itself, nor any unrelated watchdog.
 */
export interface PausableDeadline {
  cancel(): void;
  pause(): void;
  resume(): void;
}

export function createPausableDeadline(
  timeoutMs: number,
  onExpire: () => void,
): PausableDeadline {
  let cancelled = false;
  let remainingMs = timeoutMs;
  let startedAtMs = performance.now();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const expire = () => {
    if (cancelled) return;
    cancelled = true;
    timer = null;
    onExpire();
  };

  const arm = () => {
    if (cancelled || timer !== null) return;
    startedAtMs = performance.now();
    timer = setTimeout(expire, remainingMs);
  };

  arm();

  return {
    cancel() {
      if (cancelled) return;
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    pause() {
      if (cancelled || timer === null) return;
      remainingMs = Math.max(
        0,
        remainingMs - (performance.now() - startedAtMs),
      );
      clearTimeout(timer);
      timer = null;
    },
    resume: arm,
  };
}
