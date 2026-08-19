/**
 * One frame a push-based media producer has decided is on screen, carrying the
 * media time it stands for. Whoever receives it owns it and must close it.
 */
export interface PresentedVideoFrame {
  readonly mediaTimeMs: number;
  readonly frame: VideoFrame;
}

/**
 * A producer's presented-frame plane. Registering replaces any previous
 * handler, so the registered handler is the single owner of every frame.
 */
export interface PresentedFrameChannel {
  onPresentedFrame(handler: (presented: PresentedVideoFrame) => void): void;
}

/**
 * Reads the presented-frame plane an opened media source publishes as `engine`.
 * A source without one is pull-only, and the renderer keeps driving it by
 * asking for samples.
 */
export function resolvePresentedFrameChannel(
  source: unknown,
): PresentedFrameChannel | null {
  if (typeof source !== "object" || source === null) {
    return null;
  }

  const { engine } = source as { readonly engine?: unknown };

  return isPresentedFrameChannel(engine) ? engine : null;
}

function isPresentedFrameChannel(
  value: unknown,
): value is PresentedFrameChannel {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PresentedFrameChannel).onPresentedFrame === "function"
  );
}
