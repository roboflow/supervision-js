import { describe, expect, it, vi } from "vitest";

import type { DetectionFrameSource } from "supervision-js-core";
import {
  createMemoryColdDetectionFrameStore,
  createWritableDetectionFrameSource,
} from "supervision-js-core";
import {
  MediaSessionMode,
  type MediaSessionDetectionSourceOptions,
} from "#types/media-session";

import { prepareSessionDetections } from "./media-session-detections";

const range = { endTime: 2, startTime: 1 };

describe("session detection sources", () => {
  it("keeps an append-only lookalike readable without registering it as writable", async () => {
    const source = {
      ...createSource(),
      appendFrames: vi.fn(),
      datasetId: "partial",
      getVersion() {
        expect(this).toBe(source);
        return 3;
      },
      destroy: vi.fn(),
    };
    const prepared = await prepareSessionDetections({
      detections: { source },
      mode: MediaSessionMode.File,
    });

    expect(prepared.appendableSource).toBeUndefined();
    expect(prepared.appendableSources.size).toBe(0);
    expect(prepared.detectionSource?.getVersion?.()).toBe(3);
    await prepared.detectionSource?.loadFrames(0, 1);
    expect(source.loadFrames).toHaveBeenCalledWith(0, 1);
    prepared.detectionSource?.destroy?.();
    expect(source.destroy).not.toHaveBeenCalled();
  });

  it("registers external writable sources by entry id and leaves read-only sources out", async () => {
    const first = createWritableDetectionFrameSource({
      datasetId: "first-dataset",
      store: createMemoryColdDetectionFrameStore(),
    });
    const second = createWritableDetectionFrameSource({
      datasetId: "second-dataset",
      store: createMemoryColdDetectionFrameStore(),
    });
    const prepared = await prepareSessionDetections({
      detections: {
        sources: [
          { id: "first", source: first },
          { id: "second", source: second },
          { id: "read-only", source: createSource() },
        ],
      },
      mode: MediaSessionMode.File,
    });

    expect([...prepared.appendableSources]).toEqual([
      ["first", first],
      ["second", second],
    ]);
    first.destroy?.();
    second.destroy?.();
  });

  it("does not destroy an external source when a later owned source fails to open", async () => {
    const external = createWritableDetectionFrameSource({
      datasetId: "external",
      store: createMemoryColdDetectionFrameStore(),
    });
    const destroy = vi.spyOn(external, "destroy");
    const store = createMemoryColdDetectionFrameStore();
    vi.spyOn(store, "clearDataset").mockRejectedValue(
      new Error("clear failed"),
    );

    await expect(
      prepareSessionDetections({
        detections: {
          sources: [
            { id: "external", source: external },
            {
              id: "owned",
              appendable: { clearOnCreate: true, datasetId: "owned", store },
            },
          ],
        },
        mode: MediaSessionMode.File,
      }),
    ).rejects.toThrow("clear failed");

    expect(destroy).not.toHaveBeenCalled();
    external.destroy?.();
  });

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
