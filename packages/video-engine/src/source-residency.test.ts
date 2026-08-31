import { describe, expect, it, vi } from "vitest";

import {
  FOREGROUND_STALL_MS,
  READ_BLOCK_BYTES,
  createSourceResidency,
} from "./source-residency";

const URL_UNDER_TEST = "https://example.test/clip.mov";
const TOTAL = 4096;
/* Sized off the block the residency banks in, so an abandoned read stops on
 * a block boundary and the counts below are exact. */
const PIECE = READ_BLOCK_BYTES / 8;
const ABANDON_AT = READ_BLOCK_BYTES * 2;
const STREAMED_TOTAL = READ_BLOCK_BYTES * 6;

const body = (start: number, length: number): Uint8Array<ArrayBuffer> =>
  Uint8Array.from({ length }, (_, index) => (start + index) % 251);

function networkFetch(total = TOTAL) {
  return vi.fn(async (_input: unknown, init?: RequestInit) => {
    const header = new Headers(init?.headers ?? undefined).get("Range");
    const match = header ? /^bytes=(\d+)-(\d*)$/.exec(header) : null;
    const start = match ? Number(match[1]) : 0;
    const end = match && match[2] ? Number(match[2]) : total - 1;
    const bytes = body(start, end - start + 1);
    return new Response(bytes, {
      status: match ? 206 : 200,
      headers: {
        "Content-Length": String(bytes.length),
        "Content-Range": `bytes ${start}-${end}/${total}`,
      },
    });
  }) as unknown as typeof fetch;
}

const read = async (response: Response): Promise<Uint8Array> =>
  new Uint8Array(await response.arrayBuffer());

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Serves a range in pieces, so a reader can walk away part-way through one.
 *  `pieceDelayMs` is the server's own latency ahead of each piece. */
