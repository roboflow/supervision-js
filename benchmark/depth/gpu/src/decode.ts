import { decodePng16 } from "../../../../packages/web/src/render-preparation/depth-png16";
import { encodePng16, PngFilter } from "./png-encode";
import { summarize, type TimingSummary } from "./timing";
import type { Resolution } from "./upload-render";

export interface DecodeFrame {
  readonly values: Uint16Array;
  readonly scale: number;
}

export interface DecodeCase {
  readonly resolution: string;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly format: string;
  readonly bytes: number;
  /** Rows written with None, Sub, Up, Average and Paeth. */
  readonly filterCounts?: readonly number[];
  readonly exact: boolean;
  /** decodePng16 on the page's own thread, fetch excluded. */
  readonly mainThreadMs: TimingSummary;
  /** Post the bytes to a worker, decode there, transfer the samples back. */
  readonly workerRoundTripMs?: TimingSummary;
  /** The decode alone, timed inside the worker. */
  readonly workerDecodeMs?: TimingSummary;
}

const FILTERS: readonly PngFilter[] = [
  PngFilter.Up,
  PngFilter.Sub,
  PngFilter.None,
  PngFilter.Average,
  PngFilter.Paeth,
  PngFilter.PaethUpMix,
  PngFilter.Adaptive,
];

/**
 * PNG16 decode per frame, one PNG per row filter, on the main thread and in a
 * worker. "adaptive" is what libpng and Pillow write by default: a filter per
 * row, mostly Paeth. A row-delta + gzip file of the same samples is decoded
 * as a reference, because research 07 measured it 2.5 times faster than the
 * prototype PNG decoder.
 */
export async function runDecodeCases(
  resolution: Resolution,
  frame: DecodeFrame,
  onProgress: (message: string) => void,
): Promise<DecodeCase[]> {
  const runs = resolution.width * resolution.height > 2_500_000 ? 9 : 15;
  const worker = new Worker(new URL("./decode.worker.ts", import.meta.url), {
    type: "module",
  });
  const cases: DecodeCase[] = [];

  try {
    for (const filter of FILTERS) {
      onProgress(`${resolution.label}: encoding PNG16 with ${filter} rows`);
      const png = await encodePng16(
        resolution.width,
        resolution.height,
        frame.values,
        filter,
      );
      const decoded = await decodePng16(png.bytes);

      onProgress(`${resolution.label}: decoding PNG16 with ${filter} rows`);
      const mainThread = await time(runs, () => decodePng16(png.bytes));
      const inWorker = await timeWorker(worker, runs, png.bytes);

      cases.push({
        bytes: png.bytes.byteLength,
        exact: equal(decoded.values, frame.values),
        filterCounts: png.filterCounts,
        format: `png16 ${filter}`,
        height: resolution.height,
        mainThreadMs: mainThread,
        resolution: resolution.label,
        scale: frame.scale,
        width: resolution.width,
        workerDecodeMs: inWorker.decode,
        workerRoundTripMs: inWorker.roundTrip,
      });
    }
  } finally {
    worker.terminate();
  }

  onProgress(`${resolution.label}: row-delta + gzip reference`);
  const delta = await encodeRowDeltaGzip(
    resolution.width,
    resolution.height,
    frame.values,
  );
  const reference = await decodeRowDeltaGzip(
    delta,
    resolution.width,
    resolution.height,
  );

  cases.push({
    bytes: delta.byteLength,
    exact: equal(reference, frame.values),
    format: "u16 row-delta + gzip (reference)",
    height: resolution.height,
    mainThreadMs: await time(runs, () =>
      decodeRowDeltaGzip(delta, resolution.width, resolution.height),
    ),
    resolution: resolution.label,
    scale: frame.scale,
    width: resolution.width,
  });

  return cases;
}

async function time(
  runs: number,
  work: () => Promise<unknown>,
): Promise<TimingSummary> {
  const samples: number[] = [];

  for (let i = 0; i < runs + 2; i += 1) {
    const start = performance.now();

    await work();
    if (i >= 2) samples.push(performance.now() - start);
  }

  return summarize(samples);
}

async function timeWorker(worker: Worker, runs: number, bytes: Uint8Array) {
  const roundTrip: number[] = [];
  const decode: number[] = [];

  for (let i = 0; i < runs + 2; i += 1) {
    const copy = bytes.slice().buffer;
    const start = performance.now();
    const reply = await new Promise<{ decodeMs: number; error?: string }>(
      (resolve) => {
        worker.addEventListener("message", (event) => resolve(event.data), {
          once: true,
        });
        worker.postMessage({ bytes: copy, id: i }, [copy]);
      },
    );

    if (reply.error) throw new Error(reply.error);
    if (i >= 2) {
      roundTrip.push(performance.now() - start);
      decode.push(reply.decodeMs);
    }
  }

  return { decode: summarize(decode), roundTrip: summarize(roundTrip) };
}

async function encodeRowDeltaGzip(
  width: number,
  height: number,
  values: Uint16Array,
) {
  const delta = new Uint16Array(values.length);

  for (let y = 0; y < height; y += 1) {
    let previous = 0;

    for (let x = 0; x < width; x += 1) {
      const value = values[y * width + x];

      delta[y * width + x] = (value - previous) & 0xffff;
      previous = value;
    }
  }

  const stream = new Blob([delta.buffer as ArrayBuffer])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));

  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decodeRowDeltaGzip(
  bytes: Uint8Array,
  width: number,
  height: number,
) {
  const stream = new Blob([bytes as BufferSource])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const delta = new Uint16Array(await new Response(stream).arrayBuffer());
  const out = new Uint16Array(width * height);

  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    const row = y * width;

    for (let x = 0; x < width; x += 1) {
      sum = (sum + delta[row + x]) & 0xffff;
      out[row + x] = sum;
    }
  }

  return out;
}

function equal(left: Uint16Array, right: Uint16Array) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }

  return true;
}
