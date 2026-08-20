import { describe, expect, it } from "vitest";
import {
  createRegionPlaygroundRenderers,
  createRegionPlaygroundSettings,
  createRegionPlaygroundSnippet,
  RegionPlaygroundMode,
} from "./docs-region-annotation-renderer";

const assets = {
  fireGif: "/fire.gif",
  whiteTeamBadge: "/white-team.svg",
  yellowTeamBadge: "/yellow-team.svg",
};

describe("docs region annotation renderer", () => {
  it("renders class-specific icons through multiple region descriptors", () => {
    const settings = {
      ...createRegionPlaygroundSettings(RegionPlaygroundMode.StaticIcons),
      offsetY: -0.8,
      rotationDegrees: 15,
      scale: 1.2,
    };
    const renderers = createRegionPlaygroundRenderers(settings, assets);

    expect(renderers).toHaveLength(2);
    expect(renderers).toMatchObject([
      {
        id: "white-team-badge",
        kind: "region",
        region: { anchor: "head", kind: "keypoint-anchor" },
        source: { asset: { src: assets.whiteTeamBadge }, kind: "asset" },
        target: { className: "white team player" },
      },
      {
        id: "yellow-team-badge",
        kind: "region",
        source: { asset: { src: assets.yellowTeamBadge }, kind: "asset" },
        target: { className: "yellow team player" },
      },
    ]);
    expect(renderers[0]?.transform).toMatchObject({
      offset: { x: 0, y: -0.8 },
      rotation: Math.PI / 12,
      scale: 1.2,
    });
  });

  it("keeps the animated GIF example on the same region API", () => {
    const settings = createRegionPlaygroundSettings(
      RegionPlaygroundMode.AnimatedGif,
    );

    expect(createRegionPlaygroundRenderers(settings, assets)).toMatchObject([
      {
        id: "player-fire",
        kind: "region",
        source: { asset: { src: assets.fireGif }, kind: "asset" },
        target: {
          className: ["white team player", "yellow team player"],
        },
      },
    ]);
  });

  it("crops the current media frame for the big-head example", () => {
    const settings = {
      ...createRegionPlaygroundSettings(RegionPlaygroundMode.MediaCrop),
      flipHorizontal: true,
      offsetY: -0.1,
      scale: 3,
    };

    expect(createRegionPlaygroundRenderers(settings, assets)).toMatchObject([
      {
        id: "player-big-heads",
        kind: "region",
        region: { anchor: "head", kind: "keypoint-anchor" },
        source: {
          kind: "media",
          region: { anchor: "head", kind: "keypoint-anchor" },
        },
        target: {
          className: ["white team player", "yellow team player"],
        },
        transform: {
          flip: { horizontal: true },
          offset: { x: 0, y: -0.1 },
          scale: 3,
        },
      },
    ]);
  });

  it("keeps the selected asset type and live transforms in the snippet", () => {
    const icons = createRegionPlaygroundSnippet({
      ...createRegionPlaygroundSettings(RegionPlaygroundMode.StaticIcons),
      offsetY: -0.75,
      rotationDegrees: 30,
      scale: 1.1,
    });
    const animated = createRegionPlaygroundSnippet(
      createRegionPlaygroundSettings(RegionPlaygroundMode.AnimatedGif),
    );
    const mediaCrop = createRegionPlaygroundSnippet({
      ...createRegionPlaygroundSettings(RegionPlaygroundMode.MediaCrop),
      flipHorizontal: true,
    });

    expect(icons).toContain("id, className, src");
    expect(icons).toContain("offset: { x: 0, y: -0.75 }");
    expect(icons).toContain("rotation: 0.52");
    expect(icons).toContain("scale: 1.10");
    expect(animated).toContain("asset: { src: fireGifUrl }");
    expect(mediaCrop).toContain('kind: "media"');
    expect(mediaCrop).toContain("flip: { horizontal: true }");
  });
});
