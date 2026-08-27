import { describe, expect, it, vi } from "vitest";

import { createSourceResidency } from "./source-residency";

const URL_UNDER_TEST = "https://example.test/clip.mov";
const TOTAL = 4096;

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
});
