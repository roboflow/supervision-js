import {
  BaseFocusStyle,
  FocusTargetMode,
  RegionRendererCoverageKind,
  RegionRendererMediaEffectKind,
  annotationRenderers,
  type MediaRendererPresentation,
} from "supervision";

export const RegionEffectsPlaygroundMode = {
  Blur: "blur",
  Pixelate: "pixelate",
  Spotlight: "spotlight",
} as const;

export type RegionEffectsPlaygroundMode =
  (typeof RegionEffectsPlaygroundMode)[keyof typeof RegionEffectsPlaygroundMode];

export interface RegionEffectsPlaygroundSettings {
  readonly intensity: number;
  readonly mode: RegionEffectsPlaygroundMode;
}

const modeDefaults: Readonly<
  Record<RegionEffectsPlaygroundMode, RegionEffectsPlaygroundSettings>
> = {
  [RegionEffectsPlaygroundMode.Blur]: {
    intensity: 12,
    mode: RegionEffectsPlaygroundMode.Blur,
  },
  [RegionEffectsPlaygroundMode.Pixelate]: {
    intensity: 12,
    mode: RegionEffectsPlaygroundMode.Pixelate,
  },
  [RegionEffectsPlaygroundMode.Spotlight]: {
    intensity: 0.55,
    mode: RegionEffectsPlaygroundMode.Spotlight,
  },
};

export const initialRegionEffectsPlaygroundSettings =
  modeDefaults[RegionEffectsPlaygroundMode.Blur];

export function createRegionEffectsPlaygroundSettings(
  mode: RegionEffectsPlaygroundMode,
): RegionEffectsPlaygroundSettings {
  return modeDefaults[mode];
}

export function createRegionEffectsPlaygroundPresentation(
  settings: RegionEffectsPlaygroundSettings,
  presentation: MediaRendererPresentation,
): MediaRendererPresentation {
  if (settings.mode === RegionEffectsPlaygroundMode.Spotlight) {
    return {
      ...presentation,
      focusStyle: new BaseFocusStyle({
        fill: { alpha: settings.intensity, color: 0x020617 },
        targetMode: FocusTargetMode.Ambient,
      }),
      renderers: [],
    };
  }

  return {
    ...presentation,
    focusStyle: null,
    renderers: [
      annotationRenderers.region({
        compose: { mode: "over" },
        id: `person-${settings.mode}`,
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
        target: { className: "person" },
      }),
    ],
  };
}

export function createRegionEffectsPlaygroundSnippet(
  settings: RegionEffectsPlaygroundSettings,
) {
  if (settings.mode === RegionEffectsPlaygroundMode.Spotlight) {
    return `session.setPresentation({
  focusStyle: new BaseFocusStyle({
    targetMode: FocusTargetMode.Ambient,
    fill: { color: 0x020617, alpha: ${settings.intensity.toFixed(2)} },
  }),
  renderers: [],
});`;
  }

  const effect =
    settings.mode === RegionEffectsPlaygroundMode.Blur
      ? `kind: "blur", strength: ${settings.intensity.toFixed(0)}`
      : `kind: "pixelate", size: ${settings.intensity.toFixed(0)}`;

  return `session.setPresentation({
  renderers: [
    annotationRenderers.region({
      id: "person-${settings.mode}",
      target: { className: "person" },
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
