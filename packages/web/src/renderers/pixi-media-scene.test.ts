import { describe, expect, it } from "vitest";

import { canReuseMaskVisibilityArtifacts } from "./pixi-media-scene";

describe("Pixi media scene mask visibility", () => {
  it("reuses mask artifacts across equivalent visibility objects", () => {
    expect(
      canReuseMaskVisibilityArtifacts(
        {
          ephemeralDetectionIds: new Set(["preview"]),
          hiddenClasses: ["car"],
          hiddenDetectionIds: new Set(["hidden"]),
          loadingDetectionIds: ["loading"],
        },
        {
          ephemeralDetectionIds: ["preview"],
          hiddenClasses: new Set(["car"]),
          hiddenDetectionIds: ["hidden"],
          loadingDetectionIds: new Set(["loading"]),
        },
      ),
    ).toBe(true);
  });

  it("ignores label-only visibility changes for mask artifacts", () => {
    expect(
      canReuseMaskVisibilityArtifacts(
        { labelsHidden: false },
        { labelsHidden: true },
      ),
    ).toBe(true);
  });

  it.each([
    [{}, { annotationsHidden: true }],
    [{}, { creatingDetectionId: "draft" }],
    [{}, { ephemeralDetectionIds: ["preview"] }],
    [{}, { hiddenClasses: ["car"] }],
    [{}, { hiddenDetectionIds: ["hidden"] }],
    [{}, { loadingDetectionIds: ["loading"] }],
  ])(
    "invalidates mask artifacts when mask visibility changes",
    (previous, next) => {
      expect(canReuseMaskVisibilityArtifacts(previous, next)).toBe(false);
    },
  );
});
