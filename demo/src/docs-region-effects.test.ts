import { describe, expect, it } from "vitest";
import {
  RegionRendererCoverageKind,
  RegionRendererMediaEffectKind,
} from "supervision";
import {
  RegionEffectsPlaygroundMode,
  RegionEffectsPlaygroundTarget,
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
        target: {
          className: RegionEffectsPlaygroundTarget.YellowTeam,
        },
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

  it("keeps the selected basketball class in the renderer and code snippet", () => {
    const settings = createRegionEffectsPlaygroundSettings(
      RegionEffectsPlaygroundMode.Pixelate,
      RegionEffectsPlaygroundTarget.WhiteTeam,
    );
    const presentation = createRegionEffectsPlaygroundPresentation(
      settings,
      {},
    );

    expect(presentation.renderers?.[0]).toMatchObject({
      target: { className: RegionEffectsPlaygroundTarget.WhiteTeam },
    });
    expect(createRegionEffectsPlaygroundSnippet(settings)).toContain(
      'target: { className: "white team player" }',
    );
  });
});
