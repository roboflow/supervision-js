import { DemoMediaPath } from "./session-options";

/**
 * The media path named in the page's query string, so a harness can pin which
 * reader opens the clip. Without it a run measures whichever path the
 * workbench happens to open on, and reports it as the engine's number.
 */
export function readDemoMediaPathOverride(
  search: string,
): DemoMediaPath | null {
  const requested = new URLSearchParams(search).get("mediaPath");
  const supported: readonly DemoMediaPath[] = Object.values(DemoMediaPath);

  return supported.find((path) => path === requested) ?? null;
}
