import { describe, expect, it, vi } from "vitest";

import { RenderPreparationMode } from "#types/render-preparation";
import {
  DetectionMaskEncoding,
  encodeCompressedRleCounts,
} from "supervision-js-core";

import { resetMocks } from "../../../../test/media-renderer-harness";

vi.mock("#render-preparation/mask-frame-compositor", async (importOriginal) => {
  const compositor =
    await importOriginal<
      typeof import("#render-preparation/mask-frame-compositor")
    >();

  return { ...compositor, createIdMaskRasterFrame: () => undefined };
});

const instructions = [
  {
    alpha: 0.5,
    color: 0xff0000,
    detectionIndex: 0,
    mask: {
      counts: encodeCompressedRleCounts([0, 32]),
      encoding: DetectionMaskEncoding.CompressedRle,
      height: 4,
      width: 8,
    },
  },
];

describe("mask frame preparer under an ID raster failure", () => {
  it("caps the ID plane it carries beside the RGBA composite", async () => {
    resetMocks();

    const { createMaskFramePreparer } = await import("./mask-frame-preparer");
    const { PreparedMaskFrameKind } = await import("./mask-frame-artifact");
    const preparer = createMaskFramePreparer({
      renderPreparation: { mode: RenderPreparationMode.MainThread },
    });

    await expect(
      preparer.prepare({ instructions, key: "0:0", maxRasterWidth: 4 }),
    ).resolves.toMatchObject({
      height: 4,
      idMaskPlane: { height: 2, width: 4 },
      kind: PreparedMaskFrameKind.RgbaImage,
      width: 8,
    });

    preparer.destroy();
  });
});
