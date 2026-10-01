import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fakeProbeClip,
  openFakeDepthPreviewTrack,
  type FakeDecoderBehaviour,
} from "../../../../test/fake-video-decoder";
import type {
  DepthPreviewTrackInput,
  DepthPreviewTrackOptions,
} from "./depth-preview-track";

const asWritten = (code: number) => code;
const squeeze = (code: number) => Math.round(16 + (code * 219) / 255);
/** TV range converted to full-range RGB, as Firefox hands frames over. */
const expand = (code: number) =>
  Math.min(255, Math.max(0, Math.round(((code - 16) * 255) / 219)));
const supported = async () => true;

describe("depth preview probe", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("corrects a squeeze to within a code, and gives no depth back to code 0", async () => {
    const { createCodeCorrection } = await import("./depth-preview-probe");
    const decoded = Uint8Array.from({ length: 256 }, (_, code) =>
      squeeze(code),
    );
    const table = createCodeCorrection(decoded);

    expect(table[16]).toBe(0);
    expect(table[235]).toBe(255);
    for (let code = 0; code < 256; code += 1) {
      expect(Math.abs(table[decoded[code]] - code)).toBeLessThanOrEqual(1);
    }
  });

  it.each([
    { levels: "full", first: "prefer-software", decode: asWritten },
    {
      levels: "tv",
      first: "prefer-hardware",
      // Footroom and headroom clamp to black and white, as an RGB path does.
      decode: (code: number) => Math.min(235, Math.max(16, code)),
    },
  ] as const)(
    "probes a $levels-range preview's $first decoder first, and stops there when it is exact",
    async ({ levels, first, decode }) => {
      const { chooseDepthPreviewDecoding } =
        await import("./depth-preview-probe");
      const opened: (HardwareAcceleration | undefined)[] = [];
      const decoding = await chooseDepthPreviewDecoding(
        levels,
        probeThrough((preference) => {
          opened.push(preference);
          return { behaviour: "outputs", decode };
        }),
        supported,
      );

      expect(opened).toEqual([first]);
      expect(decoding).toMatchObject({
        correction: null,
        hardwareAcceleration: first,
        residualError: 0,
      });
    },
  );

  it("without an exact decoder, picks the closest after correction", async () => {
    const { chooseDepthPreviewDecoding } =
      await import("./depth-preview-probe");
    const decoding = await chooseDepthPreviewDecoding(
      "full",
      probeThrough((preference) => ({
        behaviour: "outputs",
        decode:
          preference === "prefer-software"
            ? (code) => (code % 7 === 4 ? code - 1 : code)
            : squeeze,
      })),
      supported,
    );

    // Collisions cannot be undone, so off by one stays off by one; a squeeze
    // corrects to within one as well, and the first of equals wins.
    expect(decoding.hardwareAcceleration).toBe("prefer-software");
    expect(decoding.residualError).toBe(1);
  });

  it("undoes a TV-range decoder's RGB conversion exactly, without asking another", async () => {
    const { chooseDepthPreviewDecoding } =
      await import("./depth-preview-probe");
    const opened: (HardwareAcceleration | undefined)[] = [];
    const decoding = await chooseDepthPreviewDecoding(
      "tv",
      probeThrough((preference) => {
        opened.push(preference);
        return { behaviour: "outputs", decode: expand };
      }),
      supported,
    );

    expect(opened).toEqual(["prefer-hardware"]);
    expect(decoding.residualError).toBe(0);
    for (let code = 16; code <= 235; code += 1) {
      expect(decoding.correction?.[expand(code)]).toBe(code);
    }
    // Black and below stay at the lowest TV code, which is no depth.
    expect(decoding.correction?.[0]).toBe(16);
  });

  it("moves on from a decoder that refuses its configuration to the next", async () => {
    const { chooseDepthPreviewDecoding } =
      await import("./depth-preview-probe");
    const decoding = await chooseDepthPreviewDecoding(
      "full",
      probeThrough((preference) => ({
        behaviour:
          preference === "prefer-software" ? "refusesConfig" : "outputs",
      })),
      supported,
    );

    expect(decoding.hardwareAcceleration).toBe("prefer-hardware");
    expect(decoding.probe?.exact).toBe(true);
    expect(decoding.verdicts[0]).toMatchObject({
      error: expect.stringContaining("No decoder takes this configuration."),
      hardwareAcceleration: "prefer-software",
      probe: null,
    });
  });

  it("gives up on a decoder that never returns a frame, and names none when every one is like it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });

    try {
      const { chooseDepthPreviewDecoding } =
        await import("./depth-preview-probe");
      const choosing = chooseDepthPreviewDecoding(
        "full",
        probeThrough(() => ({ behaviour: "silent" })),
        supported,
      );

      await vi.advanceTimersByTimeAsync(10_000);

      const decoding = await choosing;

      expect(decoding).toMatchObject({
        hardwareAcceleration: "no-preference",
        probe: null,
      });
      expect(decoding.verdicts.map(({ error }) => error)).toEqual([
        "Error: The depth preview decoder returned no frame for 3 s of a flush.",
        "Error: The depth preview decoder returned no frame for 3 s of a flush.",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("probes each level once per page, apart", async () => {
    const { chooseDepthPreviewDecoding } =
      await import("./depth-preview-probe");
    const probed: number[] = [];
    const open = probeThrough(() => ({ behaviour: "outputs" }));
    const openTrack = async (
      input: DepthPreviewTrackInput,
      options?: DepthPreviewTrackOptions,
    ) => {
      probed.push((input as Uint8Array).length);
      return open(input, options);
    };

    const tv = await chooseDepthPreviewDecoding("tv", openTrack, supported);
    await chooseDepthPreviewDecoding("full", openTrack, supported);

    expect(await chooseDepthPreviewDecoding("tv", openTrack, supported)).toBe(
      tv,
    );
    expect(probed).toHaveLength(2);
    expect(probed[0]).not.toBe(probed[1]);
  });

  it.each([
    { levels: "full", fullRange: true },
    { levels: "tv", fullRange: false },
  ] as const)(
    "ships a $levels-range probe clip Mediabunny reads as two 256x256 H.264 frames",
    async ({ levels, fullRange }) => {
      const { depthPreviewProbeBytes } = await import("./depth-preview-probe");
      const { BufferSource, EncodedPacketSink, Input, MP4 } =
        await vi.importActual<typeof import("mediabunny")>("mediabunny");
      const input = new Input({
        formats: [MP4],
        source: new BufferSource(depthPreviewProbeBytes(levels)),
      });
      const track = (await input.getPrimaryVideoTrack())!;
      const packets = [];

      for await (const packet of new EncodedPacketSink(track).packets()) {
        packets.push(packet);
      }

      expect(await track.getCodecParameterString()).toBe("avc1.64000d");
      expect([
        await track.getCodedWidth(),
        await track.getCodedHeight(),
      ]).toEqual([256, 256]);
      expect((await track.getColorSpace()).fullRange).toBe(fullRange);
      expect(packets).toHaveLength(2);
      input.dispose();
    },
  );
});

/**
 * Opens the probe through fake decoders: each preference gets a behaviour,
 * and a decoder that returns each written code as `decode` of it.
 */
function probeThrough(
  decoderFor: (preference: HardwareAcceleration | undefined) => {
    readonly behaviour: FakeDecoderBehaviour;
    readonly decode?: (code: number) => number;
  },
) {
  return async (
    _input: DepthPreviewTrackInput,
    options: DepthPreviewTrackOptions = {},
  ) => {
    const { behaviour, decode } = decoderFor(options.hardwareAcceleration);

    return openFakeDepthPreviewTrack(behaviour, fakeProbeClip(decode), options);
  };
}
