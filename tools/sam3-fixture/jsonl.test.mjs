import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { readJsonlArray, readJsonlRecords } from "./jsonl.mjs";

describe("fixture JSONL helpers", () => {
  test("stream JSONL records without requiring whole-file reads", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "supervision-jsonl-"));
    const jsonlPath = path.join(tempDir, "frames.jsonl");

    try {
      await writeFile(
        jsonlPath,
        [
          JSON.stringify({ frameIndex: 0 }),
          "",
          JSON.stringify({ frames: [{ frameIndex: 1 }, { frameIndex: 2 }] }),
        ].join("\n"),
      );

      const streamed = [];

      for await (const record of readJsonlRecords(jsonlPath)) {
        streamed.push(record);
      }

      assert.deepEqual(streamed, [
        { frameIndex: 0 },
        { frames: [{ frameIndex: 1 }, { frameIndex: 2 }] },
      ]);
      assert.deepEqual(await readJsonlArray(jsonlPath), streamed);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
