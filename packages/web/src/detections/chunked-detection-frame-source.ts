import type {
  ChunkedDetectionFrameSourceOptions,
  DetectionFrameChunk,
  DetectionFrameChunkDescriptor,
  DetectionFrameChunkFetch,
  DetectionFrameSource,
} from "supervision-js-core";
import type { DetectionFrame } from "supervision-js-core";
import {
  copySortedDetectionFrames,
  detectionFrameOverlapsRange,
} from "supervision-js-core";

const DEFAULT_MAX_CACHED_CHUNKS = 12;

export function createChunkedDetectionFrameSource(
  options: ChunkedDetectionFrameSourceOptions,
): DetectionFrameSource {
  const chunkCache = new Map<number, Promise<DetectionFrameChunk>>();
  const fetchChunk =
    options.fetchChunk ??
    ((chunk) => fetchJsonDetectionFrameChunk(chunk, options.baseUrl));
  const maxCachedChunks = options.maxCachedChunks ?? DEFAULT_MAX_CACHED_CHUNKS;
  let destroyed = false;

  if (maxCachedChunks <= 0) {
    throw new Error("maxCachedChunks must be greater than 0.");
  }

  return {
    async loadFrames(startTime, endTime) {
      if (destroyed) {
        throw new Error("Chunked detection frame source has been destroyed.");
      }

      const normalizedStartTime = Math.max(0, startTime);
      const normalizedEndTime = Math.max(normalizedStartTime, endTime);
      const chunks = getOverlappingChunks(
        options.manifest.chunks,
        normalizedStartTime,
        normalizedEndTime,
      );

      if (chunks.length === 0) {
        return [];
      }

      const loadedChunks = await Promise.all(
        chunks.map((chunk) => loadChunk(chunk, fetchChunk, chunkCache)),
      );

      trimChunkCache(
        chunkCache,
        maxCachedChunks,
        new Set(chunks.map((chunk) => chunk.chunkIndex)),
      );

      return copySortedDetectionFrames(
        dedupeDetectionFrames(
          loadedChunks.flatMap((chunk) => chunk.frames),
        ).filter((frame) =>
          detectionFrameOverlapsRange(
            frame,
            normalizedStartTime,
            normalizedEndTime,
          ),
        ),
      );
    },

    destroy() {
      destroyed = true;
      chunkCache.clear();
    },
  };
}

function getOverlappingChunks(
  chunks: readonly DetectionFrameChunkDescriptor[],
  startTime: number,
  endTime: number,
) {
  return chunks.filter(
    (chunk) => chunk.startTime <= endTime && chunk.endTime > startTime,
  );
}

function loadChunk(
  chunk: DetectionFrameChunkDescriptor,
  fetchChunk: DetectionFrameChunkFetch,
  chunkCache: Map<number, Promise<DetectionFrameChunk>>,
) {
  const cachedChunk = chunkCache.get(chunk.chunkIndex);

  if (cachedChunk) {
    chunkCache.delete(chunk.chunkIndex);
    chunkCache.set(chunk.chunkIndex, cachedChunk);
    return cachedChunk;
  }

  const chunkPromise = fetchChunk(chunk).catch((error: unknown) => {
    if (chunkCache.get(chunk.chunkIndex) === chunkPromise) {
      chunkCache.delete(chunk.chunkIndex);
    }

    throw error;
  });

  chunkCache.set(chunk.chunkIndex, chunkPromise);
  return chunkPromise;
}

function trimChunkCache(
  chunkCache: Map<number, Promise<DetectionFrameChunk>>,
  maxCachedChunks: number,
  protectedChunkIndexes: ReadonlySet<number>,
) {
  for (const chunkIndex of chunkCache.keys()) {
    if (chunkCache.size <= maxCachedChunks) {
      return;
    }

    if (protectedChunkIndexes.has(chunkIndex)) {
      continue;
    }

    chunkCache.delete(chunkIndex);
  }
}

async function fetchJsonDetectionFrameChunk(
  chunk: DetectionFrameChunkDescriptor,
  baseUrl: string | URL | undefined,
): Promise<DetectionFrameChunk> {
  const src = baseUrl ? new URL(chunk.src, baseUrl).href : chunk.src;
  const response = await fetch(src);

  if (!response.ok) {
    throw new Error(
      `Unable to load detection chunk ${src}: ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as
    DetectionFrameChunk | readonly DetectionFrame[];

  if (Array.isArray(payload)) {
    return { frames: payload as readonly DetectionFrame[] };
  }

  return payload as DetectionFrameChunk;
}

function dedupeDetectionFrames(frames: readonly DetectionFrame[]) {
  const dedupedFrames = new Map<string, DetectionFrame>();

  for (const frame of frames) {
    dedupedFrames.set(getDetectionFrameDedupeKey(frame), frame);
  }

  return Array.from(dedupedFrames.values());
}

function getDetectionFrameDedupeKey(frame: DetectionFrame) {
  return frame.frameIndex === undefined
    ? `time:${frame.mediaTime}`
    : `index:${frame.frameIndex}`;
}
