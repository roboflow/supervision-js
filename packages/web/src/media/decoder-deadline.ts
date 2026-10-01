/**
 * Waits for one step of a video decoder, which answers in milliseconds when
 * it works and may never answer when it does not. Rejects with a
 * `TimeoutError` naming the step once `milliseconds` pass; the step itself
 * carries on, and its owner closes the decoder.
 *
 * Only decoder steps get a deadline. A wait on the network never does: a
 * slow link is no fault.
 */
export function withinDecoderDeadline<T>(
  step: Promise<T>,
  milliseconds: number,
  what: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new DOMException(
          `${what} did not answer within ${formatSeconds(milliseconds)}.`,
          "TimeoutError",
        ),
      );
    }, milliseconds);

    step.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function formatSeconds(milliseconds: number): string {
  return `${Number((milliseconds / 1000).toFixed(2))} s`;
}
