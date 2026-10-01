import type { DepthPreviewLevels } from "supervision-js-core";

import { withinDecoderDeadline } from "./decoder-deadline";
import {
  DECODER_SUPPORT_MILLISECONDS,
  openDepthPreviewTrack,
  type DepthPreviewLumaPath,
  type DepthPreviewTrackReader,
  type DepthPreviewTrackInput,
} from "./depth-preview-track";

/**
 * Every 8-bit code from 0 to 255 as a flat 16x16 block of one 256x256 frame
 * (code c at block row c >> 4, column c & 15), with neutral chroma, two
 * frames. It is encoded the way a depth producer writes a full-range
 * preview, only at a quantiser low enough that a flat block decodes exactly:
 *
 * ```sh
 * ffmpeg -f rawvideo -pix_fmt yuv420p -s 256x256 -r 24 -i ramp.yuv \
 *   -c:v libx264 -preset medium -tune psnr -qp 2 -g 24 -keyint_min 24 \
 *   -sc_threshold 0 \
 *   -bsf:v "h264_metadata=video_full_range_flag=1,filter_units=remove_types=6" \
 *   -movflags +faststart -map_metadata -1 -fflags +bitexact \
 *   -flags:v +bitexact probe.mp4
 * ```
 *
 * ffmpeg's own decoder returns every block exactly.
 */
const PROBE_MP4_BASE64 = [
  "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAL8bW9vdgAAAGxtdmhkAAAAAAAA",
  "AAAAAAAAAAAD6AAAAFQAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAA",
  "AAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAkt0cmFrAAAAXHRr",
  "aGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAFQAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAA",
  "AAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAQAAAAEAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAA",
  "AAEAAABUAAAAAAABAAAAAAHDbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAwAAAABABVxAAA",
  "AAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABbm1pbmYA",
  "AAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAA",
  "AQAAAS5zdGJsAAAArnN0c2QAAAAAAAAAAQAAAJ5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAA",
  "AAAAAQABAABIAAAASAAAAAAAAAABDExhdmMgbGlieDI2NAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "GP//AAAANGF2Y0MBZAAN/+EAGGdkAA2s2UEAhpsgAAADACAAAAYB4oUywAEABWjr4GPL/fj4",
  "AAAAABRidHJ0AAAAAAAAjQAAAAAAAAAAGHN0dHMAAAAAAAAAAQAAAAIAAAIAAAAAFHN0c3MA",
  "AAAAAAAAAQAAAAEAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAIAAAABAAAAHHN0c3oAAAAAAAAA",
  "AAAAAAIAAAFoAAAAEAAAABRzdGNvAAAAAAAAAAEAAAMsAAAAPXVkdGEAAAA1bWV0YQAAAAAA",
  "AAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAIaWxzdAAAAAhmcmVlAAABgG1k",
  "YXQAAAFkZYiEAKv+99S3zLLwRH61UXVMoOUfJ2IoyzZhkK0M2aCbq+RlNHkN8HbZEszwr1Bo",
  "EQabpJoiELEi/DUJIZR8VFdLAwnzJPmenpFznALFwOAa3CUmo3Wm8orkdX/5S83y+L4wR2WP",
  "m8Tp9N/jcn8kKaHtW3x1rNMH7Gc3GMC5w8IZSZdG3nNwTS3OL2b/5ox9w1Tu5w7l9U7hwTtJ",
  "zDO6fxrHDTqNAhwB7hjlAcy9s3lR97zTanfcTfaAMDPsy6uEnZx26jYjLoCg8G0iSNFqnWKu",
  "pU4Quc/3qPD0hIbjaDTq1zXRYr2ZbIW+POv3MoI4ae2lsuhEcYK1wiS1GSCuMwtYU77ib+4u",
  "Oy3qZpnBieWR67ec8BkQQAD3DHKA5l7ZvKj73meUXYDcJDcbQadWua6LFezLZC3x51+5ljHD",
  "T20tl0IjjBWuESWoyQVxmFsSnfcTf3Fx2W9TNM4MTyyPXbznu4EAAAAMQZohbGv+1qVQAAXE",
].join("");

