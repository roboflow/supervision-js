import { createMediaSession } from "./media-session-core";
import { MediaSessionError } from "../types/media-session";
import type { MediaFrameProcessor } from "../types/frame-processor";
import { FakeMediaFrameSource, FakeMediaRenderer } from "../testing/fakes";
import {
  MediaSessionStatus,
  type PlatformMediaFrame,
} from "supervision-js-core";
import { describe, expect, it } from "vitest";

interface FakeFrame {
  readonly id: string;
}

const processor: MediaFrameProcessor<FakeFrame> = {
  process(frame) {
    return {
      detectionFrame: {
        detections: [{ id: frame.payload.id }],
        frameIndex: frame.metadata.frameIndex ?? undefined,
        mediaTime: frame.metadata.mediaTime,
      },
      diagnostics: { producer: "fake" },
    };
  },
};

function frame(id: string, frameIndex = 0): PlatformMediaFrame<FakeFrame> {
  return {
    metadata: {
      duration: 1 / 30,
      frameIndex,
      height: 100,
      mediaTime: frameIndex / 30,
      width: 100,
    },
    payload: { id },
  };
}

describe("createMediaSession", () => {
  it("owns source-to-renderer frame processing, state, and packet disposal", async () => {
    const source = new FakeMediaFrameSource<FakeFrame>();
    const renderer = new FakeMediaRenderer<FakeFrame>();
    const states: MediaSessionStatus[] = [];
    const session = await createMediaSession({
      onState: (state) => states.push(state.status),
      processor,
      renderer,
      source,
    });

    expect(source.opened).toBe(true);
    expect(session.getState().status).toBe(MediaSessionStatus.Playing);

    await source.emit(frame("first", 1));
    await source.emit(frame("second", 2));

    expect(renderer.prepared.map((entry) => entry.packetId)).toEqual([0, 1]);
    expect(renderer.presentedPacketIds).toEqual([0, 1]);
    expect(renderer.disposedPacketIds).toEqual([0]);
    expect(session.getState()).toMatchObject({
      renderPreparation: { activePacketId: 1, preparedFrames: 2 },
      renderer: {
        activeDetectionFrame: { detections: [{ id: "second" }] },
        backend: "fake",
        presentedFrames: 2,
      },
    });
    expect(states).toContain(MediaSessionStatus.Loading);
    expect(states).toContain(MediaSessionStatus.Playing);

    session.pause();
    expect(source.paused).toBe(true);
    expect(session.getState().status).toBe(MediaSessionStatus.Paused);

    await session.play();
    expect(source.resumed).toBe(true);
    await session.seek(0.5);
    expect(source.lastSeek).toBe(0.5);
    session.stop();
    expect(source.stopped).toBe(true);

    await session.destroy();
    expect(renderer.disposedPacketIds).toEqual([0, 1]);
    expect(renderer.destroyed).toBe(true);
    expect(source.destroyed).toBe(true);
    expect(session.getState().status).toBe(MediaSessionStatus.Destroyed);
  });

  it("serializes source frames and reports a processor error without presenting", async () => {
    const source = new FakeMediaFrameSource<FakeFrame>();
    const renderer = new FakeMediaRenderer<FakeFrame>();
    let inFlight = 0;
    let maximumInFlight = 0;
    const session = await createMediaSession({
      processor: {
        async process(nextFrame) {
          inFlight += 1;
          maximumInFlight = Math.max(maximumInFlight, inFlight);
          await Promise.resolve();
          inFlight -= 1;

          if (nextFrame.payload.id === "bad") {
            throw new Error("model failed");
          }

          return {
            detectionFrame: {
              detections: [],
              mediaTime: nextFrame.metadata.mediaTime,
            },
          };
        },
      },
      renderer,
      source,
    });

    await Promise.all([source.emit(frame("one")), source.emit(frame("bad"))]);

    expect(maximumInFlight).toBe(1);
    expect(renderer.presentedPacketIds).toEqual([0]);
    expect(session.getState()).toMatchObject({
      errorMessage: "model failed",
      status: MediaSessionStatus.Error,
    });
  });

  it("uses stable errors for unsupported operations and calls after destroy", async () => {
    const source = new FakeMediaFrameSource<FakeFrame>({
      capabilities: { pausable: false, seekable: false, stoppable: false },
    });
    const session = await createMediaSession({
      processor,
      renderer: new FakeMediaRenderer<FakeFrame>(),
      source,
    });

    expectMediaSessionError(() => session.pause(), "unsupported-operation");
    await expect(session.seek(0)).rejects.toMatchObject({
      code: "unsupported-operation",
    });
    expectMediaSessionError(() => session.stop(), "unsupported-operation");

    await session.destroy();

    expectMediaSessionError(() => session.setPresentation({}), "destroyed");
  });

  it("rolls back acquired source and renderer resources when opening fails", async () => {
    const source = new FakeMediaFrameSource<FakeFrame>();
    const renderer = new FakeMediaRenderer<FakeFrame>();

    source.open = () => {
      throw new Error("source cannot open");
    };

    await expect(
      createMediaSession({ processor, renderer, source }),
    ).rejects.toMatchObject({
      code: "source-open-failed",
      message: "source cannot open",
    });
    expect(source.destroyed).toBe(true);
    expect(renderer.destroyed).toBe(true);
  });
});

function expectMediaSessionError(
  action: () => void,
  code: MediaSessionError["code"],
) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(MediaSessionError);
    expect(error).toMatchObject({ code });
    return;
  }

  throw new Error(`Expected MediaSessionError with code ${code}.`);
}
