/** The four groups the inspector column is split into. */
export enum DemoInspectorTab {
  Clip = "clip",
  Style = "style",
  Session = "session",
  Diagnostics = "diagnostics",
}

/**
 * Where the chosen group survives a reload, so a dev-server reload in the
 * middle of reading one does not drop it.
 */
export const DEMO_INSPECTOR_TAB_STORAGE_KEY = "supervision-demo:inspector-tab";

const tabs = new Set<string>(Object.values(DemoInspectorTab));

export function readStoredDemoInspectorTab(
  fallback: DemoInspectorTab,
): DemoInspectorTab {
  const stored = readStorage()?.getItem(DEMO_INSPECTOR_TAB_STORAGE_KEY);

  return stored !== null && stored !== undefined && tabs.has(stored)
    ? (stored as DemoInspectorTab)
    : fallback;
}

export function writeStoredDemoInspectorTab(tab: DemoInspectorTab): void {
  readStorage()?.setItem(DEMO_INSPECTOR_TAB_STORAGE_KEY, tab);
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
