import type {
  ColdDetectionFrameStore,
  ColdDetectionFrameStoreLoadOptions,
  ColdDetectionFrameStoreWriteOptions,
  ColdDetectionFrameStoreWriteSummary,
} from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";
import { copySortedDetectionFrames } from "#utils/detection-frames";

const DEFAULT_DATABASE_NAME = "supervision-js-detection-frames";
const DEFAULT_CHUNK_DURATION_SECONDS = 1;
const DATABASE_VERSION = 1;
const CHUNK_STORE_NAME = "detectionFrameChunks";
const DATASET_STORE_NAME = "detectionFrameDatasets";
const DATASET_ID_INDEX_NAME = "datasetId";

type ChunkKey = [string, number, number];

interface DetectionFrameChunkRecord {
  readonly key: ChunkKey;
  readonly datasetId: string;
  readonly chunkIndex: number;
  readonly chunkDurationSeconds: number;
  readonly frames: readonly DetectionFrame[];
}

interface DetectionFrameDatasetRecord extends ColdDetectionFrameStoreWriteSummary {
  readonly datasetId: string;
}

export function createBrowserColdDetectionFrameStore(options?: {
  readonly databaseName?: string;
}): ColdDetectionFrameStore {
  const databaseName = options?.databaseName ?? DEFAULT_DATABASE_NAME;
  let databasePromise: Promise<IDBDatabase> | undefined;
  let database: IDBDatabase | undefined;
  let destroyed = false;

  const getDatabase = async () => {
    if (destroyed) {
      throw new Error("Cold detection frame store has been destroyed.");
    }

    databasePromise ??= openDetectionFrameDatabase(databaseName).then(
      (openedDatabase) => {
        database = openedDatabase;
        return openedDatabase;
      },
    );

    return databasePromise;
  };

  const clearDataset = async (datasetId: string) => {
    const openedDatabase = await getDatabase();
    const transaction = openedDatabase.transaction(
      [CHUNK_STORE_NAME, DATASET_STORE_NAME],
      "readwrite",
    );
    const transactionDone = waitForTransaction(transaction);
    const chunkStore = transaction.objectStore(CHUNK_STORE_NAME);
    const datasetStore = transaction.objectStore(DATASET_STORE_NAME);

    datasetStore.delete(datasetId);
    await deleteRecordsByDatasetId(
      chunkStore.index(DATASET_ID_INDEX_NAME),
      datasetId,
    );
    await transactionDone;
  };

  return {
    async putFrames(writeOptions: ColdDetectionFrameStoreWriteOptions) {
      const chunkDurationSeconds =
        writeOptions.chunkDurationSeconds ?? DEFAULT_CHUNK_DURATION_SECONDS;

      if (chunkDurationSeconds <= 0) {
        throw new Error("chunkDurationSeconds must be greater than 0.");
      }

      const frames = copySortedDetectionFrames(writeOptions.frames);
      const chunks = createChunkRecords({
        chunkDurationSeconds,
        datasetId: writeOptions.datasetId,
        frames,
      });
      const summary = createWriteSummary({
        chunkCount: chunks.length,
        chunkDurationSeconds,
        datasetId: writeOptions.datasetId,
        frames,
      });

      await clearDataset(writeOptions.datasetId);

      const openedDatabase = await getDatabase();
      const transaction = openedDatabase.transaction(
        [CHUNK_STORE_NAME, DATASET_STORE_NAME],
        "readwrite",
      );
      const transactionDone = waitForTransaction(transaction);
      const chunkStore = transaction.objectStore(CHUNK_STORE_NAME);
      const datasetStore = transaction.objectStore(DATASET_STORE_NAME);

      for (const chunk of chunks) {
        chunkStore.put(chunk);
      }

      datasetStore.put(summary);
      await transactionDone;

      return summary;
    },

    async loadFrames(loadOptions: ColdDetectionFrameStoreLoadOptions) {
      const openedDatabase = await getDatabase();
      const dataset = await loadDatasetRecord(
        openedDatabase,
        loadOptions.datasetId,
      );

      if (!dataset) {
        return [];
      }

      const startTime = Math.max(0, loadOptions.startTime);
      const endTime = Math.max(startTime, loadOptions.endTime);
      const chunkKeys = createChunkKeys({
        chunkDurationSeconds: dataset.chunkDurationSeconds,
        datasetId: loadOptions.datasetId,
        endTime,
        startTime,
      });

      if (chunkKeys.length === 0) {
        return [];
      }

      const transaction = openedDatabase.transaction(CHUNK_STORE_NAME);
      const transactionDone = waitForTransaction(transaction);
      const chunkStore = transaction.objectStore(CHUNK_STORE_NAME);
      const chunkRequests = chunkKeys.map((key) =>
        requestToPromise<DetectionFrameChunkRecord | undefined>(
          chunkStore.get(key),
        ),
      );
      const chunkRecords = await Promise.all(chunkRequests);

      await transactionDone;

      return copySortedDetectionFrames(
        chunkRecords
          .filter((chunk): chunk is DetectionFrameChunkRecord => !!chunk)
          .flatMap((chunk) => chunk.frames)
          .filter(
            (frame) =>
              frame.mediaTime >= startTime && frame.mediaTime <= endTime,
          ),
      );
    },

    async clearDataset(datasetId: string) {
      await clearDataset(datasetId);
    },

    destroy() {
      destroyed = true;
      database?.close();
      database = undefined;
      databasePromise = undefined;
    },
  };
}

