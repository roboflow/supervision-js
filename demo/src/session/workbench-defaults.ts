import { readDemoMediaPathOverride } from "./media-path-override";
import { DemoMediaPath, type DemoSessionOptions } from "./session-options";

/**
 * The media path the workbench opens on. Mediabunny is what
 * `createMediaSession` reaches for when it is handed a clip and nothing else,
 * so the workbench opens on what someone arriving from the library's docs
 * already has.
 */
export const DEMO_DEFAULT_MEDIA_PATH = DemoMediaPath.Mediabunny;

const requestedMediaPath = readDemoMediaPathOverride(
  typeof location === "undefined" ? "" : location.search,
);

/**
 * The options the workbench opens a clip on, over the ones the library would
 * pick for itself.
 *
 * Reset hands these back. An absent `mediaPath` is not "whatever the library
 * does", it is the engine, so clearing the key would move the session onto a
 * path nobody asked for.
 */
export const demoInitialSessionOptions: DemoSessionOptions = {
  mediaPath: requestedMediaPath ?? DEMO_DEFAULT_MEDIA_PATH,
};

/** How many options the visitor has moved off what the workbench opened on. */
export function countChangedDemoSessionOptions(
  options: DemoSessionOptions,
): number {
  const keys = new Set<keyof DemoSessionOptions>([
    ...(Object.keys(options) as (keyof DemoSessionOptions)[]),
    ...(Object.keys(demoInitialSessionOptions) as (keyof DemoSessionOptions)[]),
  ]);

  return [...keys].filter(
    (key) => options[key] !== demoInitialSessionOptions[key],
  ).length;
}
