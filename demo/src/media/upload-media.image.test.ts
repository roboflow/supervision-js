import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareUploadedImageMedia } from "./upload-media";

/** The browser's VP9 encoder is out of reach here, so the canvas source hands
 *  the real muxer a stand-in key packet at the time and for the duration it is
 *  asked to encode. Everything after the encoder is mediabunny's own. */
vi.mock("mediabunny", async (importOriginal) => {
  const mediabunny = await importOriginal<typeof import("mediabunny")>();

  class CanvasSource {
    constructor(_canvas: unknown, config: { codec: "vp9" }) {
      const packets = new mediabunny.EncodedVideoPacketSource(config.codec);
      const addPacket = packets.add.bind(packets);

      return Object.assign(packets, {
        add: (timestamp: number, duration: number) =>
          addPacket(
            new mediabunny.EncodedPacket(
              new Uint8Array(16),
              "key",
              timestamp,
              duration,
            ),
            {
              decoderConfig: {
                codec: "vp09.00.10.08",
                codedHeight: 4,
                codedWidth: 4,
              },
            },
          ),
      });
    }
  }

  return { ...mediabunny, CanvasSource };
});

function installImageGlobals() {
  vi.stubGlobal("createImageBitmap", async () => ({
    close() {},
    height: 4,
    width: 4,
  }));
  vi.stubGlobal("document", {
    createElement: () => ({
      getContext: () => ({ drawImage() {} }),
      height: 0,
      width: 0,
    }),
  });
}

describe("prepareUploadedImageMedia", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes a video whose one frame lasts the image's whole duration", async () => {
    installImageGlobals();
    const prepared = await prepareUploadedImageMedia({
      file: new File([], "still.png", { type: "image/png" }),
    });
    const { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } =
      await import("mediabunny");
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BlobSource(prepared.blob!),
    });
    const track = (await input.getPrimaryVideoTrack())!;
    const packets = [];

    for await (const packet of new EncodedPacketSink(track).packets(
      undefined,
      undefined,
      { metadataOnly: true },
    )) {
      packets.push({ duration: packet.duration, timestamp: packet.timestamp });
    }

    expect(packets).toEqual([{ duration: prepared.duration, timestamp: 0 }]);
    expect(await track.computeDuration()).toBe(prepared.duration);
    input.dispose();
  });
});
