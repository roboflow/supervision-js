import { describe, expect, it } from "vitest";

import type { DetectionFrame } from "supervision-js";
import { computeDetectionMaskRect } from "supervision-js/editing";

const manifests = import.meta.glob(
  "../../fixtures/*/detections.manifest.json",
  {
    eager: true,
    import: "default",
  },
) as Record<string, Record<string, unknown>>;
const chunks = import.meta.glob("../../fixtures/*/detections/*.json", {
  eager: true,
  import: "default",
}) as Record<string, { readonly frames: readonly DetectionFrame[] }>;

describe("SAM3 fixture geometry", () => {
  it("uses center-based rects for deterministic fixture mask samples", () => {
    for (const manifest of Object.values(manifests)) {
      expect(manifest).not.toHaveProperty("rectCoordinateConvention");
    }

    for (const chunk of representativeChunks(chunks)) {
      const detection = findFirstMaskedDetection(chunk);

      if (!detection?.mask || !detection.rect) continue;
      expect(detection.rect).toEqual(computeDetectionMaskRect(detection.mask));
    }
  });
});

function representativeChunks(
  allChunks: Record<string, { readonly frames: readonly DetectionFrame[] }>,
) {
  const chunksByFixture = new Map<
    string,
    Array<{ readonly chunk: (typeof allChunks)[string]; readonly path: string }>
  >();

  for (const [path, chunk] of Object.entries(allChunks)) {
    const fixturePath = path.replace(/\/detections\/[^/]+$/, "");
    const fixtureChunks = chunksByFixture.get(fixturePath) ?? [];
    fixtureChunks.push({ chunk, path });
    chunksByFixture.set(fixturePath, fixtureChunks);
  }

  return [...chunksByFixture.values()].flatMap((fixtureChunks) => {
    const sorted = [...fixtureChunks].sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    const indexes = new Set([
      0,
      Math.floor(sorted.length / 2),
      sorted.length - 1,
    ]);

    return [...indexes].flatMap((index) => sorted[index]?.chunk ?? []);
  });
}

function findFirstMaskedDetection(chunk: {
  readonly frames: readonly DetectionFrame[];
}) {
  for (const frame of chunk.frames) {
    const detection = frame.detections.find(
      (candidate) => candidate.mask && candidate.rect,
    );
    if (detection) return detection;
  }

  return undefined;
}
