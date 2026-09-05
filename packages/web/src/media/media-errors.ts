import { MediaErrorKind } from "supervision-js-core";

/**
 * The vocabulary a media producer may name its own failure in. A producer that
 * states its cause as one of these on `code` is classified by that name; any
 * other code is classified from the message like an uncoded failure.
 */
export const MEDIA_PRODUCER_ERROR_CODES = [
  "ABORTED",
  "BACKEND_CRASHED",
  "CONTAINER_UNREADABLE",
  "DECODER_STALLED",
  "DECODE_UNSUPPORTED",
  "NO_VIDEO_TRACK",
  "PRESENTATION_MISMATCH",
  "RATE_UNSUPPORTED",
  "SOURCE_UNREADABLE",
  "VIDEO_TRACK_UNREADABLE",
] as const;

type MediaProducerErrorCode = (typeof MEDIA_PRODUCER_ERROR_CODES)[number];

/**
 * The kind each coded refusal already stands for. Reading the code beats
 * re-deriving the kind from the message: the text of a container refusal says
 * "demuxer", the text of a wedged worker says "timed out", and the patterns
 * below would file both under the wrong kind. Written as a total record, so a
 * code added to the vocabulary above fails the build until it has a kind.
 */
const PRODUCER_CODE_KINDS: Record<MediaProducerErrorCode, MediaErrorKind> = {
  ABORTED: MediaErrorKind.Unknown,
  BACKEND_CRASHED: MediaErrorKind.Decode,
  CONTAINER_UNREADABLE: MediaErrorKind.Unreadable,
  DECODER_STALLED: MediaErrorKind.Decode,
  DECODE_UNSUPPORTED: MediaErrorKind.UnsupportedFormat,
  NO_VIDEO_TRACK: MediaErrorKind.NoVideoTrack,
  PRESENTATION_MISMATCH: MediaErrorKind.Unknown,
  RATE_UNSUPPORTED: MediaErrorKind.Unknown,
  SOURCE_UNREADABLE: MediaErrorKind.Unreadable,
  VIDEO_TRACK_UNREADABLE: MediaErrorKind.UnsupportedFormat,
};

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
  const kind = producerCodeKind(error) ?? classifyMediaErrorMessage(message);

  return new MediaSourceError(kind, message, { cause: error });
}

/**
 * Failure kind of any caught media failure.
 *
 * A `MediaSourceError` reports the kind chosen where it failed. Anything else
 * is classified from its message, and stays `Unknown` when no kind fits.
 */
export function getMediaErrorKind(error: unknown): MediaErrorKind {
  return toMediaSourceError(error).kind;
}

function producerCodeKind(error: unknown): MediaErrorKind | null {
  const code = (error as { readonly code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && code in PRODUCER_CODE_KINDS
    ? PRODUCER_CODE_KINDS[code as MediaProducerErrorCode]
    : null;
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
