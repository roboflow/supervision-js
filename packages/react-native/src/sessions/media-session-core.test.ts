import { createMediaSession } from "./media-session-core";
import { MediaSessionError } from "../types/media-session";
import type {
  MediaFrameProcessor,
  MediaFrameProcessorResult,
} from "../types/frame-processor";
import {
  FakeMediaFrameSource,
  FakeMediaRenderer,
  type FakePreparedPacket,
} from "../testing/fakes";
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
    await session.seek(0.5);
    expect(source.paused).toBe(true);
    expect(session.getState().status).toBe(MediaSessionStatus.Paused);

    await session.play();
    expect(source.resumed).toBe(true);
    await session.seek(0.5);
    expect(source.lastSeek).toBe(0.5);
    session.stop();
    await session.seek(0.5);
    expect(source.stopped).toBe(true);
    expect(session.getState().status).toBe(MediaSessionStatus.Ready);

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

  it("drains an in-flight frame before destroying native resources", async () => {
    const source = new FakeMediaFrameSource<FakeFrame>();
    const renderer = new FakeMediaRenderer<FakeFrame>();
    const processingStarted = deferred<void>();
    const processingResult = deferred<MediaFrameProcessorResult>();
    const session = await createMediaSession({
      processor: {
        process() {
          processingStarted.resolve();
          return processingResult.promise;
        },
      },
      renderer,
      source,
    });

    const emitted = source.emit(frame("in-flight"));

    await processingStarted.promise;
    const destroying = session.destroy();

    expect(renderer.destroyed).toBe(false);
    processingResult.resolve({
      detectionFrame: { detections: [], mediaTime: 0 },
    });
    await emitted;
    await destroying;

    expect(renderer.prepared).toEqual([]);
    expect(renderer.presentedPacketIds).toEqual([]);
    expect(renderer.destroyed).toBe(true);
    expect(source.destroyed).toBe(true);
  });

  it("releases a prepared packet when teardown starts before presentation", async () => {
    const source = new FakeMediaFrameSource<FakeFrame>();
    const renderer = new FakeMediaRenderer<FakeFrame>();
    const preparationStarted = deferred<void>();
    const preparedPacket = deferred<FakePreparedPacket>();

    renderer.prepare = () => {
      preparationStarted.resolve();
      return preparedPacket.promise;
    };
    const session = await createMediaSession({ processor, renderer, source });
    const emitted = source.emit(frame("prepared"));

    await preparationStarted.promise;
    const destroying = session.destroy();

    preparedPacket.resolve({ id: 42 });
    await emitted;
    await destroying;

    expect(renderer.presentedPacketIds).toEqual([]);
    expect(renderer.disposedPacketIds).toEqual([42]);
    expect(renderer.destroyed).toBe(true);
  });

  it("waits for asynchronous source startup before teardown", async () => {
    const source = new FakeMediaFrameSource<FakeFrame>();
    const renderer = new FakeMediaRenderer<FakeFrame>();
    const startEntered = deferred<void>();
    const startFinished = deferred<void>();

    source.start = () => {
      startEntered.resolve();
      return startFinished.promise;
    };
    const session = await createMediaSession({ processor, renderer, source });

    await startEntered.promise;
    const destroying = session.destroy();

    expect(renderer.destroyed).toBe(false);
    startFinished.resolve();
    await destroying;

    expect(source.destroyed).toBe(true);
    expect(renderer.destroyed).toBe(true);
  });

  it("waits for asynchronous source resume before teardown", async () => {
    const source = new FakeMediaFrameSource<FakeFrame>();
    const renderer = new FakeMediaRenderer<FakeFrame>();
    const resumeStarted = deferred<void>();
    const resumeFinished = deferred<void>();

    source.resume = () => {
      resumeStarted.resolve();
      return resumeFinished.promise;
    };
    const session = await createMediaSession({ processor, renderer, source });
    const playing = session.play();

    await resumeStarted.promise;
    const destroying = session.destroy();

    expect(renderer.destroyed).toBe(false);
    resumeFinished.resolve();
    await Promise.all([playing, destroying]);

    expect(source.destroyed).toBe(true);
    expect(renderer.destroyed).toBe(true);
    expect(session.getState().status).toBe(MediaSessionStatus.Destroyed);
  });

  it("honors a later pause or stop while source resume is pending", async () => {
    const source = new FakeMediaFrameSource<FakeFrame>();
    const renderer = new FakeMediaRenderer<FakeFrame>();
    const resumeFinished = deferred<void>();

    source.resume = () => resumeFinished.promise;
    const session = await createMediaSession({ processor, renderer, source });
    const playing = session.play();

    session.pause();
    resumeFinished.resolve();
    await playing;
    await session.seek(0);

    expect(source.paused).toBe(true);
    expect(session.getState().status).toBe(MediaSessionStatus.Paused);

    const resumeAgainFinished = deferred<void>();

    source.resume = () => resumeAgainFinished.promise;
    const playingAgain = session.play();
    session.stop();
    resumeAgainFinished.resolve();
    await playingAgain;
    await session.seek(0);

    expect(source.stopped).toBe(true);
    expect(session.getState().status).toBe(MediaSessionStatus.Ready);
    await session.destroy();
  });

  it("normalizes source control failures and records ended state", async () => {
    const source = new FakeMediaFrameSource<FakeFrame>();
    const session = await createMediaSession({
      processor,
      renderer: new FakeMediaRenderer<FakeFrame>(),
      source,
    });

    source.resume = () => {
      throw new Error("native resume failed");
    };
    await expect(session.play()).rejects.toMatchObject({
      code: "source-failed",
      message: "native resume failed",
    });
    expect(session.getState().status).toBe(MediaSessionStatus.Error);

    await session.destroy();

    const seekSource = new FakeMediaFrameSource<FakeFrame>();
    const seekSession = await createMediaSession({
      processor,
      renderer: new FakeMediaRenderer<FakeFrame>(),
      source: seekSource,
    });

    seekSource.seek = () => {
      throw new Error("native seek failed");
    };
    await expect(seekSession.seek(0.5)).rejects.toMatchObject({
      code: "source-failed",
      message: "native seek failed",
    });
    expect(seekSession.getState().status).toBe(MediaSessionStatus.Error);
    await seekSession.destroy();

    const endedSource = new FakeMediaFrameSource<FakeFrame>();
    const endedSession = await createMediaSession({
      processor,
      renderer: new FakeMediaRenderer<FakeFrame>(),
      source: endedSource,
    });

    endedSource.end();
    expect(endedSession.getState().status).toBe(MediaSessionStatus.Ready);
    await endedSession.destroy();
  });

  it("attempts every cleanup step when one of them fails", async () => {
    const source = new FakeMediaFrameSource<FakeFrame>();
    const renderer = new FakeMediaRenderer<FakeFrame>();
    const session = await createMediaSession({ processor, renderer, source });

    await source.emit(frame("active"));
    renderer.disposePacket = (packet) => {
      renderer.disposedPacketIds.push(packet.id);
      throw new Error("packet cleanup failed");
    };
    source.destroy = () => {
      source.destroyed = true;
      throw new Error("source cleanup failed");
    };

    await expect(session.destroy()).rejects.toThrow("packet cleanup failed");
    expect(renderer.disposedPacketIds).toEqual([0]);
    expect(source.destroyed).toBe(true);
    expect(renderer.destroyed).toBe(true);
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

function deferred<TValue>() {
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}
