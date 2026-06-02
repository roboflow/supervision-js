import { createReadStream } from "node:fs";
import { createInterface } from "node:readline/promises";

export async function* readJsonlRecords(inputPath) {
  const input = createReadStream(inputPath, { encoding: "utf8" });
  const lines = createInterface({
    crlfDelay: Infinity,
    input,
  });

  for await (const line of lines) {
    const trimmedLine = line.trim();

    if (trimmedLine.length === 0) {
      continue;
    }

    yield JSON.parse(trimmedLine);
  }
}

export async function readJsonlArray(inputPath) {
  const records = [];

  for await (const record of readJsonlRecords(inputPath)) {
    records.push(record);
  }

  return records;
}
