import { afterEach, describe, expect, it } from "vitest";

import { createDemoRendererOptions } from "./demo-session-renderer";
import { DemoViewMode, writeStoredDemoViewMode } from "./demo-view-mode";

function useStorage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      clear: () => map.clear(),
      getItem: (key: string) => map.get(key) ?? null,
      key: () => null,
      length: 0,
      removeItem: (key: string) => map.delete(key),
      setItem: (key: string, value: string) => map.set(key, value),
    } as unknown as Storage,
  });
}

function rendererOptions() {
  return createDemoRendererOptions({
    container: {
      getBoundingClientRect: () => ({ height: 720, width: 1280 }),
    } as unknown as HTMLDivElement,
    onDetectionHover: () => {},
    onDetectionSelect: () => {},
    onFrame: () => {},
    onRendererState: () => {},
    onRenderPreparationDiagnostics: () => {},
    onSourceState: () => {},
    renderQuality: undefined,
  });
}

describe("createDemoRendererOptions", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("times every layer of a present only for the view that reads the numbers", () => {
    useStorage({});
    writeStoredDemoViewMode(DemoViewMode.Debug);

    expect(rendererOptions().diagnostics?.frameTimings).toBe(true);
  });

  it("leaves the timing off for the view a viewer watches", () => {
    useStorage({});
    writeStoredDemoViewMode(DemoViewMode.Demo);

    expect(rendererOptions().diagnostics?.frameTimings).toBe(false);
  });
});