function createChunkRecords(options: {
  readonly datasetId: string;
  readonly frames: readonly DetectionFrame[];
  readonly chunkDurationSeconds: number;
}) {
  const chunks = new Map<number, DetectionFrame[]>();

  for (const frame of options.frames) {
    const chunkIndex = getChunkIndex(
      frame.mediaTime,
      options.chunkDurationSeconds,
    );
    const chunkFrames = chunks.get(chunkIndex) ?? [];

    chunkFrames.push(frame);
    chunks.set(chunkIndex, chunkFrames);
  }

  return Array.from(chunks.entries()).map(
    ([chunkIndex, frames]): DetectionFrameChunkRecord => ({
      chunkDurationSeconds: options.chunkDurationSeconds,
      chunkIndex,
      datasetId: options.datasetId,
      frames,
      key: createChunkKey(
        options.datasetId,
        options.chunkDurationSeconds,
        chunkIndex,
      ),
    }),
  );
}

function createChunkKeys(options: {
  readonly datasetId: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly chunkDurationSeconds: number;
}) {
  const startChunkIndex = getChunkIndex(
    options.startTime,
    options.chunkDurationSeconds,
  );
  const endChunkIndex = getChunkIndex(
    options.endTime,
    options.chunkDurationSeconds,
  );
  const keys: ChunkKey[] = [];

  for (
    let chunkIndex = startChunkIndex;
    chunkIndex <= endChunkIndex;
    chunkIndex += 1
  ) {
    keys.push(
      createChunkKey(
        options.datasetId,
        options.chunkDurationSeconds,
        chunkIndex,
      ),
    );
  }

  return keys;
}

function createChunkKey(
  datasetId: string,
  chunkDurationSeconds: number,
  chunkIndex: number,
): ChunkKey {
  return [datasetId, chunkDurationSeconds, chunkIndex];
}

function getChunkIndex(mediaTime: number, chunkDurationSeconds: number) {
  return Math.floor(mediaTime / chunkDurationSeconds);
}

function createWriteSummary(options: {
  readonly datasetId: string;
  readonly frames: readonly DetectionFrame[];
  readonly chunkDurationSeconds: number;
  readonly chunkCount: number;
}): DetectionFrameDatasetRecord {
  const firstFrame = options.frames[0];
  const lastFrame = options.frames.at(-1);

  return {
    chunkCount: options.chunkCount,
    chunkDurationSeconds: options.chunkDurationSeconds,
    datasetId: options.datasetId,
    detectionCount: options.frames.reduce(
      (total, frame) => total + frame.detections.length,
      0,
    ),
    endTime: lastFrame?.mediaTime ?? null,
    frameCount: options.frames.length,
    startTime: firstFrame?.mediaTime ?? null,
  };
}

async function loadDatasetRecord(
  database: IDBDatabase,
  datasetId: string,
): Promise<DetectionFrameDatasetRecord | undefined> {
  const transaction = database.transaction(DATASET_STORE_NAME);
  const transactionDone = waitForTransaction(transaction);
  const dataset = await requestToPromise<
    DetectionFrameDatasetRecord | undefined
  >(transaction.objectStore(DATASET_STORE_NAME).get(datasetId));

  await transactionDone;

  return dataset;
}

function openDetectionFrameDatabase(databaseName: string) {
  const indexedDb = getBrowserIndexedDB();

  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDb.open(databaseName, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const upgradeDatabase = request.result;
      const transaction = request.transaction;

      const chunkStore = upgradeDatabase.objectStoreNames.contains(
        CHUNK_STORE_NAME,
      )
        ? transaction?.objectStore(CHUNK_STORE_NAME)
        : upgradeDatabase.createObjectStore(CHUNK_STORE_NAME, {
            keyPath: "key",
          });

      if (
        chunkStore &&
        !chunkStore.indexNames.contains(DATASET_ID_INDEX_NAME)
      ) {
        chunkStore.createIndex(DATASET_ID_INDEX_NAME, "datasetId");
      }

      if (!upgradeDatabase.objectStoreNames.contains(DATASET_STORE_NAME)) {
        upgradeDatabase.createObjectStore(DATASET_STORE_NAME, {
          keyPath: "datasetId",
        });
      }
    };
    request.onerror = () => {
      reject(request.error ?? new Error("Unable to open detection store."));
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
  });
}

function getBrowserIndexedDB() {
  if (!globalThis.indexedDB) {
    throw new Error(
      "Browser cold detection frame store requires indexedDB, but it is not available in this environment.",
    );
  }

  return globalThis.indexedDB;
}

function requestToPromise<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB request failed."));
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
  });
}

function waitForTransaction(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.onabort = () => {
      reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    };
    transaction.oncomplete = () => {
      resolve();
    };
  });
}

function deleteRecordsByDatasetId(index: IDBIndex, datasetId: string) {
  return new Promise<void>((resolve, reject) => {
    const request = index.openCursor(IDBKeyRange.only(datasetId));

    request.onerror = () => {
      reject(request.error ?? new Error("Unable to clear detection dataset."));
    };
    request.onsuccess = () => {
      const cursor = request.result;

      if (!cursor) {
        resolve();
        return;
      }

      cursor.delete();
      cursor.continue();
    };
  });
}
