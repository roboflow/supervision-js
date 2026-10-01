import { describe, expect, it, vi } from "vitest";

import { assertDepthPreviewTimeline } from "#render-preparation/depth/clip-preview";
import { depthPreviewProbeBytes } from "./depth-preview-probe";
import { readTrackFrameIndex } from "./track-frame-index";

const mediabunny =
  await vi.importActual<typeof import("mediabunny")>("mediabunny");
const FPS = 24;

const videoTime = (index: number) => index / FPS;

/**
 * Writes an MP4 whose packets carry the given presentation times in decode
 * order. The packets are never decoded, so their bytes are placeholders; the
 * container tables are what is real, written by Mediabunny's muxer.
 */
async function writePreview(
  frames: readonly { readonly time: number; readonly key: boolean }[],
): Promise<Uint8Array> {
  const probe = new mediabunny.Input({
    formats: [mediabunny.MP4],
    source: new mediabunny.BufferSource(depthPreviewProbeBytes()),
  });
  const decoderConfig =
    (await (await probe.getPrimaryVideoTrack())!.getDecoderConfig())!;

  probe.dispose();

  const target = new mediabunny.BufferTarget();
  const output = new mediabunny.Output({
    format: new mediabunny.Mp4OutputFormat(),
    target,
  });
  const source = new mediabunny.EncodedVideoPacketSource("avc");

  output.addVideoTrack(source);
  await output.start();
  for (const [index, frame] of frames.entries()) {
    await source.add(
      new mediabunny.EncodedPacket(
        new Uint8Array([0, 0, 0, 1, 0x65, index & 0xff]),
        frame.key ? "key" : "delta",
        frame.time,
        1 / FPS,
      ),
      index === 0 ? { decoderConfig } : undefined,
    );
  }
  await output.finalize();

  return new Uint8Array(target.buffer!);
}

async function timelineOf(bytes: Uint8Array) {
  const input = new mediabunny.Input({
    formats: [mediabunny.MP4],
    source: new mediabunny.BufferSource(bytes),
  });

  try {
    const timeline = await readTrackFrameIndex(
      (await input.getPrimaryVideoTrack())!,
    );

    return {
      frameCount: timeline.times.length,
      keyIndices: [...timeline.keyIndices],
      start: timeline.sourceTimes[0],
      times: timeline.times,
    };
  } finally {
    input.dispose();
  }
}

describe("depth preview timeline against the video's", () => {
  it("reads B-frames written in decode order, on a clock that starts later, back in presentation order", async () => {
    // I P B B, as presented 0 3 1 2.
    const order = [0, 3, 1, 2, 4, 7, 5, 6];
    const preview = await timelineOf(
      await writePreview(
        order.map((index) => ({
          key: index % 4 === 0,
          time: 0.5 + videoTime(index),
        })),
      ),
    );

    expect(preview.start).toBeCloseTo(0.5);
    expect(preview.keyIndices).toEqual([0, 4]);
    expect(() =>
      assertDepthPreviewTimeline(preview, 8, videoTime),
    ).not.toThrow();
  });
});
