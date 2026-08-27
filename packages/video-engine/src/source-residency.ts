/**
 * Byte residency for a URL source: the bytes this process holds, the fetch that
 * serves them to the demuxer, and a background walk that fills the rest in.
 *
 * The browser HTTP cache does not do this job for media. A 200 response is
 * stored whole and read back in about a millisecond, but the demuxer never
 * issues one: it opens the file with `Range: bytes=N-` and abandons the
 * response once it has what it wanted, so every read is stored as sparse data
 * against a single cache entry. Sparse data is evicted long before a hundred
 * megabytes of it accumulates, and a whole-file fetch issued after the demuxer
 * has already touched the URL lands in that same sparse entry and is discarded
 * with it. Bytes held here are held for as long as this session wants them,
 * whatever the cache does.
 */

/** A held run of the source file, `end` exclusive. */
export interface ResidentRange {
  readonly start: number;
  readonly end: number;
}

export interface ResidencySnapshot {
  /** Held runs, ascending, never touching or overlapping. */
  readonly ranges: readonly ResidentRange[];
  readonly residentBytes: number;
  /** Source length once a response has disclosed it, else null. */
  readonly totalBytes: number | null;
  /** Bytes the background walk has pulled, excluding what playback pulled. */
  readonly prefetchedBytes: number;
  readonly warming: boolean;
}

export interface SourceResidencyOptions {
  readonly url: string;
  /** Ceiling on held bytes. Runs furthest from the focus offset are dropped first. */
  readonly budgetBytes: number;
  /** Largest single background request. */
  readonly chunkBytes?: number;
  readonly requestInit?: RequestInit;
  readonly fetchImpl?: typeof fetch;
}

export interface SourceResidency {
  /** Hand to mediabunny's `UrlSource` as its `fetchFn`. */
  readonly fetchFn: typeof fetch;
  snapshot(): ResidencySnapshot;
  /**
   * Offset the background walk works outward from, so the bytes nearest the
   * playhead arrive first and a viewer who seeks nearby stops waiting soonest.
   */
  focusAt(offset: number): void;
  startWarming(): void;
  stopWarming(): void;
  dispose(): void;
}

interface Segment {
  start: number;
  bytes: Uint8Array;
}

const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
/** Granularity at which a streaming read is banked. Mediabunny never asks
 *  the network for less than half a mebibyte, so every read it makes banks
 *  at least one block. */
export const READ_BLOCK_BYTES = 512 * 1024;
const RANGE_HEADER = /^bytes=(\d+)-(\d*)$/;

const segmentEnd = (segment: Segment): number =>
  segment.start + segment.bytes.length;

function readRangeHeader(init: RequestInit | undefined): number | null {
  const headers = new Headers(init?.headers ?? undefined);
  const value = headers.get("Range");
  if (!value) return null;
  const match = RANGE_HEADER.exec(value.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Bytes held in one buffer per contiguous run, merged on insert so a lookup is
 * a single scan and a served range is a single subarray with nothing copied.
 */
class ByteStore {
  #segments: Segment[] = [];
  #bytes = 0;

  get residentBytes(): number {
    return this.#bytes;
  }

  ranges(): ResidentRange[] {
    return this.#segments.map((segment) => ({
      start: segment.start,
      end: segmentEnd(segment),
    }));
  }

  /** The held run from `offset` to the end of its run, or null. */
  runAt(offset: number): Uint8Array | null {
    for (const segment of this.#segments) {
      if (segment.start > offset) return null;
      if (segmentEnd(segment) > offset) {
        return segment.bytes.subarray(offset - segment.start);
      }
    }
    return null;
  }

  /** Where the gap containing `offset` ends, or null when nothing is held past it. */
  nextHeldStart(offset: number): number | null {
    for (const segment of this.#segments) {
      if (segment.start > offset) return segment.start;
    }
    return null;
  }

  insert(start: number, bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const end = start + bytes.length;
    const kept: Segment[] = [];
    let merged: Segment = { start, bytes };
    for (const segment of this.#segments) {
      if (segmentEnd(segment) < merged.start || segment.start > end) {
        kept.push(segment);
        continue;
      }
      this.#bytes -= segment.bytes.length;
      merged = joinSegments(segment, merged);
    }
    kept.push(merged);
    kept.sort((left, right) => left.start - right.start);
    this.#segments = kept;
    this.#bytes += merged.bytes.length;
  }

  /** Drops whole runs, furthest from `focus` first, until the budget is met. */
  evictTo(budgetBytes: number, focus: number): void {
    while (this.#bytes > budgetBytes && this.#segments.length > 1) {
      let worstIndex = 0;
      let worstDistance = -1;
      for (const [index, segment] of this.#segments.entries()) {
        const distance =
          focus < segment.start
            ? segment.start - focus
            : Math.max(0, focus - segmentEnd(segment));
        if (distance > worstDistance) {
          worstDistance = distance;
          worstIndex = index;
        }
      }
      const [dropped] = this.#segments.splice(worstIndex, 1);
      if (dropped) this.#bytes -= dropped.bytes.length;
    }
  }

  clear(): void {
    this.#segments = [];
    this.#bytes = 0;
  }
}

function joinSegments(left: Segment, right: Segment): Segment {
  const start = Math.min(left.start, right.start);
  const end = Math.max(segmentEnd(left), segmentEnd(right));
  const bytes = new Uint8Array(end - start);
  bytes.set(left.bytes, left.start - start);
  bytes.set(right.bytes, right.start - start);
  return { start, bytes };
}

