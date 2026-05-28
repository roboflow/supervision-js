import { describe, expect, it } from "vitest";

import { createBrowserColdDetectionFrameStore } from "#detections/browser-cold-detection-frame-store";

describe("browser cold detection frame store", () => {
  it("rejects with a helpful error when indexedDB is unavailable", async () => {
    const store = createBrowserColdDetectionFrameStore({
      databaseName: "supervision-js-test-unavailable",
    });
    const expectedError =
      "Browser cold detection frame store requires indexedDB, but it is not available in this environment.";

    await expect(
      store.loadFrames({
        datasetId: "dataset",
        endTime: 1,
        startTime: 0,
      }),
    ).rejects.toThrow(expectedError);
    await expect(
      store.putFrames({
        datasetId: "dataset",
        frames: [],
      }),
    ).rejects.toThrow(expectedError);
    await expect(store.clearDataset("dataset")).rejects.toThrow(expectedError);
  });
});
