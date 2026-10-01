export interface DecoderDeadlinePage {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/**
 * Waits for one step of a video decoder, which answers in milliseconds when
 * it works and may never answer when it does not. Rejects with a
 * `TimeoutError` naming the step once `milliseconds` pass; the step itself
 * carries on, and its owner closes the decoder.
 *
 * The budget runs only while the page is visible: a browser may hold a
 * hidden page's decoder work back, and a step that waited on that is no
 * broken decoder.
 */
export function withinDecoderDeadline<T>(
  step: Promise<T>,
  milliseconds: number,
  what: string,
  page: DecoderDeadlinePage | undefined = (
    globalThis as { document?: DecoderDeadlinePage }
  ).document,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let remaining = milliseconds;
    let startedAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const stop = () => {
      clearTimeout(timer);
      timer = undefined;
      page?.removeEventListener("visibilitychange", onVisibility);
    };
    const expire = () => {
      stop();
      reject(
        new DOMException(
          `${what} did not answer within ${formatSeconds(milliseconds)}.`,
          "TimeoutError",
        ),
      );
    };
    const run = () => {
      if (timer !== undefined) return;
      startedAt = performance.now();
      timer = setTimeout(expire, remaining);
    };
    const pause = () => {
      if (timer === undefined) return;
      remaining = Math.max(0, remaining - (performance.now() - startedAt));
      clearTimeout(timer);
      timer = undefined;
    };
    function onVisibility() {
      if (page?.visibilityState === "hidden") pause();
      else run();
    }

    page?.addEventListener("visibilitychange", onVisibility);
    if (page?.visibilityState !== "hidden") run();

    step.then(
      (value) => {
        stop();
        resolve(value);
      },
      (error: unknown) => {
        stop();
        reject(error);
      },
    );
  });
}

export function formatSeconds(milliseconds: number): string {
  return `${Number((milliseconds / 1000).toFixed(2))} s`;
}
