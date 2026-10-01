import {
  PLAYHEAD_QUANTIZATION_TOLERANCE_SECONDS,
  type DepthManifest,
  type DepthPreviewLevels,
} from "supervision-js-core";
import type {
  DepthPreviewDecoderVerdict,
  DepthPreviewDecoding,
} from "#media/depth-preview-probe";
import type {
  DepthPreviewTrackOptions,
  DepthPreviewTrackReader,
} from "#media/depth-preview-track";
import { assertMediaAspect, resolveUrl } from "./files";
import { abortable } from "./frame-preparer";
import type { DepthPreviewLumaCopier } from "./preview-luma";
import type { DepthSourceContext } from "./source";

export interface OpenedClipPreview {
  readonly reader: DepthPreviewTrackReader;
  /** What copies decoded frames' codes out, when not the page itself. */
  readonly copier: DepthPreviewLumaCopier | undefined;
  readonly track: NonNullable<DepthManifest["preview"]>;
  /** What diagnostics say about the preview, such as altered codes. */
  readonly message: string | null;
}

export interface ClipPreview {
  readonly preview: OpenedClipPreview | null;
  /** Why a clip with a preview draws none; else null. */
  readonly unavailable: string | null;
}

/**
 * Opens the clip's preview video and checks it against the media it is
 * drawn over: one preview frame per depth frame, each at its video frame's
 * time. A preview that disagrees is refused with a `RangeError`. One this
 * browser cannot open or decode leaves the clip without it, and says why
 * once in the console and in diagnostics.
 *
 * The probe's decoder steps carry their own deadlines; the preview's file is
 * never given one, since a slow link is no reason to drop it.
 */
export async function openClipPreview(
  manifest: DepthManifest,
  base: string | URL | undefined,
  context: DepthSourceContext,
  frameCount: number,
  timeAt: (index: number) => number,
): Promise<ClipPreview> {
  const track = manifest.preview;
  const open =
    context.openPreviewTrack === undefined
      ? openDefaultPreviewTrack
      : context.openPreviewTrack;

  if (!track || !open) return { preview: null, unavailable: null };

  const url = resolveUrl(track.file, base);
  const choose =
    context.choosePreviewDecoding === undefined
      ? chooseDefaultPreviewDecoding
      : context.choosePreviewDecoding;
  const unavailable = (reason: string): ClipPreview => {
    const message = `The depth preview ${url} is off, so playback draws exact depth where it keeps up (playback auto or exact) and depth at rest otherwise: ${reason}`;

    console.warn(message);
    return { preview: null, unavailable: message };
  };
  let decoding: DepthPreviewDecoding | null = null;

  // The probe decodes before the preview opens, so the page never holds two
  // of their decoders at once.
  if (choose) {
    try {
      decoding = await abortable(choose(track.levels), context.signal);
    } catch (error) {
      if (context.signal?.aborted) throw error;
      return unavailable(`its decoder probe failed: ${String(error)}`);
    }
    if (!decoding.probe) {
      return unavailable(
        `no decoder in this browser returned a frame of the probe clip (${describeVerdicts(decoding.verdicts)}).`,
      );
    }
  }

  const copier = context.previewLumaCopier?.();
  let reader: DepthPreviewTrackReader;

  try {
    reader = await open(url, {
      copier,
      correction: decoding?.correction ?? null,
      hardwareAcceleration: decoding?.hardwareAcceleration,
      signal: context.signal,
    });
  } catch (error) {
    if (error instanceof RangeError || context.signal?.aborted) throw error;
    return unavailable(`it did not open: ${String(error)}`);
  }

  try {
    if (context.signal?.aborted) throw context.signal.reason;
    assertMediaAspect(reader, context.media);
    assertDepthPreviewTimeline(
      reader,
      frameCount,
      (index) => timeAt(index) - timeAt(0),
    );
  } catch (error) {
    reader.dispose();
    throw error;
  }

  const message = describePreviewDecoding(decoding);

  if (message) console.warn(message);

  return { preview: { copier, message, reader, track }, unavailable: null };
}

function describeVerdicts(verdicts: readonly DepthPreviewDecoderVerdict[]) {
  return verdicts
    .map(({ error, hardwareAcceleration, supported }) =>
      supported
        ? `${hardwareAcceleration}: ${error ?? "no frame"}`
        : `${hardwareAcceleration}: not offered`,
    )
    .join("; ");
}

/**
 * What diagnostics say about the page's preview decoder: nothing when its
 * codes come back as written, directly or through the probe's table.
 */
export function describePreviewDecoding(
  decoding: DepthPreviewDecoding | null,
): string | null {
  const probe = decoding?.probe;

  if (!decoding || !probe || decoding.residualError === 0) return null;

  const corrected = decoding.correction
    ? `; corrected through the probe's table to within ${decoding.residualError}`
    : "";

  return `This browser's ${decoding.hardwareAcceleration} decoder changes depth preview codes: ${probe.mismatchedCodes} of ${probe.judgedCodes} come back different, by up to ${probe.maxError} (${probe.lumaPath ?? "unknown"} path)${corrected}. Preview depth during playback is off by up to ${decoding.correction ? decoding.residualError : probe.maxError} preview steps; exact depth at rest is not affected.`;
}

async function openDefaultPreviewTrack(
  url: string,
  options?: DepthPreviewTrackOptions,
) {
  const { openDepthPreviewTrack } = await import("#media/depth-preview-track");

  return openDepthPreviewTrack(url, options);
}

async function chooseDefaultPreviewDecoding(levels: DepthPreviewLevels) {
  const { chooseDepthPreviewDecoding } =
    await import("#media/depth-preview-probe");

  return chooseDepthPreviewDecoding(levels);
}

/**
 * Refuses a preview whose frames are not the depth frames, one for one, at
 * the same times. Both timelines are compared from their own first frame, so
 * a preview that starts its clock elsewhere still lines up; a different frame
 * count, rate, or a frame out of step does not.
 */
export function assertDepthPreviewTimeline(
  preview: { readonly frameCount: number; readonly times: Float64Array },
  count: number,
  expectedTime: (index: number) => number,
): void {
  if (preview.frameCount !== count) {
    throw new RangeError(
      `The depth preview has ${preview.frameCount} frames and depth.json has ${count}; a preview needs one frame per depth frame.`,
    );
  }

  for (let index = 0; index < count; index += 1) {
    const previewTime = preview.times[index];
    const videoTime = expectedTime(index);

    if (
      Math.abs(previewTime - videoTime) >
      PLAYHEAD_QUANTIZATION_TOLERANCE_SECONDS
    ) {
      throw new RangeError(
        `Depth preview frame ${index} is at ${formatSeconds(previewTime)} and its video frame at ${formatSeconds(videoTime)}, each from its own first frame; a preview must keep the video's frame times.`,
      );
    }
  }
}

function formatSeconds(seconds: number) {
  return `${Number(seconds.toFixed(6))} s`;
}
