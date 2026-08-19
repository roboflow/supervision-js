import { MediaErrorKind } from "supervision-js-core";

const UNSUPPORTED_FORMAT_PATTERN =
  /unsupported|not supported|no (?:matching )?(?:decoder|codec)|codec/i;
const DECODE_PATTERN = /decod|demux|corrupt|malformed|bitstream/i;
const NETWORK_PATTERN =
  /network|fetch|http|failed to load|load failed|timed? ?out|abort/i;

/**
 * A media failure with a stable, documented kind.
 *
 * Branch on `kind` instead of matching decoder, demuxer, or container message
 * text. `message` stays diagnostic and may name vendor internals; applications
 * own their user-facing copy. The originating failure is preserved on `cause`.
 */
export class MediaSourceError extends Error {
  readonly kind: MediaErrorKind;

  constructor(
    kind: MediaErrorKind,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "MediaSourceError";
    this.kind = kind;
  }
}

export function isMediaSourceError(value: unknown): value is MediaSourceError {
  return value instanceof MediaSourceError;
}

/**
 * Classifies an arbitrary media failure into a `MediaSourceError`.
 *
 * Already-classified errors pass through so a kind chosen at the point of
 * failure is never downgraded by a broader message match. Anything the
 * heuristics cannot place stays representable as `Unknown` rather than being
 * forced into a wrong kind.
 */
export function toMediaSourceError(
  error: unknown,
  fallbackMessage = "Media source failed.",
): MediaSourceError {
  if (isMediaSourceError(error)) {
    return error;
  }

  const message = error instanceof Error ? error.message : fallbackMessage;

  return new MediaSourceError(classifyMediaErrorMessage(message), message, {
    cause: error,
  });
}

/**
 * Failure kind of a media error, or `Unknown` for anything unclassified.
 */
export function getMediaErrorKind(error: unknown): MediaErrorKind {
  return isMediaSourceError(error) ? error.kind : MediaErrorKind.Unknown;
}

function classifyMediaErrorMessage(message: string): MediaErrorKind {
  if (NETWORK_PATTERN.test(message)) {
    return MediaErrorKind.Network;
  }

  if (UNSUPPORTED_FORMAT_PATTERN.test(message)) {
    return MediaErrorKind.UnsupportedFormat;
  }

  if (DECODE_PATTERN.test(message)) {
    return MediaErrorKind.Decode;
  }

  return MediaErrorKind.Unknown;
}
