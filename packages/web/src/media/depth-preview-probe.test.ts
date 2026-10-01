import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fakeProbeClip,
  openFakeDepthPreviewTrack,
  type FakeDecoderBehaviour,
} from "../../../../test/fake-video-decoder";
import type {
  DepthPreviewTrackInput,
  DepthPreviewTrackOptions,
  DepthPreviewTrackReader,
} from "./depth-preview-track";

/** A decoded probe frame: every code c as a 16x16 block, through `decode`. */
function probeLuma(decode: (code: number) => number) {
  const luma = new Uint8Array(256 * 256);

  for (let code = 0; code < 256; code += 1) {
    const top = (code >> 4) * 16;
    const left = (code & 15) * 16;

    for (let y = top; y < top + 16; y += 1) {
      luma.fill(decode(code), y * 256 + left, y * 256 + left + 16);
    }
  }

  return luma;
}

const squeeze = (code: number) => Math.round(16 + (code * 219) / 255);

describe("depth preview probe", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("reads every block of a frame decoded as written", async () => {
    const { readProbeFrame } = await import("./depth-preview-probe");
    const result = readProbeFrame(
      probeLuma((code) => code),
      256,
    );

    expect(result).toMatchObject({
      exact: true,
      maxError: 0,
      mismatchedCodes: 0,
    });
  });

  it("measures a decoder that squeezes full range into video range", async () => {
    const { readProbeFrame } = await import("./depth-preview-probe");
    const result = readProbeFrame(probeLuma(squeeze), 256);

    expect(result.exact).toBe(false);
    expect(result.decoded[0]).toBe(16);
    expect(result.decoded[255]).toBe(235);
    expect(result.maxError).toBe(20);
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

  it("keeps the first decoder that returns codes as written", async () => {
    const { resolveDepthPreviewDecoding } =
      await import("./depth-preview-probe");
    const exact = probe((code) => code);
    const decoding = resolveDepthPreviewDecoding([
      {
        hardwareAcceleration: "prefer-software",
        probe: exact,
        supported: true,
      },
    ]);

    expect(decoding).toMatchObject({
      correction: null,
      hardwareAcceleration: "prefer-software",
      residualError: 0,
    });
  });

  it("without an exact decoder, picks the closest after correction", async () => {
    const { resolveDepthPreviewDecoding } =
      await import("./depth-preview-probe");
    const offByOne = probe((code) => (code % 7 === 4 ? code - 1 : code));
    const squeezed = probe(squeeze);
    const decoding = resolveDepthPreviewDecoding([
      {
        hardwareAcceleration: "prefer-software",
        probe: offByOne,
        supported: true,
      },
      {
        hardwareAcceleration: "prefer-hardware",
        probe: squeezed,
        supported: true,
      },
    ]);

    // Collisions cannot be undone, so off by one stays off by one; a squeeze
    // corrects to within one as well, and the first of equals wins.
    expect(decoding.hardwareAcceleration).toBe("prefer-software");
    expect(decoding.residualError).toBe(1);
  });

  it("names no decoder when none returned a frame of the probe", async () => {
    const { resolveDepthPreviewDecoding } =
      await import("./depth-preview-probe");

    expect(
      resolveDepthPreviewDecoding([
        {
          hardwareAcceleration: "prefer-software",
          probe: null,
          supported: false,
        },
      ]),
    ).toMatchObject({ hardwareAcceleration: "no-preference", probe: null });
  });

  it("probes one decoder at a time, stops at an exact one, and answers once per page", async () => {
    const { chooseDepthPreviewDecoding } =
      await import("./depth-preview-probe");
    let open = 0;
    let maxOpen = 0;
    const opened: (HardwareAcceleration | undefined)[] = [];
    const openTrack = vi.fn(
      async (
        _input: DepthPreviewTrackInput,
        options?: { hardwareAcceleration?: HardwareAcceleration },
      ) => {
        open += 1;
        maxOpen = Math.max(maxOpen, open);
        opened.push(options?.hardwareAcceleration);

        return fakeReader(
          probeLuma(
            options?.hardwareAcceleration === "prefer-hardware"
              ? squeeze
              : (code) => code,
          ),
          () => {
            open -= 1;
          },
        );
      },
    );
    const supported = vi.fn(async () => true);
    const first = await chooseDepthPreviewDecoding(openTrack, supported);
    const second = await chooseDepthPreviewDecoding(openTrack, supported);

    expect(first).toBe(second);
    expect(first.hardwareAcceleration).toBe("prefer-software");
    expect(opened).toEqual(["prefer-software"]);
    expect(maxOpen).toBe(1);
  });

  it("skips a decoder the browser does not offer", async () => {
    const { chooseDepthPreviewDecoding } =
      await import("./depth-preview-probe");
    const openTrack = vi.fn(async () =>
      fakeReader(probeLuma(squeeze), () => undefined),
    );
    const decoding = await chooseDepthPreviewDecoding(
      openTrack,
      async (preference) => preference === "prefer-hardware",
    );

    expect(openTrack).toHaveBeenCalledTimes(1);
    expect(decoding.hardwareAcceleration).toBe("prefer-hardware");
    expect(decoding.correction).not.toBeNull();
    expect(decoding.verdicts[0]).toMatchObject({
      hardwareAcceleration: "prefer-software",
      supported: false,
    });
  });

  it("reads the probe from a decoder that returns frames only when flushed", async () => {
    const { chooseDepthPreviewDecoding } =
      await import("./depth-preview-probe");
    const decoding = await chooseDepthPreviewDecoding(
      probeThrough(() => "holdsUntilFlush"),
      async () => true,
    );

    expect(decoding).toMatchObject({
      correction: null,
      hardwareAcceleration: "prefer-software",
      probe: { exact: true },
    });
  });

  it("moves on from a decoder that refuses its configuration to the next", async () => {
    const { chooseDepthPreviewDecoding } =
      await import("./depth-preview-probe");
    const decoding = await chooseDepthPreviewDecoding(
      probeThrough((preference) =>
        preference === "prefer-software" ? "refusesConfig" : "outputs",
      ),
      async () => true,
    );

    expect(decoding.hardwareAcceleration).toBe("prefer-hardware");
    expect(decoding.probe?.exact).toBe(true);
    expect(decoding.verdicts[0]).toMatchObject({
      error: expect.stringContaining("No decoder takes this configuration."),
      hardwareAcceleration: "prefer-software",
      probe: null,
      supported: true,
    });
  });

  it("gives up on a decoder that never returns a frame, and names none when every one is like it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });

    try {
      const { chooseDepthPreviewDecoding } =
        await import("./depth-preview-probe");
      let settled = false;
      const choosing = chooseDepthPreviewDecoding(
        probeThrough(() => "silent"),
        async () => true,
      ).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(2900);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);

      const decoding = await choosing;

      expect(decoding.probe).toBeNull();
      expect(decoding.verdicts.map(({ error }) => error)).toEqual([
        "Error: The depth preview decoder returned no frame for 3 s of a flush.",
        "Error: The depth preview decoder returned no frame for 3 s of a flush.",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ships a probe clip Mediabunny reads as two full-range 256x256 H.264 frames", async () => {
    const { depthPreviewProbeBytes } = await import("./depth-preview-probe");
    const { BufferSource, EncodedPacketSink, Input, MP4 } =
      await vi.importActual<typeof import("mediabunny")>("mediabunny");
    const input = new Input({
      formats: [MP4],
      source: new BufferSource(depthPreviewProbeBytes()),
    });
    const track = (await input.getPrimaryVideoTrack())!;
    const packets = [];

    for await (const packet of new EncodedPacketSink(track).packets()) {
      packets.push(packet);
    }

    expect(await track.getCodecParameterString()).toBe("avc1.64000d");
    expect([await track.getCodedWidth(), await track.getCodedHeight()]).toEqual(
      [256, 256],
    );
    expect((await track.getColorSpace()).fullRange).toBe(true);
    expect(packets).toHaveLength(2);
    input.dispose();
  });
});

/** Opens the probe through fake decoders, one behaviour per preference. */
function probeThrough(
  behaviour: (
    preference: HardwareAcceleration | undefined,
  ) => FakeDecoderBehaviour,
) {
  return async (
    _input: DepthPreviewTrackInput,
    options?: DepthPreviewTrackOptions,
  ) =>
    openFakeDepthPreviewTrack(
      ({ hardwareAcceleration }) => behaviour(hardwareAcceleration),
      fakeProbeClip(),
      options,
    );
}

function probe(decode: (code: number) => number) {
  const decoded = Uint8Array.from({ length: 256 }, (_, code) => decode(code));
  let mismatchedCodes = 0;
  let maxError = 0;

  for (let code = 0; code < 256; code += 1) {
    if (decoded[code] !== code) mismatchedCodes += 1;
    maxError = Math.max(maxError, Math.abs(decoded[code] - code));
  }

  return {
    decoded,
    exact: mismatchedCodes === 0,
    lumaPath: "plane" as const,
    maxError,
    mismatchedCodes,
  };
}

function fakeReader(
  luma: Uint8Array,
  onDispose: () => void,
): DepthPreviewTrackReader {
  return {
    decode: () => ({
      cancel: () => undefined,
      next: async () => ({ height: 256, index: 0, luma, width: 256 }),
    }),
    dispose: onDispose,
    frameCount: 2,
    getStats: () => ({
      copyMainThreadMs: 0,
      decodersCreated: 1,
      framesCopied: 1,
      framesDecoded: 1,
      framesSkipped: 0,
      liveDecoders: 1,
      lumaPath: "plane",
      runsStarted: 1,
    }),
    height: 256,
    keyIndexAtOrBefore: () => 0,
    times: new Float64Array([0, 1 / 24]),
    width: 256,
  };
}