function partialResponse(
  bytes: Uint8Array,
  start: number,
  totalBytes: number | null,
): Response {
  const end = start + bytes.length - 1;
  const headers = new Headers({
    "Content-Length": String(bytes.length),
    "Content-Range": `bytes ${start}-${end}/${totalBytes ?? "*"}`,
    "Accept-Ranges": "bytes",
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(body, { status: 206, headers });
}

function totalFromHeaders(response: Response): number | null {
  const contentRange = response.headers.get("Content-Range");
  const match = contentRange ? /\/(\d+)/.exec(contentRange) : null;
  if (match) return Number(match[1]);
  const contentLength = response.headers.get("Content-Length");
  return response.status === 200 && contentLength
    ? Number(contentLength)
    : null;
}

export function createSourceResidency(
  options: SourceResidencyOptions,
): SourceResidency {
  const realFetch = options.fetchImpl ?? fetch;
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const store = new ByteStore();

  let totalBytes: number | null = null;
  let prefetchedBytes = 0;
  let focus = 0;
  let warming = false;
  let walking = false;
  let foregroundReads = 0;
  let disposed = false;
  const warmAborts = new Set<AbortController>();

  /* A background chunk shares one connection and one link with the read the
   * viewer is waiting on, so the walk stands down while a read is outstanding
   * rather than lengthening it. */
  const foregroundIdle = (): boolean => foregroundReads === 0;

  /* The demuxer opens a read as an open-ended range and abandons the response
   * the moment it holds what it asked for, and a transform whose reader walked
   * away runs neither its flush nor its cancel in Chrome. Bytes are banked as
   * they arrive, in blocks, so an abandoned read leaves behind what it pulled
   * and the walk has no reason to pull it again. */
  const teeInto = (start: number, response: Response): Response => {
    if (!response.body) return response;
    let blockStart = start;
    let block: Uint8Array[] = [];
    let blockBytes = 0;
    const bank = () => {
      if (disposed || blockBytes === 0) return;
      const banked = new Uint8Array(blockBytes);
      let at = 0;
      for (const chunk of block) {
        banked.set(chunk, at);
        at += chunk.length;
      }
      store.insert(blockStart, banked);
      store.evictTo(options.budgetBytes, focus);
      blockStart += blockBytes;
      block = [];
      blockBytes = 0;
    };
    const stream = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          block.push(chunk);
          blockBytes += chunk.length;
          if (blockBytes >= READ_BLOCK_BYTES) bank();
        },
        flush: bank,
      }),
    );
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  const fetchFn: typeof fetch = async (input, init) => {
    const start = readRangeHeader(init);
    if (start !== null) {
      const held = store.runAt(start);
      if (held && held.length > 0) {
        return partialResponse(held, start, totalBytes);
      }
    }
    foregroundReads += 1;
    try {
      const response = await realFetch(input, init);
      totalBytes ??= totalFromHeaders(response);
      return start === null ? response : teeInto(start, response);
    } finally {
      foregroundReads -= 1;
    }
  };

  /** The first gap at or after `from`, bounded by the chunk size. */
  const nextGap = (from: number): ResidentRange | null => {
    if (totalBytes === null || from >= totalBytes) return null;
    let cursor = from;
    while (cursor < totalBytes) {
      const held = store.runAt(cursor);
      if (!held) break;
      cursor += held.length;
    }
    if (cursor >= totalBytes) return null;
    const nextHeld = store.nextHeldStart(cursor) ?? totalBytes;
    return {
      start: cursor,
      end: Math.min(cursor + chunkBytes, nextHeld, totalBytes),
    };
  };

  const pullChunk = async (gap: ResidentRange): Promise<boolean> => {
    const controller = new AbortController();
    warmAborts.add(controller);
    try {
      const response = await realFetch(options.url, {
        ...options.requestInit,
        headers: {
          ...(options.requestInit?.headers as
            Record<string, string> | undefined),
          Range: `bytes=${gap.start}-${gap.end - 1}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) return false;
      totalBytes ??= totalFromHeaders(response);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (disposed) return false;
      store.insert(gap.start, bytes);
      prefetchedBytes += bytes.length;
      store.evictTo(options.budgetBytes, focus);
      return true;
    } catch {
      return false;
    } finally {
      warmAborts.delete(controller);
    }
  };

  const walk = async (): Promise<void> => {
    if (walking) return;
    walking = true;
    try {
      while (warming && !disposed) {
        if (!foregroundIdle() || store.residentBytes >= options.budgetBytes) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        const gap = nextGap(focus) ?? nextGap(0);
        if (!gap) break;
        if (!(await pullChunk(gap))) break;
      }
    } finally {
      walking = false;
      warming = warming && !disposed && nextGap(0) !== null;
    }
  };

  return {
    fetchFn,
    snapshot: () => ({
      ranges: store.ranges(),
      residentBytes: store.residentBytes,
      totalBytes,
      prefetchedBytes,
      warming,
    }),
    focusAt: (offset) => {
      focus = Math.max(0, Math.floor(offset));
    },
    startWarming: () => {
      if (disposed || warming) return;
      warming = true;
      void walk();
    },
    stopWarming: () => {
      warming = false;
      for (const controller of warmAborts) controller.abort();
      warmAborts.clear();
    },
    dispose: () => {
      disposed = true;
      warming = false;
      for (const controller of warmAborts) controller.abort();
      warmAborts.clear();
      store.clear();
    },
  };
}
