import { describe, expect, it } from "vitest";

import { createMediaSession, MediaSessionMode } from "./media-session";
import type { MediaFrameProcessor } from "./types/frame-processor";
import type { MediaFrameSource } from "./types/frame-source";
import type {
  MediaRendererAdapter,
  MediaRendererPrepareOptions,
} from "./types/renderer";

interface StaticImage {
  readonly uri: string;
}

interface NativeVideoFrame {
  readonly pointer: bigint;
}

interface CameraFrame {
  readonly timestamp: number;
}

interface Packet {
  readonly id: number;
}

const staticSource = sourceFor<StaticImage>(MediaSessionMode.File, {
  live: false,
  pausable: false,
  seekable: false,
  stoppable: true,
});
const savedVideoSource = sourceFor<NativeVideoFrame>(MediaSessionMode.File, {
  live: false,
  pausable: true,
  seekable: false,
  stoppable: true,
});
const liveCameraSource = sourceFor<CameraFrame>(MediaSessionMode.Stream, {
  live: true,
  pausable: true,
  seekable: false,
  stoppable: true,
});

const processorFor = <TPayload>(): MediaFrameProcessor<TPayload> => ({
  process(frame) {
    return {
      detectionFrame: {
        detections: [],
        frameIndex: frame.metadata.frameIndex ?? undefined,
        mediaTime: frame.metadata.mediaTime,
      },
    };
  },
});

const rendererFor = <TPayload>(): MediaRendererAdapter<TPayload, Packet> => ({
  backend: "consumer-fixture",
  prepare(options: MediaRendererPrepareOptions<TPayload>) {
    return { id: options.packetId };
  },
  present() {},
});

describe("mobile session consumer contracts", () => {
  it("typechecks static, saved-video, live, and custom processor setups", async () => {
    const staticSession = await createMediaSession({
      processor: processorFor<StaticImage>(),
      renderer: rendererFor<StaticImage>(),
      source: staticSource,
    });
    const savedVideoSession = await createMediaSession({
      processor: processorFor<NativeVideoFrame>(),
      renderer: rendererFor<NativeVideoFrame>(),
      source: savedVideoSource,
    });
    const liveSession = await createMediaSession({
      processor: processorFor<CameraFrame>(),
      renderer: rendererFor<CameraFrame>(),
      source: liveCameraSource,
    });

    expect(staticSession.capabilities.pausable).toBe(false);
    expect(savedVideoSession.capabilities.live).toBe(false);
    expect(liveSession.capabilities.live).toBe(true);

    await Promise.all([
      staticSession.destroy(),
      savedVideoSession.destroy(),
      liveSession.destroy(),
    ]);
  });
});

function sourceFor<TPayload>(
  mode: MediaSessionMode,
  capabilities: MediaFrameSource<TPayload>["capabilities"],
): MediaFrameSource<TPayload> {
  return {
    capabilities,
    mode,
    timeline: { duration: null, frameRate: null, height: 1, width: 1 },
    start() {},
  };
}
