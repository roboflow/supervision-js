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
  /** Held bytes: a window into `capacity`, which carries spare room to append into. */
  view: Uint8Array;
  capacity: Uint8Array;
}

const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
/** Granularity at which a streaming read is banked. Mediabunny never asks
 *  the network for less than half a mebibyte, so every read it makes banks
 *  at least one block. */
export const READ_BLOCK_BYTES = 512 * 1024;
/** How long a delivered chunk may sit unclaimed before the walk stops deferring
 *  to the read that produced it. It measures the gap between a chunk and the
 *  consumer's next pull, not the wait for the server, so a slow link reads as
 *  a live read while a reader that walked away frees the link. */
export const FOREGROUND_STALL_MS = 250;
const RANGE_HEADER = /^bytes=(\d+)-(\d*)$/;

const segmentEnd = (segment: Segment): number =>
  segment.start + segment.view.length;

/** Where a run's held window sits inside its buffer. */
const viewOffset = (segment: Segment): number =>
  segment.view.byteOffset - segment.capacity.byteOffset;

function readRangeHeader(init: RequestInit | undefined): number | null {
  const headers = new Headers(init?.headers ?? undefined);
  const value = headers.get("Range");
  if (!value) return null;
  const match = RANGE_HEADER.exec(value.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Bytes held in one buffer per contiguous run, so a lookup is a single scan and
 * a served range is a subarray with nothing copied. Insert is where copying
 * happens: a run keeps spare capacity so an append that extends it writes into
 * that room, and only a backward or overlapping insert re-materializes the run.
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
        return segment.view.subarray(offset - segment.start);
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
    const index = this.#segments.findIndex(
      (segment) => segmentEnd(segment) === start,
    );
    const extended = index === -1 ? undefined : this.#segments[index];
    if (extended) {
      const following = this.#segments[index + 1];
      if (!following || end < following.start) {
        appendInto(extended, bytes);
        this.#bytes += bytes.length;
        return;
      }
    }
    const kept: Segment[] = [];
    let merged: Segment = { start, view: bytes, capacity: bytes };
    for (const segment of this.#segments) {
      if (segmentEnd(segment) < merged.start || segment.start > end) {
        kept.push(segment);
        continue;
      }
      this.#bytes -= segment.view.length;
      merged = joinSegments(segment, merged);
    }
    kept.push(merged);
    kept.sort((left, right) => left.start - right.start);
    this.#segments = kept;
    this.#bytes += merged.view.length;
  }

  /**
   * Brings held bytes under the budget: whole runs go first, furthest from
   * `focus`, and a lone run that has outgrown the budget is narrowed to a
   * `budgetBytes` window at `focus`.
   */
  evictTo(budgetBytes: number, focus: number): void {
    while (this.#bytes > budgetBytes) {
      if (this.#segments.length <= 1) {
        this.#narrowToBudget(budgetBytes, focus);
        return;
      }
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
      if (dropped) this.#bytes -= dropped.view.length;
    }
  }

  #narrowToBudget(budgetBytes: number, focus: number): void {
    const segment = this.#segments[0];
    if (!segment) return;
    if (budgetBytes <= 0) {
      this.clear();
      return;
    }
    const windowStart = Math.min(
      Math.max(focus, segment.start),
      segmentEnd(segment) - budgetBytes,
    );
    const offset = viewOffset(segment) + (windowStart - segment.start);
    segment.view = segment.capacity.subarray(offset, offset + budgetBytes);
    segment.start = windowStart;
    this.#bytes = budgetBytes;
  }

  clear(): void {
    this.#segments = [];
    this.#bytes = 0;
  }
}

/**
 * Extends a run in place, growing its buffer geometrically when the spare room
 * runs out. The growth copy carries only the held window, so a run releases
 * whatever narrowing dropped off its front.
 */
function appendInto(segment: Segment, bytes: Uint8Array): void {
  const offset = viewOffset(segment);
  const tail = offset + segment.view.length;
  if (tail + bytes.length <= segment.capacity.length) {
    segment.capacity.set(bytes, tail);
    segment.view = segment.capacity.subarray(offset, tail + bytes.length);
    return;
  }
  const held = segment.view.length + bytes.length;
  const grown = new Uint8Array(Math.max(held, segment.view.length * 2));
  grown.set(segment.view, 0);
  grown.set(bytes, segment.view.length);
  segment.capacity = grown;
  segment.view = grown.subarray(0, held);
}

