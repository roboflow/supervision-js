import { afterEach, describe, expect, it } from "vitest";

import { createBrowserColdDetectionFrameStore } from "#detections/browser-cold-detection-frame-store";
import type { DetectionFrame } from "#types/detections";

describe("browser cold detection frame store", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "indexedDB");
    Reflect.deleteProperty(globalThis, "IDBKeyRange");
  });

  it("rejects with a helpful error when indexedDB is unavailable", async () => {
    const store = createBrowserColdDetectionFrameStore({
      databaseName: "supervision-js-test-unavailable",
    });
    const expectedError =
      "Browser cold detection frame store requires indexedDB, but it is not available in this environment.";

    await expect(
      store.loadFrames({
        datasetId: "dataset",
        endTime: 1,
        startTime: 0,
      }),
    ).rejects.toThrow(expectedError);
    await expect(
      store.putFrames({
        datasetId: "dataset",
        frames: [],
      }),
    ).rejects.toThrow(expectedError);
    await expect(store.clearDataset("dataset")).rejects.toThrow(expectedError);
  });

  it("loads interval frames that overlap the requested range without duplicates", async () => {
    installMemoryIndexedDb();
    const store = createBrowserColdDetectionFrameStore({
      databaseName: "supervision-js-test-overlap",
    });
    const frames: DetectionFrame[] = [
      {
        detections: [{ id: "a" }],
        endTime: 2.5,
        frameIndex: 0,
        mediaTime: 0.5,
      },
      {
        detections: [{ id: "b" }],
        endTime: 3.5,
        frameIndex: 1,
        mediaTime: 2.5,
      },
    ];

    await store.putFrames({
      chunkDurationSeconds: 1,
      datasetId: "dataset",
      frames,
    });

    const loadedFrames = await store.loadFrames({
      datasetId: "dataset",
      endTime: 2.75,
      startTime: 2.25,
    });

    expect(loadedFrames.map((frame) => frame.frameIndex)).toEqual([0, 1]);
  });
});

function installMemoryIndexedDb() {
  const databases = new Map<string, MemoryDatabaseState>();

  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open(databaseName: string) {
        const request = createRequest<MemoryDatabase>();

        queueMicrotask(() => {
          const state =
            databases.get(databaseName) ??
            new MemoryDatabaseState(databaseName);

          databases.set(databaseName, state);
          request.result = new MemoryDatabase(state);
          request.transaction = new MemoryTransaction(state, "versionchange");
          request.onupgradeneeded?.();
          request.onsuccess?.();
        });

        return request;
      },
    },
  });
  Object.defineProperty(globalThis, "IDBKeyRange", {
    configurable: true,
    value: {
      only(value: unknown) {
        return { only: value };
      },
    },
  });
}

class MemoryDatabaseState {
  readonly stores = new Map<string, Map<string, unknown>>();

  constructor(readonly name: string) {}
}

class MemoryDatabase {
  constructor(private readonly state: MemoryDatabaseState) {}

  get objectStoreNames() {
    return {
      contains: (storeName: string) => this.state.stores.has(storeName),
    };
  }

  createObjectStore(storeName: string) {
    this.state.stores.set(storeName, new Map());
    return new MemoryObjectStore(this.state, storeName);
  }

  transaction(
    storeNames: string | readonly string[],
    mode?: IDBTransactionMode,
  ) {
    return new MemoryTransaction(this.state, mode, storeNames);
  }

  close() {}
}

class MemoryTransaction {
  onabort: (() => void) | null = null;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly error = null;

  constructor(
    private readonly state: MemoryDatabaseState,
    readonly mode?: IDBTransactionMode | "versionchange",
    readonly storeNames?: string | readonly string[],
  ) {
    queueMicrotask(() => {
      this.oncomplete?.();
    });
  }

  objectStore(storeName: string) {
    if (!this.state.stores.has(storeName)) {
      this.state.stores.set(storeName, new Map());
    }

    return new MemoryObjectStore(this.state, storeName);
  }
}

class MemoryObjectStore {
  constructor(
    private readonly state: MemoryDatabaseState,
    private readonly storeName: string,
  ) {}

  get indexNames() {
    return {
      contains: () => true,
    };
  }

  createIndex() {}

  put(record: unknown) {
    this.records.set(
      stringifyKey(getRecordKey(record)),
      structuredClone(record),
    );
  }

  get(key: unknown) {
    const request = createRequest<unknown>();

    queueMicrotask(() => {
      request.result = structuredClone(this.records.get(stringifyKey(key)));
      request.onsuccess?.();
    });

    return request;
  }

  delete(key: unknown) {
    this.records.delete(stringifyKey(key));
  }

  index() {
    return new MemoryIndex(this.records);
  }

  private get records() {
    return this.state.stores.get(this.storeName)!;
  }
}

class MemoryIndex {
  constructor(private readonly records: Map<string, unknown>) {}

  openCursor(range: { readonly only: unknown }) {
    const request = createRequest<MemoryCursor | undefined>();
    const matchingKeys = Array.from(this.records.entries())
      .filter(([, record]) => getDatasetId(record) === range.only)
      .map(([key]) => key);
    const index = 0;
    const advance = () => {
      request.result =
        index < matchingKeys.length
          ? new MemoryCursor(this.records, matchingKeys[index]!, advance)
          : undefined;
      request.onsuccess?.();
    };

    queueMicrotask(advance);

    return request;
  }
}

class MemoryCursor {
  constructor(
    private readonly records: Map<string, unknown>,
    private readonly key: string,
    private readonly advance: () => void,
  ) {}

  delete() {
    this.records.delete(this.key);
  }

  continue() {
    this.advance();
  }
}

interface MemoryRequest<T> {
  error: null;
  onerror: (() => void) | null;
  onsuccess: (() => void) | null;
  onupgradeneeded: (() => void) | null;
  result: T;
  transaction: MemoryTransaction | null;
}

function createRequest<T>() {
  const request: MemoryRequest<T> = {
    error: null,
    onerror: null,
    onsuccess: null,
    onupgradeneeded: null,
    result: undefined as T,
    transaction: null,
  };

  return request;
}

function getRecordKey(record: unknown) {
  if (record && typeof record === "object" && "key" in record) {
    return record.key;
  }

  if (record && typeof record === "object" && "datasetId" in record) {
    return record.datasetId;
  }

  throw new Error("Memory IndexedDB record is missing a key.");
}

function getDatasetId(record: unknown) {
  return record && typeof record === "object" && "datasetId" in record
    ? record.datasetId
    : undefined;
}

function stringifyKey(key: unknown) {
  return JSON.stringify(key);
}
