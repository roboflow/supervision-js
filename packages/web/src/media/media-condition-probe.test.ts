import { describe, expect, it } from "vitest";

import {
  readIndexPlacement,
  summarizeTiming,
} from "#media/media-condition-probe";
import { MediaIndexPlacement } from "#types/media-conditions";

interface FakeBox {
  readonly type: string;
  readonly size: number;
  readonly largeSize?: boolean;
}

/** A reader over nothing but top-level box headers at their real offsets, which
 *  is all the walk ever asks for. */
function boxReader(boxes: readonly FakeBox[]) {
  const size = boxes.reduce((total, box) => total + box.size, 0);
  const headers = new Map<number, Uint8Array>();
  let offset = 0;

  for (const box of boxes) {
    const header = new Uint8Array(16);
    const view = new DataView(header.buffer);

    view.setUint32(0, box.largeSize ? 1 : box.size);

    for (let index = 0; index < 4; index += 1) {
      header[4 + index] = box.type.charCodeAt(index);
    }

    if (box.largeSize) {
      view.setBigUint64(8, BigInt(box.size));
    }

    headers.set(offset, header);
    offset += box.size;
  }

  return {
    read: async (start: number, end: number) =>
      (headers.get(start) ?? new Uint8Array(16)).slice(0, end - start),
    size,
  };
}

describe("readIndexPlacement", () => {
  it("reads an index written before the media data", async () => {
    const file = boxReader([
      { size: 32, type: "ftyp" },
      { size: 3731, type: "moov" },
      { size: 187190, type: "mdat" },
    ]);

    await expect(readIndexPlacement(file.read, file.size)).resolves.toBe(
      MediaIndexPlacement.Front,
    );
  });

  it("reads an index written after the media data", async () => {
    const file = boxReader([
      { size: 32, type: "ftyp" },
      { size: 8, type: "free" },
      { size: 187190, type: "mdat" },
      { size: 3731, type: "moov" },
    ]);

    await expect(readIndexPlacement(file.read, file.size)).resolves.toBe(
      MediaIndexPlacement.End,
    );
  });

  it("reads a file whose index is written once per fragment", async () => {
    const file = boxReader([
      { size: 28, type: "ftyp" },
      { size: 695, type: "moov" },
      { size: 584, type: "moof" },
      { size: 34570, type: "mdat" },
    ]);

    await expect(readIndexPlacement(file.read, file.size)).resolves.toBe(
      MediaIndexPlacement.Fragmented,
    );
  });

  it("follows a 64-bit box size past media data larger than four gigabytes", async () => {
    const file = boxReader([
      { size: 32, type: "ftyp" },
      { largeSize: true, size: 5_000_000_000, type: "mdat" },
      { size: 3731, type: "moov" },
    ]);

    await expect(readIndexPlacement(file.read, file.size)).resolves.toBe(
      MediaIndexPlacement.End,
    );
  });

  it("says nothing about a file that does not open with a file-type box", async () => {
    const file = boxReader([
      { size: 64, type: "junk" },
      { size: 64, type: "moov" },
    ]);

    await expect(readIndexPlacement(file.read, file.size)).resolves.toBe(
      MediaIndexPlacement.Unknown,
    );
  });

  it("says nothing about a file too short to hold a box header", async () => {
    await expect(
      readIndexPlacement(async () => new Uint8Array(4), 4),
    ).resolves.toBe(MediaIndexPlacement.Unknown);
  });
});

describe("summarizeTiming", () => {
  it("sorts a decode-order walk before reading the gaps between frames", () => {
    const timing = summarizeTiming([0, 2048, 512, 1024, 1536], 15360, true);

    expect(timing.distinctGapCount).toBe(1);
    expect(timing.medianGapTicks).toBe(512);
    expect(timing.duplicateTimestampCount).toBe(0);
  });

  it("counts frames that share a presentation timestamp", () => {
    const timing = summarizeTiming([0, 3000, 3000, 6000], 90000, true);

    expect(timing.duplicateTimestampCount).toBe(1);
    expect(timing.minGapTicks).toBe(0);
  });

  /**
   * A capped walk stops at a decode position, so the frames a reordered source
   * would have presented after that position were never read. Keeping the
   * sorted table's tail would read the hole they leave as a long gap and call a
   * constant-rate source unsteady.
   */
  it("drops the tail a capped walk left holes in", () => {
    const timing = summarizeTiming([0, 2048, 512, 1024], 15360, false);

    expect(timing.distinctGapCount).toBe(1);
    expect(timing.maxGapTicks).toBe(512);
  });

  it("keeps the whole table when the walk reached the end of the track", () => {
    const timing = summarizeTiming([0, 1024, 512, 2048, 1536], 15360, true);

    expect(timing.sampleComplete).toBe(true);
    expect(timing.sampledPacketCount).toBe(5);
    expect(timing.maxGapTicks).toBe(512);
  });

  it("reports a single-frame track as having no gaps rather than an unsteady one", () => {
    const timing = summarizeTiming([0], 15360, true);

    expect(timing.distinctGapCount).toBe(0);
    expect(timing.medianGapTicks).toBe(0);
  });

  it("records the first presentation timestamp from the sorted table", () => {
    const timing = summarizeTiming([132096, 133120, 132608], 15360, true);

    expect(timing.firstTimestampTicks).toBe(132096);
  });
});