function joinSegments(left: Segment, right: Segment): Segment {
  const start = Math.min(left.start, right.start);
  const end = Math.max(segmentEnd(left), segmentEnd(right));
  const bytes = new Uint8Array(end - start);
  bytes.set(left.view, left.start - start);
  bytes.set(right.view, right.start - start);
  return { start, view: bytes, capacity: bytes };
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

const holdCounts = new WeakMap<SourceResidency, () => number>();

/**
 * Outstanding claims on the link, for this module's own tests: they drive every
 * way a read can end and assert the count comes back to zero.
 */
export function outstandingForegroundHolds(residency: SourceResidency): number {
  return holdCounts.get(residency)?.() ?? 0;
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
  let disposed = false;
  const warmAborts = new Set<AbortController>();
  const foregroundHolds = new Set<() => void>();

  /* A background chunk shares one connection and one link with the read the
   * viewer is waiting on, so the walk stands down while a read is outstanding
   * rather than lengthening it. A read is outstanding from the request until
   * its body ends, is cancelled, errors, or leaves a chunk unclaimed for
   * FOREGROUND_STALL_MS. */
  const foregroundIdle = (): boolean => foregroundHolds.size === 0;

  /** One read's claim on the link, given back by `release` — idempotent, so
   *  every end of the read can call it. A reader that walks away calls no end
   *  at all, so the claim also lapses on its own: `idle` arms the stall ceiling
   *  once a chunk is delivered, and `pulling` stands it down while the consumer
   *  is waiting on the server. */
  const holdForeground = () => {
    let stall: ReturnType<typeof setTimeout> | undefined;
    const release = (): void => {
      clearTimeout(stall);
      foregroundHolds.delete(release);
    };
    foregroundHolds.add(release);
    return {
      release,
      pulling: () => {
        clearTimeout(stall);
      },
      idle: () => {
        if (!foregroundHolds.has(release)) return;
        clearTimeout(stall);
        stall = setTimeout(release, FOREGROUND_STALL_MS);
      },
    };
  };

  /* The demuxer opens a read as an open-ended range and abandons the response
   * the moment it holds what it asked for, and a stream whose reader walked
   * away runs neither its close nor its cancel in Chrome. */
  const teeInto = (
    start: number,
    response: Response,
    hold: ReturnType<typeof holdForeground>,
  ): Response => {
    if (!response.body) {
      hold.release();
      return response;
    }
    const source = response.body.getReader();
    let blockStart = start;
    let block: Uint8Array[] = [];
    let blockBytes = 0;
    /* Banking allocates, and an allocation that fails would strand the link,
     * so every bank is reached with the claim already given back or its stall
     * ceiling already armed. */
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
    /* A zero high-water mark keeps the wrapper from pulling bytes the reader
     * never asked for, which would be banked out of a range nobody read. */
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          hold.pulling();
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await source.read();
          } catch (error) {
            hold.release();
            throw error;
          }
          if (chunk.done) {
            hold.release();
            bank();
            controller.close();
            return;
          }
          controller.enqueue(chunk.value);
          block.push(chunk.value);
          blockBytes += chunk.value.length;
          hold.idle();
          if (blockBytes >= READ_BLOCK_BYTES) bank();
        },
        cancel(reason) {
          hold.release();
          bank();
          return source.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
    hold.idle();
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
    const hold = holdForeground();
    let response: Response;
    try {
      response = await realFetch(input, init);
    } catch (error) {
      hold.release();
      throw error;
    }
    totalBytes ??= totalFromHeaders(response);
    if (start === null || !response.ok) {
      hold.release();
      return response;
    }
    /* A server that ignores the range answers 200 with the whole file, so
     * what arrives begins at zero whatever was asked for. */
    return teeInto(response.status === 206 ? start : 0, response, hold);
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
        /* A store holding its whole budget cannot take the rest of the file, so
         * the walk is finished rather than waiting for room that never comes. */
        if (store.residentBytes >= options.budgetBytes) {
          warming = false;
          break;
        }
        if (!foregroundIdle()) {
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

  const residency: SourceResidency = {
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
      for (const release of [...foregroundHolds]) release();
      store.clear();
    },
  };
  holdCounts.set(residency, () => foregroundHolds.size);
  return residency;
}
