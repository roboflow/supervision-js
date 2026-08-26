import { describe, expect, it, vi } from "vitest";

import { createChunkedDetectionFrameSource } from "#detections/chunked-detection-frame-source";
import type {
  DetectionFrameChunk,
  DetectionFrameChunkFetch,
  DetectionFrameChunkManifest,
} from "supervision-js-core";

describe("createChunkedDetectionFrameSource", () => {
  it("loads, filters, and caches only chunks overlapping the requested time range", async () => {
    const manifest = createManifest();
    const chunks = new Map<number, DetectionFrameChunk>([
      [
        0,
        {
          frames: [
            { detections: [], endTime: 0.5, frameIndex: 0, mediaTime: 0 },
            { detections: [], endTime: 1, frameIndex: 1, mediaTime: 0.5 },
          ],
        },
      ],
      [
        1,
        {
          frames: [
            { detections: [], endTime: 1.5, frameIndex: 2, mediaTime: 1 },
            { detections: [], endTime: 2, frameIndex: 3, mediaTime: 1.5 },
          ],
        },
      ],
      [
        2,
        {
          frames: [
            { detections: [], endTime: 2.5, frameIndex: 4, mediaTime: 2 },
          ],
        },
      ],
    ]);
    const fetchChunk = vi.fn(async (chunk: { chunkIndex: number }) => {
      const fixtureChunk = chunks.get(chunk.chunkIndex);

      if (!fixtureChunk) {
        throw new Error(`Missing test chunk ${chunk.chunkIndex}.`);
      }

      return fixtureChunk;
    });
    const source = createChunkedDetectionFrameSource({
      fetchChunk,
      manifest,
    });

    const firstLoad = await source.loadFrames(0.75, 1.25);
    const secondLoad = await source.loadFrames(1.1, 1.2);

    expect(firstLoad.map((frame) => frame.frameIndex)).toEqual([1, 2]);
    expect(secondLoad.map((frame) => frame.frameIndex)).toEqual([2]);
    expect(fetchChunk).toHaveBeenCalledTimes(2);
    expect(fetchChunk.mock.calls.map(([chunk]) => chunk.chunkIndex)).toEqual([
      0, 1,
    ]);
  });

  it("returns frames that start exactly at the requested range end", async () => {
    const manifest = createManifest();
    const chunks = new Map<number, DetectionFrameChunk>([
      [
        1,
        {
          frames: [
            { detections: [], endTime: 1.8, frameIndex: 2, mediaTime: 1.6 },
          ],
        },
      ],
      [
        2,
        {
          frames: [
            { detections: [], frameIndex: 3, mediaTime: 2 },
            { detections: [], endTime: 2.5, frameIndex: 4, mediaTime: 2 },
            { detections: [], frameIndex: 5, mediaTime: 2.05 },
          ],
        },
      ],
    ]);
    const fetchChunk = vi.fn(async (chunk: { chunkIndex: number }) => {
      const fixtureChunk = chunks.get(chunk.chunkIndex);

      if (!fixtureChunk) {
        throw new Error(`Missing test chunk ${chunk.chunkIndex}.`);
      }

      return fixtureChunk;
    });
    const source = createChunkedDetectionFrameSource({
      fetchChunk,
      manifest,
    });

    const frames = await source.loadFrames(1.5, 2);

    expect(frames.map((frame) => frame.frameIndex).sort()).toEqual([2, 3, 4]);
    expect(
      fetchChunk.mock.calls.map(([chunk]) => chunk.chunkIndex).sort(),
    ).toEqual([1, 2]);
  });

  it("loads JSON chunks from descriptor URLs by default", async () => {
    const manifest = createManifest();
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          frames: [
            { detections: [], endTime: 1.5, frameIndex: 2, mediaTime: 1 },
          ],
        }),
        { status: 200 },
      );
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;

    try {
      const source = createChunkedDetectionFrameSource({ manifest });
      const frames = await source.loadFrames(1, 1.5);

      expect(frames.map((frame) => frame.frameIndex)).toEqual([2]);
      expect(fetchMock).toHaveBeenCalledWith("chunks/000001.json");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("resolves JSON chunk URLs relative to a manifest base URL", async () => {
    const manifest = createManifest();
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          frames: [
            { detections: [], endTime: 1.5, frameIndex: 2, mediaTime: 1 },
          ],
        }),
        { status: 200 },
      );
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;

    try {
      const source = createChunkedDetectionFrameSource({
        baseUrl: "https://example.test/fixtures/manifest.json",
        manifest,
      });
      await source.loadFrames(1, 1.5);

      expect(fetchMock).toHaveBeenCalledWith(
        "https://example.test/fixtures/chunks/000001.json",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("evicts least-recently-used chunks when the cache limit is reached", async () => {
    const manifest = createManifest();
    const chunks = new Map<number, DetectionFrameChunk>(
      manifest.chunks.map((chunk) => [
        chunk.chunkIndex,
        {
          frames: [
            {
              detections: [],
              endTime: chunk.startTime + 0.5,
              frameIndex: chunk.chunkIndex,
              mediaTime: chunk.startTime,
            },
          ],
        },
      ]),
    );
    const fetchChunk = vi.fn(async (chunk: { chunkIndex: number }) => {
      const fixtureChunk = chunks.get(chunk.chunkIndex);

      if (!fixtureChunk) {
        throw new Error(`Missing test chunk ${chunk.chunkIndex}.`);
      }

      return fixtureChunk;
    });
    const source = createChunkedDetectionFrameSource({
      fetchChunk,
      manifest,
      maxCachedChunks: 2,
    });

    await source.loadFrames(0, 0.5);
    await source.loadFrames(1, 1.5);
    await source.loadFrames(2, 2.5);
    await source.loadFrames(0, 0.5);

    expect(fetchChunk.mock.calls.map(([chunk]) => chunk.chunkIndex)).toEqual([
      0, 1, 2, 0,
    ]);
  });

  it("retries a chunk request after a failed load", async () => {
    const manifest = createManifest();
    const fetchChunk = vi
      .fn<DetectionFrameChunkFetch>()
      .mockRejectedValueOnce(new Error("temporary chunk failure"))
      .mockResolvedValueOnce({
        frames: [{ detections: [], endTime: 0.5, frameIndex: 0, mediaTime: 0 }],
      });
    const source = createChunkedDetectionFrameSource({
      fetchChunk,
      manifest,
    });

    await expect(source.loadFrames(0, 0.5)).rejects.toThrow(
      "temporary chunk failure",
    );
    await expect(source.loadFrames(0, 0.5)).resolves.toHaveLength(1);
    expect(fetchChunk).toHaveBeenCalledTimes(2);
  });
});

function createManifest(): DetectionFrameChunkManifest {
  return {
    chunkDurationSeconds: 1,
    chunks: [
      {
        chunkIndex: 0,
        endTime: 1,
        frameCount: 2,
        startTime: 0,
        src: "chunks/000000.json",
      },
      {
        chunkIndex: 1,
        endTime: 2,
        frameCount: 2,
        startTime: 1,
        src: "chunks/000001.json",
      },
      {
        chunkIndex: 2,
        endTime: 3,
        frameCount: 1,
        startTime: 2,
        src: "chunks/000002.json",
      },
    ],
    datasetId: "long_fixture_v1",
    duration: 3,
    frameRate: 2,
    schema: "supervision-js.detection-frame-chunk-manifest",
    version: 1,
  };
}