/**
 * The same 256 blocks written as a TV-range preview is: flagged limited
 * range with BT.709 colour, from the same `ramp.yuv`:
 *
 * ```sh
 * TV="-color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709"
 * ffmpeg -f rawvideo -pix_fmt yuv420p $TV -s 256x256 -r 24 -i ramp.yuv \
 *   -c:v libx264 -preset medium -tune psnr -qp 2 -g 24 -keyint_min 24 \
 *   -sc_threshold 0 $TV \
 *   -bsf:v "h264_metadata=video_full_range_flag=0,filter_units=remove_types=6" \
 *   -movflags +faststart -map_metadata -1 -fflags +bitexact \
 *   -flags:v +bitexact probe-tv.mp4
 * ```
 *
 * ffmpeg's own decoder returns every block exactly, footroom and headroom
 * included.
 */
const TV_PROBE_MP4_BASE64 = [
  "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMSbW9vdgAAAGxtdmhkAAAAAAAA",
  "AAAAAAAAAAAD6AAAAFQAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAA",
  "AAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAmF0cmFrAAAAXHRr",
  "aGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAFQAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAA",
  "AAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAQAAAAEAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAA",
  "AAEAAABUAAAAAAABAAAAAAHZbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAwAAAABABVxAAA",
  "AAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABhG1pbmYA",
  "AAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAA",
  "AQAAAURzdGJsAAAAxHN0c2QAAAAAAAAAAQAAALRhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAA",
  "AAAAAQABAABIAAAASAAAAAAAAAABDExhdmMgbGlieDI2NAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "GP//AAAAN2F2Y0MBZAAN/+EAG2dkAA2s2UEAhpqAgICgAAADACAAAAYB4oUywAEABWjr4GPL",
  "/fj4AAAAABNjb2xybmNseAABAAEAAQAAAAAUYnRydAAAAAAAAI0AAAAAAAAAABhzdHRzAAAA",
  "AAAAAAEAAAACAAACAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEA",
  "AAACAAAAAQAAABxzdHN6AAAAAAAAAAAAAAACAAABaAAAABAAAAAUc3RjbwAAAAAAAAABAAAD",
  "QgAAAD11ZHRhAAAANW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAA",
  "AAAACGlsc3QAAAAIZnJlZQAAAYBtZGF0AAABZGWIhACr/vfUt8yy8ER+tVF1TKDlHydiKMs2",
  "YZCtDNmgm6vkZTR5DfB22RLM8K9QaBEGm6SaIhCxIvw1CSGUfFRXSwMJ8yT5np6Rc5wCxcDg",
  "GtwlJqN1pvKK5HV/+UvN8vi+MEdlj5vE6fTf43J/JCmh7Vt8dazTB+xnNxjAucPCGUmXRt5z",
  "cE0tzi9m/+aMfcNU7ucO5fVO4cE7Scwzun8axw06jQIcAe4Y5QHMvbN5Ufe802p33E32gDAz",
  "7MurhJ2cduo2Iy6AoPBtIkjRap1irqVOELnP96jw9ISG42g06tc10WK9mWyFvjzr9zKCOGnt",
  "pbLoRHGCtcIktRkgrjMLWFO+4m/uLjst6maZwYnlkeu3nPAZEEAA9wxygOZe2byo+95nlF2A",
  "3CQ3G0GnVrmuixXsy2Qt8edfuZYxw09tLZdCI4wVrhElqMkFcZhbEp33E39xcdlvUzTODE8s",
  "j12857uBAAAADEGaIWxr/talUAAFxA==",
].join("");

