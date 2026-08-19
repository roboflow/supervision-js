const PRESENT_PARAMETER = "present";
const ENGINE_PRESENTATION = "engine";

/**
 * Reads the switch that runs the renderer against the video engine's presented
 * frames instead of the mediabunny pull path.
 */
export function isEnginePresentationRequested(search: string): boolean {
  return (
    new URLSearchParams(search).get(PRESENT_PARAMETER) === ENGINE_PRESENTATION
  );
}
