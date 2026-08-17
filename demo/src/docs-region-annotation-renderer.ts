import {
  annotationRenderers,
  type RegionAnnotationRenderer,
} from "supervision";

export const RegionPlaygroundMode = {
  AnimatedGif: "animated-gif",
  StaticIcons: "static-icons",
} as const;

export type RegionPlaygroundMode =
  (typeof RegionPlaygroundMode)[keyof typeof RegionPlaygroundMode];

export interface RegionPlaygroundSettings {
  readonly mode: RegionPlaygroundMode;
  readonly offsetY: number;
  readonly rotationDegrees: number;
  readonly scale: number;
}

export interface RegionPlaygroundAssets {
  readonly fireGif: string;
  readonly whiteTeamBadge: string;
  readonly yellowTeamBadge: string;
}

const modeDefaults: Readonly<
  Record<RegionPlaygroundMode, RegionPlaygroundSettings>
> = {
  [RegionPlaygroundMode.AnimatedGif]: {
    mode: RegionPlaygroundMode.AnimatedGif,
    offsetY: -0.58,
    rotationDegrees: 0,
    scale: 1.35,
  },
  [RegionPlaygroundMode.StaticIcons]: {
    mode: RegionPlaygroundMode.StaticIcons,
    offsetY: -1.05,
    rotationDegrees: 0,
    scale: 0.95,
  },
};

export const initialRegionPlaygroundSettings =
  modeDefaults[RegionPlaygroundMode.StaticIcons];

export function createRegionPlaygroundSettings(
  mode: RegionPlaygroundMode,
): RegionPlaygroundSettings {
  return modeDefaults[mode];
}

export function createRegionPlaygroundRenderers(
  settings: RegionPlaygroundSettings,
  assets: RegionPlaygroundAssets,
): readonly RegionAnnotationRenderer[] {
  if (settings.mode === RegionPlaygroundMode.AnimatedGif) {
    return [
      createRegionRenderer({
        assetUrl: assets.fireGif,
        className: ["white team player", "yellow team player"],
        id: "player-fire",
        settings,
      }),
    ];
  }

  return [
    createRegionRenderer({
      assetUrl: assets.whiteTeamBadge,
      className: "white team player",
      id: "white-team-badge",
      settings,
    }),
    createRegionRenderer({
      assetUrl: assets.yellowTeamBadge,
      className: "yellow team player",
      id: "yellow-team-badge",
      settings,
    }),
  ];
}

export function createRegionPlaygroundSnippet(
  settings: RegionPlaygroundSettings,
) {
  const transform = `transform: {
        scale: ${settings.scale.toFixed(2)},
        offset: { x: 0, y: ${settings.offsetY.toFixed(2)} },
        rotation: ${degreesToRadians(settings.rotationDegrees).toFixed(2)},
      }`;

  if (settings.mode === RegionPlaygroundMode.AnimatedGif) {
    return `session.setPresentation({
  renderers: [
    annotationRenderers.region({
      id: "player-fire",
      target: { className: ["white team player", "yellow team player"] },
      source: { kind: "asset", asset: { src: fireGifUrl } },
      region: { kind: "keypoint-anchor", anchor: "head" },
      ${transform},
      compose: { mode: "over" },
    }),
  ],
});`;
  }

  return `const teamBadges = [
  ["white-team-badge", "white team player", whiteBadgeUrl],
  ["yellow-team-badge", "yellow team player", yellowBadgeUrl],
];

session.setPresentation({
  renderers: teamBadges.map(([id, className, src]) =>
    annotationRenderers.region({
      id,
      target: { className },
      source: { kind: "asset", asset: { src } },
      region: { kind: "keypoint-anchor", anchor: "head" },
      ${transform},
      compose: { mode: "over" },
    }),
  ),
});`;
}

function createRegionRenderer(options: {
  readonly assetUrl: string;
  readonly className: string | readonly string[];
  readonly id: string;
  readonly settings: RegionPlaygroundSettings;
}) {
  return annotationRenderers.region({
    compose: { mode: "over" },
    id: options.id,
    region: { anchor: "head", kind: "keypoint-anchor" },
    source: { asset: { src: options.assetUrl }, kind: "asset" },
    target: { className: options.className },
    transform: {
      offset: { x: 0, y: options.settings.offsetY },
      rotation: degreesToRadians(options.settings.rotationDegrees),
      scale: options.settings.scale,
    },
  });
}

function degreesToRadians(degrees: number) {
  return (degrees * Math.PI) / 180;
}