interface ProbeSpec {
  readonly base64: string;
  /**
   * The written codes a decoder is judged on: those a preview at this level
   * writes. A TV-range decoder that converts to RGB flattens the footroom and
   * headroom, which no preview uses.
   */
  readonly firstCode: number;
  readonly lastCode: number;
  /**
   * Decoders to try, best first. Browsers decode the same H.264 differently
   * by path, and their own choice switches between paths by frame size, so
   * each is asked for by name to keep the probe and the preview on the same
   * one. Chrome's hardware decoder on macOS returns TV range as written but
   * hands full-range luma back squeezed into TV range (0 becomes 16, 255
   * becomes 235), where its software decoder returns it as written.
   */
  readonly preferences: readonly HardwareAcceleration[];
}

const PROBE_SPECS: Readonly<Record<DepthPreviewLevels, ProbeSpec>> = {
  full: {
    base64: PROBE_MP4_BASE64,
    firstCode: 0,
    lastCode: 255,
    preferences: ["prefer-software", "prefer-hardware"],
  },
  tv: {
    base64: TV_PROBE_MP4_BASE64,
    firstCode: 16,
    lastCode: 235,
    preferences: ["prefer-hardware", "prefer-software"],
  },
};

const PROBE_CODEC = "avc1.64000d";
const PROBE_SIZE = 256;
const PROBE_BLOCK_SIZE = 16;
const PROBE_BLOCKS_PER_ROW = 16;
/** Pixels this far inside a block are read, clear of any edge filtering. */
const PROBE_BLOCK_INSET = 4;
/**
 * How long one decoder may take to return the probe's first frame. The clip
 * is in memory, so this is decoder time alone; a decoder that works takes a
 * few milliseconds.
 */
export const PROBE_DECODE_MILLISECONDS = 5000;

/** What a browser's decoder did to the codes a producer wrote. */
export interface DepthPreviewCodeProbe {
  /** Every judged code came back exactly as written. */
  readonly exact: boolean;
  /** Codes judged: 256 at full levels, the 220 from 16 to 235 at TV levels. */
  readonly judgedCodes: number;
  readonly mismatchedCodes: number;
  readonly maxError: number;
  /** The code read back for each written code, indexed by the written one. */
  readonly decoded: Uint8Array;
  readonly lumaPath: DepthPreviewLumaPath | null;
}

export interface DepthPreviewDecoderVerdict {
  readonly hardwareAcceleration: HardwareAcceleration;
  readonly supported: boolean;
  readonly probe: DepthPreviewCodeProbe | null;
  readonly error?: string;
}

/** How this page decodes depth previews, chosen once by probing. */
export interface DepthPreviewDecoding {
  readonly hardwareAcceleration: HardwareAcceleration;
  /**
   * The probe through the chosen decoder, before any correction; null when
   * no decoder returned a frame of it, and a preview would not decode either.
   */
  readonly probe: DepthPreviewCodeProbe | null;
  /**
   * Maps a code read back to the code written, when the chosen decoder
   * changes codes and the table brings them closer; null when it does not.
   */
  readonly correction: Uint8Array | null;
  /** Largest error left after the correction, in codes. */
  readonly residualError: number;
  readonly verdicts: readonly DepthPreviewDecoderVerdict[];
}

type OpenTrack = (
  input: DepthPreviewTrackInput,
  options?: { readonly hardwareAcceleration?: HardwareAcceleration },
) => Promise<DepthPreviewTrackReader>;

const pageDecodings = new Map<
  DepthPreviewLevels,
  Promise<DepthPreviewDecoding>
>();

/**
 * Decodes a clip of known codes, written at the preview's levels, through
 * each decoder the page offers in the same path a depth preview takes, and
 * keeps the first that returns them as written, directly or through a
 * table that undoes a conversion it makes. Without one, it picks the
 * closest. Run once per page and level: the answer is a property of the
 * browser, not of any one preview. Probes run one after another, so the
 * page never holds two of their decoders.
 */
export function chooseDepthPreviewDecoding(
  levels: DepthPreviewLevels = "full",
  open: OpenTrack = openDepthPreviewTrack,
  isSupported: (
    preference: HardwareAcceleration,
  ) => Promise<boolean> = isProbeConfigSupported,
): Promise<DepthPreviewDecoding> {
  let decoding = pageDecodings.get(levels);

  if (!decoding) {
    decoding = runProbes(levels, open, isSupported).catch((error: unknown) => {
      pageDecodings.delete(levels);
      throw error;
    });
    pageDecodings.set(levels, decoding);
  }

  return decoding;
}

