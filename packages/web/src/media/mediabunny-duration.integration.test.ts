import { durationFixtures } from "../../../../test/fixtures/video-duration/data";
import { BufferSource, Input, MP4 } from "mediabunny";
import { describe, expect, it } from "vitest";
import { openMediabunnyMediaSource } from "./mediabunny-media-source";
import { collectInputMetadata } from "./media-metadata";

async function fixture(name: string, headerSeconds?: number) {
  const data = Uint8Array.from(atob(durationFixtures[name]!), (char) =>
    char.charCodeAt(0),
  );
  if (headerSeconds !== undefined) {
    const type = data.findIndex(
      (_, i) => String.fromCharCode(...data.subarray(i, i + 4)) === "mdhd",
    );
    if (type < 0 || data[type + 4] !== 0)
      throw new Error("Expected a version-0 mdhd in the synthetic fixture");
    const view = new DataView(data.buffer);
    const timescale = view.getUint32(type + 16);
    view.setUint32(type + 20, Math.round(headerSeconds * timescale));
  }
  return data;
}

describe("real MP4 parser duration", () => {
  it.each([undefined, 0.113333, 102])(
    "renders the entire finite VFR track with header duration %s",
    async (header) => {
      const data = await fixture("finite-vfr", header);
      const source = await openMediabunnyMediaSource({
        source: new BufferSource(data),
        formats: [MP4],
      });
      try {
        expect(source.metadata.duration).toBeCloseTo(3.4, 6);
        expect(source.metadata.firstTimestamp).toBe(0);
        const input = new Input({
          source: new BufferSource(data),
          formats: [MP4],
        });
        try {
          const approximate = await input.getDurationFromMetadata();
          expect(approximate).toBeCloseTo(header ?? 3.4, 4);
          const probe = await collectInputMetadata(
            input,
            new Blob([new Uint8Array(data)]),
          );
          expect(probe.duration).toBeCloseTo(3.4, 6);
        } finally {
          input.dispose();
        }
      } finally {
        source.input.dispose();
      }
    },
  );
  it("keeps the edit-list offset and returns a span, not an absolute end", async () => {
    const source = await openMediabunnyMediaSource({
      source: new BufferSource(await fixture("offset-vfr")),
      formats: [MP4],
    });
    try {
      expect(source.metadata.firstTimestamp).toBe(2);
      expect(source.metadata.duration).toBeCloseTo(3.4, 6);
      expect(
        source.metadata.firstTimestamp + source.metadata.duration!,
      ).toBeCloseTo(5.4, 6);
    } finally {
      source.input.dispose();
    }
  });
});
