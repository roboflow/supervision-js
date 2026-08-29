import { describe, expect, it, vi } from "vitest";

import type { DetectionFrameSource } from "supervision-js-core";
import {
  MediaSessionMode,
  type MediaSessionDetectionSourceOptions,
} from "#types/media-session";

import { prepareSessionDetections } from "./media-session-detections";

const range = { endTime: 2, startTime: 1 };

describe("session detection sources", () => {
  it("waits only for the sources marked required for coverage", async () => {
    const required = createSource();
    const optional = createSource();
    const prepared = await prepareSessionDetections({
      detections: {
        sources: [
          { id: "required", source: required },
          { id: "optional", requiredForCoverage: false, source: optional },
        ],
      },
      mode: MediaSessionMode.File,
    });

    await prepared.detectionSource?.waitForRange?.(range);

    expect(required.waitForRange).toHaveBeenCalledWith(range);
    expect(optional.waitForRange).not.toHaveBeenCalled();
  });

  /* Only TypeScript refuses a key this option does not have. A plain
   * JavaScript consumer's unrecognised opt-out reads as no opt-out at all, so
   * the source holds coverage like any other. */
  it("waits for a source whose only opt-out is a name it does not recognise", async () => {
    const source = createSource();
    const prepared = await prepareSessionDetections({
      detections: {
        sources: [
          {
            id: "legacy",
            requiredForPlayback: false,
            source,
          } as MediaSessionDetectionSourceOptions,
        ],
      },
      mode: MediaSessionMode.File,
    });

    await prepared.detectionSource?.waitForRange?.(range);

    expect(source.waitForRange).toHaveBeenCalledWith(range);
  });
});

function createSource(): DetectionFrameSource {
  return {
    loadFrames: vi.fn(async () => []),
    waitForRange: vi.fn(async () => undefined),
  };
}