export function depthPreviewProbeBytes(
  levels: DepthPreviewLevels = "full",
): Uint8Array {
  const text = atob(PROBE_SPECS[levels].base64);
  const bytes = new Uint8Array(text.length);

  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index);
  }

  return bytes;
}

async function isProbeConfigSupported(preference: HardwareAcceleration) {
  if (typeof VideoDecoder === "undefined") return false;

  const support = await withinDecoderDeadline(
    VideoDecoder.isConfigSupported({
      codec: PROBE_CODEC,
      codedHeight: PROBE_SIZE,
      codedWidth: PROBE_SIZE,
      hardwareAcceleration: preference,
    }),
    DECODER_SUPPORT_MILLISECONDS,
    "VideoDecoder.isConfigSupported",
  ).catch(() => ({ supported: false }));

  return support.supported === true;
}

async function runProbes(
  levels: DepthPreviewLevels,
  open: OpenTrack,
  isSupported: (preference: HardwareAcceleration) => Promise<boolean>,
): Promise<DepthPreviewDecoding> {
  const verdicts: DepthPreviewDecoderVerdict[] = [];

  for (const hardwareAcceleration of PROBE_SPECS[levels].preferences) {
    const verdict = await probeDepthPreviewDecoder(
      hardwareAcceleration,
      levels,
      open,
      isSupported,
    );

    verdicts.push(verdict);
    if (verdict.probe && assessProbe(verdict.probe, levels).residual === 0) {
      break;
    }
  }

  return resolveDepthPreviewDecoding(verdicts, levels);
}

export async function probeDepthPreviewDecoder(
  hardwareAcceleration: HardwareAcceleration,
  levels: DepthPreviewLevels = "full",
  open: OpenTrack = openDepthPreviewTrack,
  isSupported: (
    preference: HardwareAcceleration,
  ) => Promise<boolean> = isProbeConfigSupported,
): Promise<DepthPreviewDecoderVerdict> {
  if (!(await isSupported(hardwareAcceleration))) {
    return { hardwareAcceleration, probe: null, supported: false };
  }

  try {
    return {
      hardwareAcceleration,
      probe: await runProbe(open, hardwareAcceleration, levels),
      supported: true,
    };
  } catch (error) {
    return {
      error: String(error),
      hardwareAcceleration,
      probe: null,
      supported: true,
    };
  }
}

/**
 * Picks the decoder whose codes come back closest to the written ones, and
 * a correction table when one makes them closer still; the first of equals
 * wins, so the order probes ran in is the order of preference.
 */
export function resolveDepthPreviewDecoding(
  verdicts: readonly DepthPreviewDecoderVerdict[],
  levels: DepthPreviewLevels = "full",
): DepthPreviewDecoding {
  let best: {
    verdict: DepthPreviewDecoderVerdict;
    correction: Uint8Array | null;
    residual: number;
  } | null = null;

  for (const verdict of verdicts) {
    if (!verdict.probe) continue;

    const { correction, residual } = assessProbe(verdict.probe, levels);

    if (!best || residual < best.residual) {
      best = { correction, residual, verdict };
    }
  }

  if (!best) {
    return {
      correction: null,
      hardwareAcceleration: "no-preference",
      probe: null,
      residualError: Number.NaN,
      verdicts,
    };
  }

  return {
    correction: best.correction,
    hardwareAcceleration: best.verdict.hardwareAcceleration,
    probe: best.verdict.probe,
    residualError: best.residual,
    verdicts,
  };
}

