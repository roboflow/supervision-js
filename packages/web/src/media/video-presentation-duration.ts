/** Timing read from the selected video track, never inferred from nominal FPS. */
export interface VideoPresentationDurationTrack {
  computeDuration(options: { skipLiveWait: boolean }): Promise<number>;
  getFirstTimestamp(): Promise<number>;
  isLive(): Promise<boolean>;
}

/**
 * Mediabunny computeDuration returns an absolute packet end. The renderer needs
 * a span from the first playable timestamp (negative edit-list pre-roll is hidden).
 * A live/progressively generated track must not freeze at its current packet end.
 * Only progressive normalization of a finite source supplies a known span hint.
 */
export async function videoPresentationDuration(
  track: VideoPresentationDurationTrack,
  finiteSourceDuration?: number | null,
  progressive = false,
): Promise<number | null> {
  // A ReadableStreamSource can be growing while the container reports non-live.
  // Asking for its last packet would wait for EOF even with skipLiveWait.
  if (progressive || (await track.isLive())) {
    return finiteSourceDuration != null &&
      Number.isFinite(finiteSourceDuration) &&
      finiteSourceDuration >= 0
      ? finiteSourceDuration
      : null;
  }
  const [endTimestamp, firstTimestamp] = await Promise.all([
    track.computeDuration({ skipLiveWait: true }),
    track.getFirstTimestamp(),
  ]);
  if (!Number.isFinite(endTimestamp) || !Number.isFinite(firstTimestamp)) {
    return null;
  }
  return Math.max(0, endTimestamp - Math.max(0, firstTimestamp));
}
