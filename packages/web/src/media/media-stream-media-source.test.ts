import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMediaStreamRendererSource } from "./media-stream-media-source";

type VideoFrameCallback = (
  now: DOMHighResTimeStamp,
  metadata: VideoFrameCallbackMetadata,
) => void;

class FakeTrack extends EventTarget {
  readyState: MediaStreamTrackState = "live";
  readonly stop = vi.fn(() => {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  });

  getSettings() {
    return { frameRate: 25 };
  }

  end() {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

class FakeStream extends EventTarget {
  constructor(
    private readonly videoTrack: FakeTrack,
    private readonly audioTrackCount = 0,
  ) {
    super();
  }

  getVideoTracks() {
    return [this.videoTrack] as unknown as MediaStreamTrack[];
  }

  getAudioTracks() {
    return Array.from({ length: this.audioTrackCount }, () => ({
      stop: vi.fn(),
    })) as unknown as MediaStreamTrack[];
  }

  getTracks() {
    return [...this.getVideoTracks(), ...this.getAudioTracks()];
  }
}

class FakeVideo extends EventTarget {
  autoplay = false;
  currentTime = 0;
  error: MediaError | null = null;
  muted = false;
  playsInline = false;
  srcObject: MediaProvider | null = null;
  readonly load = vi.fn();
  readonly pause = vi.fn();
  readonly play = vi.fn(async () => undefined);
  private nextCallbackHandle = 1;
  private readonly callbacks = new Map<number, VideoFrameCallback>();

  requestVideoFrameCallback(callback: VideoFrameCallback) {
    const handle = this.nextCallbackHandle++;
    this.callbacks.set(handle, callback);
    return handle;
  }

  cancelVideoFrameCallback(handle: number) {
    this.callbacks.delete(handle);
  }

  async present(mediaTime: number) {
    await vi.waitFor(() => expect(this.callbacks.size).toBe(1));
    const [handle, callback] = this.callbacks.entries().next().value!;
    this.callbacks.delete(handle);
    this.currentTime = mediaTime;
    callback(0, { mediaTime } as VideoFrameCallbackMetadata);
    await Promise.resolve();
  }
}

function createBitmap(width = 640, height = 360) {
  return {
    close: vi.fn(),
    height,
    width,
  } as unknown as ImageBitmap;
}

describe("createMediaStreamRendererSource", () => {
  let fakeVideo: FakeVideo;
  let bitmaps: ImageBitmap[];

  beforeEach(() => {
    fakeVideo = new FakeVideo();
    bitmaps = [];
    vi.stubGlobal("document", {
      createElement: vi.fn(() => fakeVideo),
    });
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        const bitmap = createBitmap();
        bitmaps.push(bitmap);
        return bitmap;
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("snapshots presented frames with their media timestamps", async () => {
    const track = new FakeTrack();
    const stream = new FakeStream(track, 1);
    const opening = createMediaStreamRendererSource(
      stream as unknown as MediaStream,
    ).open();

    await fakeVideo.present(1.25);
    const decoded = await opening;

    expect(decoded.metadata).toMatchObject({
      audioTrackCount: 1,
      duration: null,
      firstTimestamp: 1.25,
      formatName: "media-stream",
      primaryVideoHeight: 360,
      primaryVideoWidth: 640,
      videoTrackCount: 1,
    });

    const sample = await decoded.sampleSink.getSample(1.25);
    const context = { drawImage: vi.fn() };
    sample?.draw(context as unknown as CanvasRenderingContext2D, 1, 2, 3, 4);

    expect(sample?.timestamp).toBe(1.25);
    expect(sample?.duration).toBe(1 / 25);
    expect(context.drawImage).toHaveBeenCalledWith(bitmaps[0], 1, 2, 3, 4);

    sample?.close();
    decoded.input.dispose();

    expect(bitmaps[0]?.close).toHaveBeenCalledOnce();
    expect(track.stop).not.toHaveBeenCalled();
    expect(fakeVideo.pause).toHaveBeenCalledOnce();
    expect(fakeVideo.load).toHaveBeenCalledOnce();
  });

  it("bounds queued snapshots and resumes consumers at the live edge", async () => {
    const track = new FakeTrack();
    const stream = new FakeStream(track);
    const opening = createMediaStreamRendererSource(
      stream as unknown as MediaStream,
      { maxBufferedFrames: 2 },
    ).open();

    await fakeVideo.present(0);
    const decoded = await opening;
    await fakeVideo.present(0.1);
    await fakeVideo.present(0.2);
    await fakeVideo.present(0.3);

    const iterator = decoded.sampleSink.samples(0);
    const result = await iterator.next();

    expect(result.done).toBe(false);
    expect(result.value?.timestamp).toBe(0.3);
    expect(bitmaps.slice(0, 3).map((bitmap) => bitmap.close)).toEqual([
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    ]);
    for (const bitmap of bitmaps.slice(0, 3)) {
      expect(bitmap.close).toHaveBeenCalledOnce();
    }

    result.value?.close();
    await iterator.return();
    decoded.input.dispose();
  });

  it("ends a live iterator when the video track ends", async () => {
    const track = new FakeTrack();
    const stream = new FakeStream(track);
    const opening = createMediaStreamRendererSource(
      stream as unknown as MediaStream,
    ).open();

    await fakeVideo.present(0);
    const decoded = await opening;
    const iterator = decoded.sampleSink.samples(0);
    const first = await iterator.next();
    first.value?.close();

    track.end();

    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    decoded.input.dispose();
  });

  it("can take ownership of stream tracks explicitly", async () => {
    const track = new FakeTrack();
    const stream = new FakeStream(track);
    const opening = createMediaStreamRendererSource(
      stream as unknown as MediaStream,
      { stopTracksOnDispose: true },
    ).open();

    await fakeVideo.present(0);
    const decoded = await opening;
    decoded.input.dispose();

    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("rejects streams without a video track", async () => {
    const stream = new FakeStream(new FakeTrack());
    vi.spyOn(stream, "getVideoTracks").mockReturnValue([]);

    await expect(
      createMediaStreamRendererSource(stream as unknown as MediaStream).open(),
    ).rejects.toThrow("MediaStream does not contain a video track");
  });
});
