import {
  openDepthPreviewTrack,
  type DepthPreviewLumaPath,
  type DepthPreviewTrackReader,
  type DepthPreviewTrackInput,
} from "./depth-preview-track";

/**
 * Every 8-bit code from 0 to 255 as a flat 16x16 block of one 256x256 frame
 * (code c at block row c >> 4, column c & 15), with neutral chroma, two
 * frames. It is encoded the way a depth producer writes a preview, only at a
 * quantiser low enough that a flat block decodes exactly:
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

const PROBE_CODEC = "avc1.64000d";
const PROBE_SIZE = 256;
const PROBE_BLOCK_SIZE = 16;
const PROBE_BLOCKS_PER_ROW = 16;
/** Pixels this far inside a block are read, clear of any edge filtering. */
const PROBE_BLOCK_INSET = 4;

/** What a browser's decoder did to the codes a producer wrote. */
export interface DepthPreviewCodeProbe {
  /** Every code came back exactly as written. */
  readonly exact: boolean;
  /** Written codes that came back as another code, of 256. */
  readonly mismatchedCodes: number;
  /** The largest difference between a written code and the code read back. */
  readonly maxError: number;
  /** The code read back for each written code, indexed by the written one. */
  readonly decoded: Uint8Array;
  readonly lumaPath: DepthPreviewLumaPath | null;
}

/** One decoder the page could decode a preview with, and how it did. */
export interface DepthPreviewDecoderVerdict {
  readonly hardwareAcceleration: HardwareAcceleration;
  readonly supported: boolean;
  readonly probe: DepthPreviewCodeProbe | null;
  readonly error?: string;
}

/** How this page decodes depth previews, chosen once by probing. */
export interface DepthPreviewDecoding {
  readonly hardwareAcceleration: HardwareAcceleration;
  /** The probe through the chosen decoder, before any correction. */
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

/**
 * Decoders to try, best first. Browsers decode the same H.264 differently by
 * path: Chrome's hardware decoder on macOS hands luma back squeezed into
 * video range (0 becomes 16, 255 becomes 235) while its software decoder
 * returns the codes as written, and its own choice switches between the two
 * by frame size. Asking for each by name keeps the probe and the preview on
 * the same path.
 */
const DECODER_PREFERENCES: readonly HardwareAcceleration[] = [
  "prefer-software",
  "prefer-hardware",
];

type OpenTrack = (
  input: DepthPreviewTrackInput,
  options?: { readonly hardwareAcceleration?: HardwareAcceleration },
) => Promise<DepthPreviewTrackReader>;

let pageDecoding: Promise<DepthPreviewDecoding> | undefined;

/**
 * Decodes a clip of known codes through each decoder the page offers, in the
 * same path a depth preview takes, and picks the one that returns them as
 * written. Without one, it picks the closest and a table that corrects what
 * it can. Run once per page: the answer is a property of the browser, not of
 * any one preview. Probes run one after another, so the page never holds two
 * of their decoders.
 */
export function chooseDepthPreviewDecoding(
  open: OpenTrack = openDepthPreviewTrack,
  isSupported: (
    preference: HardwareAcceleration,
  ) => Promise<boolean> = isProbeConfigSupported,
): Promise<DepthPreviewDecoding> {
  pageDecoding ??= runProbes(open, isSupported).catch((error: unknown) => {
    pageDecoding = undefined;
    throw error;
  });

  return pageDecoding;
}

/** The probe clip's bytes. */
export function depthPreviewProbeBytes(): Uint8Array {
  const text = atob(PROBE_MP4_BASE64);
  const bytes = new Uint8Array(text.length);

  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index);
  }

  return bytes;
}

async function isProbeConfigSupported(preference: HardwareAcceleration) {
  if (typeof VideoDecoder === "undefined") return false;

  const support = await VideoDecoder.isConfigSupported({
    codec: PROBE_CODEC,
    codedHeight: PROBE_SIZE,
    codedWidth: PROBE_SIZE,
    hardwareAcceleration: preference,
  }).catch(() => ({ supported: false }));

  return support.supported === true;
}

async function runProbes(
  open: OpenTrack,
  isSupported: (preference: HardwareAcceleration) => Promise<boolean>,
): Promise<DepthPreviewDecoding> {
  const verdicts: DepthPreviewDecoderVerdict[] = [];

  for (const hardwareAcceleration of DECODER_PREFERENCES) {
    const verdict = await probeDepthPreviewDecoder(
      hardwareAcceleration,
      open,
      isSupported,
    );

    verdicts.push(verdict);
    if (verdict.probe?.exact) break;
  }

  return resolveDepthPreviewDecoding(verdicts);
}

/** Decodes the probe clip through one decoder, if the browser offers it. */
export async function probeDepthPreviewDecoder(
  hardwareAcceleration: HardwareAcceleration,
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
      probe: await runProbe(open, hardwareAcceleration),
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
 * a correction table when one makes them closer still.
 */
export function resolveDepthPreviewDecoding(
  verdicts: readonly DepthPreviewDecoderVerdict[],
): DepthPreviewDecoding {
  let best: {
    verdict: DepthPreviewDecoderVerdict;
    correction: Uint8Array | null;
    residual: number;
  } | null = null;

  for (const verdict of verdicts) {
    if (!verdict.probe) continue;

    const table = verdict.probe.exact
      ? null
      : createCodeCorrection(verdict.probe.decoded);
    const residual = table
      ? correctedError(verdict.probe.decoded, table)
      : verdict.probe.maxError;
    const correction =
      table && residual < verdict.probe.maxError ? table : null;
    const error = correction ? residual : verdict.probe.maxError;

    if (!best || error < best.residual) {
      best = { correction, residual: error, verdict };
    }
  }

  if (!best) {
    // Nothing could be probed; the browser's own choice, unverified.
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

/**
 * For each code a decoder can return, the written code it most likely came
 * from: the one whose read-back value is nearest, the nearest written code on
 * a tie.
 */
export function createCodeCorrection(decoded: Uint8Array): Uint8Array {
  const table = new Uint8Array(256);

  for (let value = 0; value < 256; value += 1) {
    let best = value;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let code = 0; code < 256; code += 1) {
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

function correctedError(decoded: Uint8Array, table: Uint8Array) {
  let error = 0;

  for (let code = 0; code < 256; code += 1) {
    error = Math.max(error, Math.abs(table[decoded[code]] - code));
  }

  return error;
}

async function runProbe(
  open: OpenTrack,
  hardwareAcceleration: HardwareAcceleration,
): Promise<DepthPreviewCodeProbe> {
  const track = await open(depthPreviewProbeBytes(), { hardwareAcceleration });

  try {
    const frame = await track.decode(0).next();

    if (!frame) throw new Error("The depth preview probe decoded no frame.");

    return {
      ...readProbeFrame(frame.luma, frame.width),
      lumaPath: track.getStats().lumaPath,
    };
  } finally {
    track.dispose();
  }
}

/** Reads the probe's blocks out of a decoded frame's luma. */
export function readProbeFrame(
  luma: Uint8Array,
  width: number,
): Omit<DepthPreviewCodeProbe, "lumaPath"> {
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
    if (value !== code) mismatchedCodes += 1;
    maxError = Math.max(maxError, Math.abs(value - code));
  }

  return { decoded, exact: mismatchedCodes === 0, maxError, mismatchedCodes };
}
