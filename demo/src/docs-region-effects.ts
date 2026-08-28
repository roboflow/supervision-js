import {
  RegionRendererCoverageKind,
  RegionRendererMediaEffectKind,
  annotationRenderers,
  type MediaRendererPresentation,
} from "supervision";

export const RegionEffectsPlaygroundMode = {
  Blur: "blur",
  Pixelate: "pixelate",
} as const;

export type RegionEffectsPlaygroundMode =
  (typeof RegionEffectsPlaygroundMode)[keyof typeof RegionEffectsPlaygroundMode];

export const RegionEffectsPlaygroundTarget = {
  WhiteTeam: "white team player",
  YellowTeam: "yellow team player",
} as const;

export type RegionEffectsPlaygroundTarget =
  (typeof RegionEffectsPlaygroundTarget)[keyof typeof RegionEffectsPlaygroundTarget];

export interface RegionEffectsPlaygroundSettings {
  readonly intensity: number;
  readonly mode: RegionEffectsPlaygroundMode;
  readonly targetClassName: RegionEffectsPlaygroundTarget;
}

const modeDefaults: Readonly<
  Record<RegionEffectsPlaygroundMode, RegionEffectsPlaygroundSettings>
> = {
  [RegionEffectsPlaygroundMode.Blur]: {
    intensity: 12,
    mode: RegionEffectsPlaygroundMode.Blur,
    targetClassName: RegionEffectsPlaygroundTarget.YellowTeam,
  },
  [RegionEffectsPlaygroundMode.Pixelate]: {
    intensity: 12,
    mode: RegionEffectsPlaygroundMode.Pixelate,
    targetClassName: RegionEffectsPlaygroundTarget.YellowTeam,
  },
};

export const initialRegionEffectsPlaygroundSettings =
  modeDefaults[RegionEffectsPlaygroundMode.Blur];

export function createRegionEffectsPlaygroundSettings(
  mode: RegionEffectsPlaygroundMode,
  targetClassName = initialRegionEffectsPlaygroundSettings.targetClassName,
): RegionEffectsPlaygroundSettings {
  return {
    ...modeDefaults[mode],
    targetClassName,
  };
}

export function createRegionEffectsPlaygroundPresentation(
  settings: RegionEffectsPlaygroundSettings,
  presentation: MediaRendererPresentation,
): MediaRendererPresentation {
  return {
    ...presentation,
    renderers: [
      annotationRenderers.region({
        compose: { mode: "over" },
        id: `${settings.targetClassName}-${settings.mode}`,
        region: { kind: "bounds" },
        source: {
          coverage: { kind: RegionRendererCoverageKind.Mask },
          effect:
            settings.mode === RegionEffectsPlaygroundMode.Blur
              ? {
                  kind: RegionRendererMediaEffectKind.Blur,
                  strength: settings.intensity,
                }
              : {
                  kind: RegionRendererMediaEffectKind.Pixelate,
                  size: settings.intensity,
                },
          kind: "media",
          region: { kind: "bounds" },
        },
        target: { className: settings.targetClassName },
      }),
    ],
  };
}

export function createRegionEffectsPlaygroundSnippet(
  settings: RegionEffectsPlaygroundSettings,
) {
  const effect =
    settings.mode === RegionEffectsPlaygroundMode.Blur
      ? `kind: "blur", strength: ${settings.intensity.toFixed(0)}`
      : `kind: "pixelate", size: ${settings.intensity.toFixed(0)}`;

  return `session.setPresentation({
  renderers: [
    annotationRenderers.region({
      id: "${settings.targetClassName}-${settings.mode}",
      target: { className: "${settings.targetClassName}" },
      source: {
        kind: "media",
        region: { kind: "bounds" },
        coverage: { kind: "mask" },
        effect: { ${effect} },
      },
      region: { kind: "bounds" },
      compose: { mode: "over" },
    }),
  ],
});`;
}
