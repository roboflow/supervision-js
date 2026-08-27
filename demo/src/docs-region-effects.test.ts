import { describe, expect, it } from "vitest";
import {
  FocusTargetMode,
  RegionRendererCoverageKind,
  RegionRendererMediaEffectKind,
} from "supervision";
import {
  RegionEffectsPlaygroundMode,
  createRegionEffectsPlaygroundPresentation,
  createRegionEffectsPlaygroundSettings,
  createRegionEffectsPlaygroundSnippet,
} from "./docs-region-effects";

describe("region effects documentation playground", () => {
  it("uses one mask-covered media region for blur and pixelation", () => {
    const presentation = createRegionEffectsPlaygroundPresentation(
      createRegionEffectsPlaygroundSettings(RegionEffectsPlaygroundMode.Blur),
      {},
    );

    expect(presentation.renderers).toEqual([
      expect.objectContaining({
        kind: "region",
        source: expect.objectContaining({
          coverage: { kind: RegionRendererCoverageKind.Mask },
          effect: {
            kind: RegionRendererMediaEffectKind.Blur,
            strength: 12,
          },
          kind: "media",
        }),
      }),
    ]);
    expect(
      createRegionEffectsPlaygroundSnippet(
        createRegionEffectsPlaygroundSettings(
          RegionEffectsPlaygroundMode.Pixelate,
        ),
      ),
    ).toContain('effect: { kind: "pixelate", size: 12 }');
  });

  it("reuses focus instead of adding a competing background renderer", () => {
    const presentation = createRegionEffectsPlaygroundPresentation(
      createRegionEffectsPlaygroundSettings(
        RegionEffectsPlaygroundMode.Spotlight,
      ),
      {},
    );

    expect(presentation.renderers).toEqual([]);
    expect(presentation.focusStyle?.resolve).toEqual(expect.any(Function));
    expect(
      createRegionEffectsPlaygroundSnippet(
        createRegionEffectsPlaygroundSettings(
          RegionEffectsPlaygroundMode.Spotlight,
        ),
      ),
    ).toContain("FocusTargetMode.Ambient");
    expect(FocusTargetMode.Ambient).toBe("ambient");
  });
});
