import { describe, expect, it } from "vitest";
import type {
  MediaRenderer,
  PreparedAnnotationWindowSnapshot,
} from "supervision";

import { readRendererReadinessBands } from "./renderer-readiness";

function createRenderer(
  snapshot: PreparedAnnotationWindowSnapshot | null,
): MediaRenderer {
  return {
    getPreparedAnnotationWindow: () => snapshot,
  } as unknown as MediaRenderer;
}

function frame(mediaTime: number, prepared: boolean) {
  return { frameIndex: null, mediaTime, prepared };
}

describe("readRendererReadinessBands", () => {
  it("answers null when no window exists", () => {
    expect(readRendererReadinessBands(null)).toBeNull();
    expect(readRendererReadinessBands(createRenderer(null))).toBeNull();
  });

  it("merges consecutive prepared frames into one band", () => {
    const renderer = createRenderer({
      frames: [frame(1, true), frame(1.5, true), frame(2, true)],
      playheadMediaTime: 1,
      playheadPrepared: true,
      preparedFrameCount: 3,
      spanFrameCount: 12,
    });

    expect(readRendererReadinessBands(renderer)).toEqual([
      { endTime: 2.5, startTime: 1 },
    ]);
  });

  it("keeps a hole in the window visible as separate bands", () => {
    const renderer = createRenderer({
      frames: [
        frame(1, true),
        frame(1.5, false),
        frame(2, true),
        frame(2.5, true),
      ],
      playheadMediaTime: 1,
      playheadPrepared: true,
      preparedFrameCount: 3,
      spanFrameCount: 12,
    });

    expect(readRendererReadinessBands(renderer)).toEqual([
      { endTime: 1.5, startTime: 1 },
      { endTime: 3, startTime: 2 },
    ]);
  });

  it("reports an empty window as prepared nothing, distinct from unavailable", () => {
    const renderer = createRenderer({
      frames: [frame(1, false), frame(1.5, false)],
      playheadMediaTime: 1,
      playheadPrepared: false,
      preparedFrameCount: 0,
      spanFrameCount: 12,
    });

    expect(readRendererReadinessBands(renderer)).toEqual([]);
  });
});
