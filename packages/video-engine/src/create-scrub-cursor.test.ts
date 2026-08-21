import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { CanvasSinkScrubCursor } from "./canvas-sink-scrub-cursor";
import { createScrubCursor } from "./create-scrub-cursor";
import { DecodeScheduler } from "./decode-scheduler";
import * as decodeSource from "./decode-source";
import type {
  DecodeSourceHandle,
  SampleSourceHandle,
  SessionSourceHandle,
} from "./decode-source";
import { FrameTimeline } from "./frame-timeline";
import type { KeyframeProbe } from "./keyframe-index";
import type { ScrubTrackInfo } from "./scrub-cursor";
import { asSec, SourceKind, type VideoSource } from "./types";
import {
  FakeVideoSample,
  installWorkerGlobals,
} from "../test/fake-engine-deps";

beforeAll(() => {
  installWorkerGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const SOURCE: VideoSource = {
  kind: SourceKind.Url,
  url: "https://example.test/v.mp4",
};

const TRACK: ScrubTrackInfo = {
  width: 320,
  height: 180,
  decodeWidth: 320,
  decodeHeight: 180,
  nativeFps: 30,
  durationS: asSec(5),
  firstTimestampS: asSec(0),
  timeline: FrameTimeline.uniform(30, 1000),
};

const PROBE: KeyframeProbe = {
  async getKeyPacket() {
    return null;
  },
  async getNextKeyPacket() {
    return null;
  },
};

function fakeCanvasHandle(): DecodeSourceHandle {
  return {
    track: TRACK,
    sink: {
      async getCanvas(t) {
        return {
          canvas: { width: 320, height: 180 } as OffscreenCanvas,
          timestamp: t,
        };
      },
      async *canvases() {},
      async *canvasesAtTimestamps() {},
    },
    keyframeProbe: PROBE,
    dispose: async () => undefined,
  };
}

function fakeSampleHandle(): SampleSourceHandle {
  return {
    track: TRACK,
    sampleSink: {
      async getSample() {
        return new FakeVideoSample(0);
      },
      async *samples() {},
      async *samplesAtTimestamps() {},
    },
    keyframeProbe: PROBE,
    dispose: async () => undefined,
  };
}

function fakeSessionHandle(): SessionSourceHandle {
  return {
    track: TRACK,
    session: {
      async frameAt() {
        return new FakeVideoSample(0);
      },
      async *framesFrom() {},
      async *framesCovering() {},
      reachableFromS: -Infinity,
      framesDecoded: 0,
    },
    keyframeProbe: PROBE,
    dispose: async () => undefined,
  };
}

describe("createScrubCursor", () => {
  it("every opened path produces a working uncached cursor", async () => {
    for (const handle of [
      fakeCanvasHandle(),
      fakeSampleHandle(),
      fakeSessionHandle(),
    ]) {
      vi.spyOn(decodeSource, "openScrubSource").mockResolvedValue(handle);
      const cursor = await createScrubCursor({ source: SOURCE });
      expect(cursor).toBeInstanceOf(CanvasSinkScrubCursor);
    }
  });

  it("a cache config yields the caching scheduler instead", async () => {
    vi.spyOn(decodeSource, "openScrubSource").mockResolvedValue(
      fakeSessionHandle(),
    );

    const cursor = await createScrubCursor({
      source: SOURCE,
      cache: { previewWidth: 160 },
    });

    expect(cursor).toBeInstanceOf(DecodeScheduler);
  });

  it("the source is opened exactly once per cursor", async () => {
    const open = vi
      .spyOn(decodeSource, "openScrubSource")
      .mockResolvedValue(fakeCanvasHandle());

    await createScrubCursor({ source: SOURCE, cache: { previewWidth: 160 } });

    expect(open).toHaveBeenCalledTimes(1);
  });
});
