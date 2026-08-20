import { afterEach, describe, expect, it } from "vitest";

import {
  DemoViewMode,
  readStoredDemoViewMode,
  writeStoredDemoViewMode,
} from "./demo-view-mode";

const STORAGE_KEY = "supervision-demo:view-mode";

function useStorage(storage: Storage | undefined) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
}

function createMemoryStorage(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));

  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  } satisfies Storage;
}

afterEach(() => {
  useStorage(undefined);
});

describe("demo view mode persistence", () => {
  it("returns the fallback when nothing was stored", () => {
    useStorage(createMemoryStorage());

    expect(readStoredDemoViewMode(DemoViewMode.Demo)).toBe(DemoViewMode.Demo);
  });

  it("reads back the mode that was written", () => {
    const storage = createMemoryStorage();
    useStorage(storage);

    writeStoredDemoViewMode(DemoViewMode.Debug);

    expect(storage.getItem(STORAGE_KEY)).toBe("debug");
    expect(readStoredDemoViewMode(DemoViewMode.Demo)).toBe(DemoViewMode.Debug);
  });

  it("falls back when the stored value is not a view mode", () => {
    useStorage(createMemoryStorage({ [STORAGE_KEY]: "inspector" }));

    expect(readStoredDemoViewMode(DemoViewMode.Demo)).toBe(DemoViewMode.Demo);
  });

  it("falls back when storage is unreachable", () => {
    useStorage(undefined);

    expect(readStoredDemoViewMode(DemoViewMode.Debug)).toBe(DemoViewMode.Debug);
  });
});
