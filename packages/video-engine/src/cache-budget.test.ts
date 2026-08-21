import { describe, expect, it, vi } from "vitest";

import { resolveCacheBudgets } from "./cache-budget";
import { FRAME_CACHE } from "./constants";

function withDeviceMemory(gb: number | undefined, fn: () => void): void {
  vi.stubGlobal("navigator", { deviceMemory: gb });
  try {
    fn();
  } finally {
    vi.unstubAllGlobals();
  }
}

/**
 * A square 8MP source decoded to 1704x1704, where a crisp slot costs 11.6MB. At
 * that size the exact tier's slot floor outgrows its byte band even on the 32GB
 * machine assumed here.
 */
const SQUARE_8MP = {
  decodeWidth: 1704,
  decodeHeight: 1704,
  deviceMemoryGb: 32,
};
const SQUARE_8MP_SLOT_BYTES = 1704 * 1704 * 4;
/** The same source decoded native, the largest crisp slot the runtime allocates
 *  at 32.3MB, and the case the resident ceiling has to hold for. */
const NATIVE_8MP = { decodeWidth: 2840, decodeHeight: 2840 };
const PREVIEW_SLOT_BYTES = 320 * 320 * 4;
/** A portrait source decoded to a mid-size box, where a 320px preview slot costs
 *  0.52MiB and a 960px one costs 4.71MiB. */
const PORTRAIT_DECODE = { decodeWidth: 637, decodeHeight: 854 };

function previewBudgetBytes(gb: number): number {
  return Math.min(
    FRAME_CACHE.PREVIEW_BUDGET_BYTES_MAX,
    Math.max(
      FRAME_CACHE.PREVIEW_BUDGET_BYTES_MIN,
      gb * FRAME_CACHE.PREVIEW_BUDGET_BYTES_PER_GB,
    ),
  );
}

function previewSlotBytes(
  decodeWidth: number,
  decodeHeight: number,
  previewWidth: number,
): number {
  const aspect = decodeWidth / decodeHeight;
  return previewWidth * Math.round(previewWidth / aspect) * 4;
}

const RESIDENCY_CASES: Array<[number, number]> = [1, 4, 8, 32].flatMap((gb) =>
  [320, 480, 640, 960, 1280].map((previewWidth): [number, number] => [
    gb,
    previewWidth,
  ]),
);

describe("resolveCacheBudgets", () => {
  it("scales the exact budget with device memory", () => {
    withDeviceMemory(4, () => {
      expect(resolveCacheBudgets(1280, 720, 320).exactBudgetBytes).toBe(
        4 * FRAME_CACHE.EXACT_BUDGET_BYTES_PER_GB,
      );
    });
  });

  it("clamps the exact budget to the ceiling on a huge-memory device", () => {
    withDeviceMemory(64, () => {
      expect(resolveCacheBudgets(1280, 720, 320).exactBudgetBytes).toBe(
        FRAME_CACHE.EXACT_BUDGET_BYTES_MAX,
      );
    });
  });

  it("floors the exact budget on a low-memory device", () => {
    withDeviceMemory(1, () => {
      expect(resolveCacheBudgets(1280, 720, 320).exactBudgetBytes).toBe(
        FRAME_CACHE.EXACT_BUDGET_BYTES_MIN,
      );
    });
  });

  it("falls back to the default device memory when the API is absent", () => {
    withDeviceMemory(undefined, () => {
      expect(resolveCacheBudgets(1280, 720, 320).exactBudgetBytes).toBe(
        FRAME_CACHE.DEFAULT_DEVICE_MEMORY_GB *
          FRAME_CACHE.EXACT_BUDGET_BYTES_PER_GB,
      );
    });
  });

  it("a big square frame gets fewer preview slots than a small 16:9 frame", () => {
    withDeviceMemory(4, () => {
      const square = resolveCacheBudgets(2840, 2840, 320).previewCapacity;
      const wide = resolveCacheBudgets(1280, 720, 320).previewCapacity;
      expect(square).toBeLessThan(wide);
      expect(wide).toBeLessThanOrEqual(FRAME_CACHE.PREVIEW_SLOTS_MAX);
    });
  });

  it("clamps preview slots to the ceiling for a tiny frame", () => {
    withDeviceMemory(8, () => {
      expect(resolveCacheBudgets(320, 4, 320).previewCapacity).toBe(
        FRAME_CACHE.PREVIEW_SLOTS_MAX,
      );
    });
  });

  it("an 8MP source gets the scrub prefetch window and no crisp slots past it", () => {
    withDeviceMemory(SQUARE_8MP.deviceMemoryGb, () => {
      const { exactBudgetBytes } = resolveCacheBudgets(
        SQUARE_8MP.decodeWidth,
        SQUARE_8MP.decodeHeight,
        320,
      );
      expect(Math.floor(exactBudgetBytes / SQUARE_8MP_SLOT_BYTES)).toBe(
        FRAME_CACHE.MIN_EXACT_SLOTS,
      );
    });
  });

  it.each(RESIDENCY_CASES)(
    "holds preview residency inside its byte budget at %iGB with a %ipx preview",
    (gb, previewWidth) => {
      withDeviceMemory(gb, () => {
        const { previewCapacity } = resolveCacheBudgets(
          PORTRAIT_DECODE.decodeWidth,
          PORTRAIT_DECODE.decodeHeight,
          previewWidth,
        );
        const resident =
          previewCapacity *
          previewSlotBytes(
            PORTRAIT_DECODE.decodeWidth,
            PORTRAIT_DECODE.decodeHeight,
            previewWidth,
          );
        expect(resident).toBeLessThanOrEqual(previewBudgetBytes(gb));
      });
    },
  );

  it("a 3x wider preview frame buys about a ninth as many slots", () => {
    withDeviceMemory(32, () => {
      expect(
        resolveCacheBudgets(
          PORTRAIT_DECODE.decodeWidth,
          PORTRAIT_DECODE.decodeHeight,
          320,
        ).previewCapacity,
      ).toBe(183);
      expect(
        resolveCacheBudgets(
          PORTRAIT_DECODE.decodeWidth,
          PORTRAIT_DECODE.decodeHeight,
          960,
        ).previewCapacity,
      ).toBe(20);
    });
  });

  it("the smallest preview budget holds only what it can pay for", () => {
    withDeviceMemory(1, () => {
      expect(
        resolveCacheBudgets(
          PORTRAIT_DECODE.decodeWidth,
          PORTRAIT_DECODE.decodeHeight,
          320,
        ).previewCapacity,
      ).toBe(45);
    });
  });

  it("a native 8MP source keeps its whole resident cache under half a gigabyte", () => {
    withDeviceMemory(8, () => {
      const { exactBudgetBytes, previewCapacity } = resolveCacheBudgets(
        NATIVE_8MP.decodeWidth,
        NATIVE_8MP.decodeHeight,
        320,
      );
      const resident = exactBudgetBytes + previewCapacity * PREVIEW_SLOT_BYTES;
      expect(resident).toBeLessThan(512 * 1024 * 1024);
    });
  });
});