function pieceFetch(total: number, pieceBytes: number, pieceDelayMs = 0) {
  let served = 0;
  let requestCount = 0;
  const impl = async (_input: unknown, init?: RequestInit) => {
    requestCount += 1;
    const header = new Headers(init?.headers ?? undefined).get("Range");
    const match = header ? /^bytes=(\d+)-(\d*)$/.exec(header) : null;
    const start = match ? Number(match[1]) : 0;
    const end = match && match[2] ? Number(match[2]) : total - 1;
    let cursor = start;
    /* A zero high-water mark keeps the fake network from producing a piece
     * nobody read, so the byte counts below describe the reads themselves. */
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const length = Math.min(pieceBytes, end + 1 - cursor);
          if (length <= 0) {
            controller.close();
            return;
          }
          if (pieceDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, pieceDelayMs));
          }
          controller.enqueue(body(cursor, length));
          cursor += length;
          served += length;
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(stream, {
      status: 206,
      headers: {
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${total}`,
      },
    });
  };
  return {
    fetchImpl: impl as unknown as typeof fetch,
    servedBytes: () => served,
    requests: () => requestCount,
  };
}

/** Reads a body to its end, which is what makes the residency bank it. A
 *  stream-served body drained this way copies nothing itself, so a copy count
 *  taken around it is the residency's own. */
const drain = async (response: Response): Promise<void> => {
  const reader = response.body!.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
};

/** The demuxer abandons a read once it holds what it asked for; this is that. */
async function abandonAfter(response: Response, bytes: number): Promise<void> {
  const reader = response.body!.getReader();
  let read = 0;
  while (read < bytes) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.length;
  }
  await reader.cancel();
}

/** A server with no range support: it answers every request with the whole
 *  file and a 200. */
function wholeFileFetch(total = TOTAL) {
  return vi.fn(
    async () =>
      new Response(body(0, total), {
        status: 200,
        headers: { "Content-Length": String(total) },
      }),
  ) as unknown as typeof fetch;
}

/** Bytes moved by every `Uint8Array.prototype.set` call while it is installed. */
function countCopiedBytes(): {
  copied: () => number;
  restore: () => void;
} {
  const original = Uint8Array.prototype.set;
  let copied = 0;
  Uint8Array.prototype.set = function set(
    source: ArrayLike<number>,
    offset?: number,
  ): void {
    copied += source.length;
    original.call(this, source, offset);
  };
  return {
    copied: () => copied,
    restore: () => {
      Uint8Array.prototype.set = original;
    },
  };
}

/** A link slow enough that every gap between chunks outlasts the stall ceiling,
 *  so a walk that reads server latency as an abandoned body issues a request of
 *  its own part-way through the reads below. */
const SLOW_PIECE_MS = FOREGROUND_STALL_MS + 100;

describe("createSourceResidency", () => {
  it("serves a repeat read from what the first read left behind", async () => {
    const network = networkFetch();
    const residency = createSourceResidency({
      url: URL_UNDER_TEST,
      budgetBytes: TOTAL,
      fetchImpl: network,
    });

    const first = await residency.fetchFn(URL_UNDER_TEST, {
      headers: { Range: "bytes=1024-2047" },
    });
    expect(await read(first)).toEqual(body(1024, 1024));
    await settle();

    const second = await residency.fetchFn(URL_UNDER_TEST, {
      headers: { Range: "bytes=1024-" },
    });
    expect(second.status).toBe(206);
    expect(await read(second)).toEqual(body(1024, 1024));
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("serves the held prefix of a read and leaves the rest to the network", async () => {
    const network = networkFetch();
    const residency = createSourceResidency({
      url: URL_UNDER_TEST,
      budgetBytes: TOTAL,
      fetchImpl: network,
    });

    await read(
      await residency.fetchFn(URL_UNDER_TEST, {
        headers: { Range: "bytes=0-511" },
      }),
    );
    await settle();

    const served = await residency.fetchFn(URL_UNDER_TEST, {
      headers: { Range: "bytes=0-" },
    });
    expect(served.headers.get("Content-Range")).toBe(`bytes 0-511/${TOTAL}`);
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("reports the runs it holds and what they cover", async () => {
    const residency = createSourceResidency({
      url: URL_UNDER_TEST,
      budgetBytes: TOTAL,
      fetchImpl: networkFetch(),
    });

    await read(
      await residency.fetchFn(URL_UNDER_TEST, {
        headers: { Range: "bytes=2048-3071" },
      }),
    );
    await settle();

    const snapshot = residency.snapshot();
    expect(snapshot.ranges).toEqual([{ start: 2048, end: 3072 }]);
    expect(snapshot.residentBytes).toBe(1024);
    expect(snapshot.totalBytes).toBe(TOTAL);
  });

  it("merges touching runs into one", async () => {
    const residency = createSourceResidency({
      url: URL_UNDER_TEST,
      budgetBytes: TOTAL,
      fetchImpl: networkFetch(),
    });

    for (const range of ["bytes=0-511", "bytes=512-1023"]) {
      await read(
        await residency.fetchFn(URL_UNDER_TEST, { headers: { Range: range } }),
      );
      await settle();
    }

    expect(residency.snapshot().ranges).toEqual([{ start: 0, end: 1024 }]);
  });

  it("walks the file in the background until every byte is held", async () => {
    const network = networkFetch();
    const residency = createSourceResidency({
      url: URL_UNDER_TEST,
      budgetBytes: TOTAL,
      chunkBytes: 1024,
      fetchImpl: network,
    });

    await read(
      await residency.fetchFn(URL_UNDER_TEST, {
        headers: { Range: "bytes=0-1023" },
      }),
    );
    await settle();

    residency.startWarming();
    await vi.waitFor(() => {
      expect(residency.snapshot().residentBytes).toBe(TOTAL);
    });
    expect(residency.snapshot().ranges).toEqual([{ start: 0, end: TOTAL }]);
    expect(residency.snapshot().prefetchedBytes).toBe(TOTAL - 1024);
  });

  it("stops warming once the budget is full instead of polling for room", async () => {
    const residency = createSourceResidency({
      url: URL_UNDER_TEST,
      budgetBytes: 2048,
      fetchImpl: networkFetch(),
    });

    await read(
      await residency.fetchFn(URL_UNDER_TEST, {
        headers: { Range: "bytes=0-1023" },
      }),
    );
    await settle();

    residency.startWarming();
    await vi.waitFor(() => {
      expect(residency.snapshot().warming).toBe(false);
    });

    const settledSnapshot = residency.snapshot();
    expect(settledSnapshot.residentBytes).toBeLessThanOrEqual(2048);

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(residency.snapshot().warming).toBe(false);
    expect(residency.snapshot().prefetchedBytes).toBe(
      settledSnapshot.prefetchedBytes,
    );
  });

  it("drops the runs furthest from the focus offset when the budget is met", async () => {
    const residency = createSourceResidency({
      url: URL_UNDER_TEST,
      budgetBytes: 2048,
      fetchImpl: networkFetch(),
    });

    residency.focusAt(3072);
    for (const range of [
      "bytes=0-1023",
      "bytes=2048-3071",
      "bytes=3072-4095",
    ]) {
      await read(
        await residency.fetchFn(URL_UNDER_TEST, { headers: { Range: range } }),
      );
      await settle();
    }

    expect(residency.snapshot().ranges).toEqual([{ start: 2048, end: 4096 }]);
  });

  it("holds what a read delivered before its reader walked away", async () => {
    const network = pieceFetch(STREAMED_TOTAL, PIECE);
    const residency = createSourceResidency({
      url: URL_UNDER_TEST,
      budgetBytes: STREAMED_TOTAL,
      fetchImpl: network.fetchImpl,
    });

    await abandonAfter(
      await residency.fetchFn(URL_UNDER_TEST, {
        headers: { Range: "bytes=0-" },
      }),
      ABANDON_AT,
    );
    await settle();

    expect(residency.snapshot().ranges).toEqual([
      { start: 0, end: ABANDON_AT },
    ]);
  });

  it("does not pull a second time what an abandoned read already delivered", async () => {
    const network = pieceFetch(STREAMED_TOTAL, PIECE);
    const residency = createSourceResidency({
      url: URL_UNDER_TEST,
      budgetBytes: STREAMED_TOTAL,
      chunkBytes: READ_BLOCK_BYTES,
      fetchImpl: network.fetchImpl,
    });

    await abandonAfter(
      await residency.fetchFn(URL_UNDER_TEST, {
        headers: { Range: "bytes=0-" },
      }),
      ABANDON_AT,
    );
    await settle();

    residency.startWarming();
    await vi.waitFor(() => {
      expect(residency.snapshot().residentBytes).toBe(STREAMED_TOTAL);
    });
    expect(network.servedBytes()).toBe(STREAMED_TOTAL);
  });

  it("holds the walk down until a foreground body is read to its end", async () => {
    const network = pieceFetch(STREAMED_TOTAL, PIECE, SLOW_PIECE_MS);
    const residency = createSourceResidency({
      url: URL_UNDER_TEST,
      budgetBytes: STREAMED_TOTAL,
      chunkBytes: PIECE,
      fetchImpl: network.fetchImpl,
    });

    const response = await residency.fetchFn(URL_UNDER_TEST, {
      headers: { Range: `bytes=0-${PIECE * 3 - 1}` },
    });
    residency.startWarming();
    const reader = response.body!.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      expect(network.requests()).toBe(1);
    }

    await vi.waitFor(
      () => {
        expect(residency.snapshot().prefetchedBytes).toBeGreaterThan(0);
      },
      { timeout: SLOW_PIECE_MS * 4 },
    );
  });

  it("gives the walk back the link when a foreground body is cancelled", async () => {
    const network = pieceFetch(STREAMED_TOTAL, PIECE, SLOW_PIECE_MS);
    const residency = createSourceResidency({
      url: URL_UNDER_TEST,
      budgetBytes: STREAMED_TOTAL,
      chunkBytes: PIECE,
      fetchImpl: network.fetchImpl,
    });

    const response = await residency.fetchFn(URL_UNDER_TEST, {
      headers: { Range: "bytes=0-" },
    });
    residency.startWarming();
    const reader = response.body!.getReader();
    for (let piece = 0; piece < 2; piece += 1) {
      await reader.read();
      expect(network.requests()).toBe(1);
    }

    await reader.cancel();

    await vi.waitFor(
      () => {
        expect(residency.snapshot().prefetchedBytes).toBeGreaterThan(0);
      },
      { timeout: SLOW_PIECE_MS * 4 },
    );
  });

  it("keeps the link for a read whose consumer is still pulling", async () => {
    const network = pieceFetch(STREAMED_TOTAL, PIECE, SLOW_PIECE_MS);
    const residency = createSourceResidency({
      url: URL_UNDER_TEST,
      budgetBytes: STREAMED_TOTAL,
      chunkBytes: PIECE,
      fetchImpl: network.fetchImpl,
    });

    const response = await residency.fetchFn(URL_UNDER_TEST, {
      headers: { Range: "bytes=0-" },
    });
    residency.startWarming();
    const reader = response.body!.getReader();
    for (let piece = 0; piece < 2; piece += 1) await reader.read();

    expect(network.requests()).toBe(1);
    expect(residency.snapshot().prefetchedBytes).toBe(0);
    /* A walk left pulling on this slow link would still be banking bytes while
     * a later test counts copies. */
    residency.dispose();
  });

  it("gives the walk back the link when a foreground reader walks away", async () => {
    const network = pieceFetch(STREAMED_TOTAL, PIECE);
    const residency = createSourceResidency({
      url: URL_UNDER_TEST,
      budgetBytes: STREAMED_TOTAL,
      chunkBytes: READ_BLOCK_BYTES,
      fetchImpl: network.fetchImpl,
    });

    const response = await residency.fetchFn(URL_UNDER_TEST, {
      headers: { Range: `bytes=0-${READ_BLOCK_BYTES - 1}` },
    });
    residency.startWarming();
    await response.body!.getReader().read();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(residency.snapshot().prefetchedBytes).toBe(0);

    await vi.waitFor(() => {
      expect(residency.snapshot().prefetchedBytes).toBeGreaterThan(0);
    });
  });

  it("gives the walk back the link when a foreground request fails", async () => {
    const network = pieceFetch(STREAMED_TOTAL, PIECE);
    let failing = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (failing) throw new Error("network down");
      return network.fetchImpl(input, init);
    };
    const residency = createSourceResidency({
      url: URL_UNDER_TEST,
      budgetBytes: STREAMED_TOTAL,
      chunkBytes: READ_BLOCK_BYTES,
      fetchImpl,
    });

    await drain(
      await residency.fetchFn(URL_UNDER_TEST, {
        headers: { Range: `bytes=0-${READ_BLOCK_BYTES - 1}` },
      }),
    );
    await settle();

    failing = true;
    await expect(
      residency.fetchFn(URL_UNDER_TEST, {
        headers: { Range: `bytes=${READ_BLOCK_BYTES}-` },
      }),
    ).rejects.toThrow("network down");
    failing = false;

    residency.startWarming();
    await vi.waitFor(() => {
      expect(residency.snapshot().prefetchedBytes).toBeGreaterThan(0);
    });
  });

  it("places a body the server did not range-satisfy at the start of the file", async () => {
    const residency = createSourceResidency({
      url: URL_UNDER_TEST,
      budgetBytes: TOTAL,
      fetchImpl: wholeFileFetch(),
    });

    await read(
      await residency.fetchFn(URL_UNDER_TEST, {
        headers: { Range: "bytes=1024-" },
      }),
    );
    await settle();

    expect(residency.snapshot().ranges).toEqual([{ start: 0, end: TOTAL }]);
  });

  it("holds no more than the budget after one sequential read", async () => {
    const total = 16 * 1024;
    const budget = 4 * 1024;
    const residency = createSourceResidency({
      url: URL_UNDER_TEST,
      budgetBytes: budget,
      fetchImpl: networkFetch(total),
    });

    await read(
      await residency.fetchFn(URL_UNDER_TEST, {
        headers: { Range: `bytes=0-${total - 1}` },
      }),
    );
    await settle();

    expect(residency.snapshot().residentBytes).toBeLessThanOrEqual(budget);
    expect(residency.snapshot().ranges).toEqual([{ start: 0, end: budget }]);
  });

  it("keeps the window at the focus offset when it narrows a run", async () => {
    const total = 16 * 1024;
    const budget = 4 * 1024;
    const network = networkFetch(total);
    const residency = createSourceResidency({
      url: URL_UNDER_TEST,
      budgetBytes: budget,
      fetchImpl: network,
    });

    residency.focusAt(8192);
    await read(
      await residency.fetchFn(URL_UNDER_TEST, {
        headers: { Range: `bytes=0-${total - 1}` },
      }),
    );
    await settle();

    expect(residency.snapshot().ranges).toEqual([{ start: 8192, end: 12288 }]);
    const served = await residency.fetchFn(URL_UNDER_TEST, {
      headers: { Range: "bytes=8192-" },
    });
    expect(await read(served)).toEqual(body(8192, budget));
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("banks a run of sequential reads without recopying what it holds", async () => {
    const reads = 2000;
    const readBytes = 2 * 1024;
    const total = reads * readBytes;
    const residency = createSourceResidency({
      url: URL_UNDER_TEST,
      budgetBytes: total,
      fetchImpl: pieceFetch(total, readBytes).fetchImpl,
    });

    const copies = countCopiedBytes();
    try {
      for (let index = 0; index < reads; index += 1) {
        const start = index * readBytes;
        await drain(
          await residency.fetchFn(URL_UNDER_TEST, {
            headers: { Range: `bytes=${start}-${start + readBytes - 1}` },
          }),
        );
        await settle();
      }
    } finally {
      copies.restore();
    }

    const { residentBytes } = residency.snapshot();
    expect(residentBytes).toBe(total);
    expect(copies.copied()).toBeLessThan(4 * residentBytes);
  });

  it("holds nothing once disposed", async () => {
    const residency = createSourceResidency({
      url: URL_UNDER_TEST,
      budgetBytes: TOTAL,
      fetchImpl: networkFetch(),
    });

    await read(
      await residency.fetchFn(URL_UNDER_TEST, {
        headers: { Range: "bytes=0-1023" },
      }),
    );
    await settle();
    residency.dispose();

    expect(residency.snapshot().residentBytes).toBe(0);
  });

  it("leaves no stall ceiling running for a read still open at dispose", async () => {
    vi.useFakeTimers();
    try {
      const residency = createSourceResidency({
        url: URL_UNDER_TEST,
        budgetBytes: STREAMED_TOTAL,
        fetchImpl: pieceFetch(STREAMED_TOTAL, PIECE).fetchImpl,
      });

      await residency.fetchFn(URL_UNDER_TEST, {
        headers: { Range: "bytes=0-" },
      });
      expect(vi.getTimerCount()).toBe(1);

      residency.dispose();

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
