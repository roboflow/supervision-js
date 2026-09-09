import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Reads a chunked detection fixture back into the single in-memory shape the
 * offline tools work with. Frames whose interval crosses a chunk boundary are
 * written into every chunk they touch, so they are de-duplicated by media time.
 */
export async function readChunkedDetections(manifestPath) {
  const resolvedManifestPath = resolve(manifestPath);
  const manifest = JSON.parse(await readFile(resolvedManifestPath, "utf8"));
  const fixtureDir = dirname(resolvedManifestPath);
  const framesByMediaTime = new Map();

  for (const chunk of manifest.chunks ?? []) {
    const chunkPath = resolve(fixtureDir, chunk.src);
    const { frames = [] } = JSON.parse(await readFile(chunkPath, "utf8"));

    for (const frame of frames) {
      if (!framesByMediaTime.has(frame.mediaTime)) {
        framesByMediaTime.set(frame.mediaTime, frame);
      }
    }
  }

  return {
    frames: [...framesByMediaTime.values()].sort(
      (left, right) => left.mediaTime - right.mediaTime,
    ),
    inference: manifest.inference,
    schema: manifest.schema,
    source: manifest.source,
    version: manifest.version,
    video: manifest.video,
  };
}
