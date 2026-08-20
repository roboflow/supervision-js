export enum DemoViewMode {
  Benchmarks = "benchmarks",
  Demo = "demo",
  Debug = "debug",
}

/**
 * Where the chosen view mode survives a reload, so a dev-server reload in the
 * middle of a Debug investigation does not drop the tab and its readouts.
 */
const STORAGE_KEY = "supervision-demo:view-mode";

const viewModes = new Set<string>(Object.values(DemoViewMode));

export function readStoredDemoViewMode(fallback: DemoViewMode): DemoViewMode {
  const stored = readStorage()?.getItem(STORAGE_KEY);

  return stored !== null && stored !== undefined && viewModes.has(stored)
    ? (stored as DemoViewMode)
    : fallback;
}

export function writeStoredDemoViewMode(mode: DemoViewMode): void {
  readStorage()?.setItem(STORAGE_KEY, mode);
}

function readStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Storage access throws outright when the browser blocks site data, and a
    // demo that cannot remember a tab is better than a demo that cannot boot.
    return null;
  }
}