function assessProbe(
  probe: DepthPreviewCodeProbe,
  levels: DepthPreviewLevels,
): { correction: Uint8Array | null; residual: number } {
  if (probe.exact) return { correction: null, residual: 0 };

  const { firstCode, lastCode } = PROBE_SPECS[levels];
  const table = createCodeCorrection(probe.decoded, firstCode, lastCode);
  const residual = correctedError(probe.decoded, table, firstCode, lastCode);

  return residual < probe.maxError
    ? { correction: table, residual }
    : { correction: null, residual: probe.maxError };
}

/**
 * For each code a decoder can return, the written code from `firstCode` to
 * `lastCode` it most likely came from: the one whose read-back value is
 * nearest, the nearest written code on a tie.
 */
export function createCodeCorrection(
  decoded: Uint8Array,
  firstCode = 0,
  lastCode = 255,
): Uint8Array {
  const table = new Uint8Array(256);

  for (let value = 0; value < 256; value += 1) {
    let best = value;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let code = firstCode; code <= lastCode; code += 1) {
      const distance = Math.abs(decoded[code] - value);

      if (
        distance < bestDistance ||
        (distance === bestDistance &&
          Math.abs(code - value) < Math.abs(best - value))
      ) {
        best = code;
        bestDistance = distance;
      }
    }
    table[value] = best;
  }

  return table;
}

function correctedError(
  decoded: Uint8Array,
  table: Uint8Array,
  firstCode: number,
  lastCode: number,
) {
  let error = 0;

  for (let code = firstCode; code <= lastCode; code += 1) {
    error = Math.max(error, Math.abs(table[decoded[code]] - code));
  }

  return error;
}

/**
 * Only the decode gets a deadline: opening may wait on the network to load
 * the demuxer, which is no decoder fault.
 */
async function runProbe(
  open: OpenTrack,
  hardwareAcceleration: HardwareAcceleration,
  levels: DepthPreviewLevels,
): Promise<DepthPreviewCodeProbe> {
  const track = await open(depthPreviewProbeBytes(levels), {
    hardwareAcceleration,
  });

  try {
    const frame = await withinDecoderDeadline(
      track.decode(0).next(),
      PROBE_DECODE_MILLISECONDS,
      `The ${hardwareAcceleration} decoder`,
    );

    if (!frame) {
      throw new Error(
        `The ${hardwareAcceleration} decoder returned no frame of the probe, even flushed.`,
      );
    }

    return {
      ...readProbeFrame(frame.luma, frame.width, levels),
      lumaPath: track.getStats().lumaPath,
    };
  } finally {
    // Closing the decoder ends a decode still waiting past its deadline.
    track.dispose();
  }
}

export function readProbeFrame(
  luma: Uint8Array,
  width: number,
  levels: DepthPreviewLevels = "full",
): Omit<DepthPreviewCodeProbe, "lumaPath"> {
  const { firstCode, lastCode } = PROBE_SPECS[levels];
  const decoded = new Uint8Array(256);
  let mismatchedCodes = 0;
  let maxError = 0;

  for (let code = 0; code < 256; code += 1) {
    const top = Math.floor(code / PROBE_BLOCKS_PER_ROW) * PROBE_BLOCK_SIZE;
    const left = (code % PROBE_BLOCKS_PER_ROW) * PROBE_BLOCK_SIZE;
    let sum = 0;
    let count = 0;

    for (
      let y = top + PROBE_BLOCK_INSET;
      y < top + PROBE_BLOCK_SIZE - PROBE_BLOCK_INSET;
      y += 1
    ) {
      for (
        let x = left + PROBE_BLOCK_INSET;
        x < left + PROBE_BLOCK_SIZE - PROBE_BLOCK_INSET;
        x += 1
      ) {
        sum += luma[y * width + x];
        count += 1;
      }
    }

    const value = Math.round(sum / count);

    decoded[code] = value;
    if (code < firstCode || code > lastCode) continue;
    if (value !== code) mismatchedCodes += 1;
    maxError = Math.max(maxError, Math.abs(value - code));
  }

  return {
    decoded,
    exact: mismatchedCodes === 0,
    judgedCodes: lastCode - firstCode + 1,
    maxError,
    mismatchedCodes,
  };
}
