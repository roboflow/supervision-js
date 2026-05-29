import {
  DetectionMaskEncoding,
  type Detection,
  type Rect,
} from "supervision-js";

export function normalizeSam3Detections(
  response: unknown,
  prompts: readonly string[],
): Detection[] {
  return extractPromptResultEntries(response).flatMap((entry, promptIndex) => {
    const promptText = getPromptText(entry.promptResult, promptIndex, prompts);
    const predictions = extractPredictions(entry.promptResult);

    return predictions.map((prediction, predictionIndex) =>
      normalizePrediction(prediction, {
        predictionIndex,
        promptIndex,
        promptText,
      }),
    );
  });
}

function extractPromptResultEntries(response: unknown) {
  const promptResults =
    getArrayProperty(response, "prompt_results") ??
    getArrayProperty(response, "promptResults");

  if (promptResults) {
    return promptResults.map((promptResult) => ({ promptResult }));
  }

  return [{ promptResult: response }];
}

function getPromptText(
  promptResult: unknown,
  promptIndex: number,
  prompts: readonly string[],
) {
  if (isRecord(promptResult)) {
    const echo = isRecord(promptResult.echo) ? promptResult.echo : undefined;
    const candidates = [
      echo?.text,
      echo?.prompt,
      promptResult.text,
      promptResult.prompt,
      promptResult.class,
      promptResult.className,
    ];
    const match = candidates.find((candidate) => typeof candidate === "string");

    if (match) {
      return match;
    }
  }

  return prompts[promptIndex] ?? `prompt ${promptIndex}`;
}

function extractPredictions(promptResult: unknown) {
  if (!isRecord(promptResult)) {
    return [];
  }

  return (
    getArrayProperty(promptResult, "predictions") ??
    getArrayProperty(promptResult, "detections") ??
    getArrayProperty(promptResult, "results") ??
    []
  ).filter(isRecord);
}

function normalizePrediction(
  prediction: Record<string, unknown>,
  context: {
    readonly promptIndex: number;
    readonly promptText: string;
    readonly predictionIndex: number;
  },
): Detection {
  const mask = extractMask(prediction);
  const polygonPoints = extractPolygonPoints(prediction, mask);
  const rle = extractRle(mask);
  const rect =
    polygonPoints.length > 0
      ? deriveRectFromPoints(polygonPoints)
      : rle
        ? deriveRectFromRle(rle)
        : undefined;
  const normalizedMask =
    rle && typeof rle.counts === "string"
      ? {
          counts: rle.counts,
          encoding: DetectionMaskEncoding.CompressedRle,
          height: rle.height,
          width: rle.width,
        }
      : undefined;
  const rawMaskNote =
    rle && typeof rle.counts !== "string"
      ? "SAM3 returned an uncompressed or non-COCO RLE shape."
      : undefined;

  return removeUndefinedProperties({
    className: getPredictionClassName(prediction, context),
    confidence: getPredictionConfidence(prediction),
    id: getPredictionId(prediction, context),
    mask: normalizedMask,
    metadata: removeUndefinedProperties({
      sam3MaskNote: rawMaskNote,
      sam3Prompt: context.promptText,
      sam3PromptIndex: context.promptIndex,
      sam3RawMask: normalizedMask ? undefined : mask,
    }),
    rect,
  });
}

function extractMask(prediction: Record<string, unknown>) {
  return firstRecord([
    prediction.mask,
    prediction.masks,
    prediction.segmentation,
    prediction.rle,
  ]);
}

function extractPolygonPoints(
  prediction: Record<string, unknown>,
  mask: Record<string, unknown> | undefined,
) {
  const polygonSource =
    getArrayProperty(prediction, "polygon") ??
    getArrayProperty(prediction, "points") ??
    getArrayProperty(mask, "polygon") ??
    getArrayProperty(mask, "points") ??
    getArrayProperty(mask, "vertices");

  if (!polygonSource) {
    return [];
  }

  return polygonSource.flatMap((point) => {
    if (Array.isArray(point) && point.length >= 2) {
      const [x, y] = point;

      return typeof x === "number" && typeof y === "number" ? [{ x, y }] : [];
    }

    if (isRecord(point)) {
      const { x, y } = point;

      return typeof x === "number" && typeof y === "number" ? [{ x, y }] : [];
    }

    return [];
  });
}

function extractRle(mask: Record<string, unknown> | undefined) {
  if (!mask) {
    return undefined;
  }

  const counts = mask.counts;
  const size = Array.isArray(mask.size) ? mask.size : undefined;
  const width = numberOrNull(mask.width) ?? numberOrNull(size?.[1]);
  const height = numberOrNull(mask.height) ?? numberOrNull(size?.[0]);

  if (
    (typeof counts !== "string" && !isNumberArray(counts)) ||
    !width ||
    !height
  ) {
    return undefined;
  }

  return { counts, height, width };
}

function deriveRectFromPoints(points: readonly { x: number; y: number }[]) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  return {
    height: roundTo(maxY - minY, 3),
    width: roundTo(maxX - minX, 3),
    x: roundTo(minX, 3),
    y: roundTo(minY, 3),
  };
}

function deriveRectFromRle(rle: {
  readonly counts: string | readonly number[];
  readonly height: number;
  readonly width: number;
}): Rect | undefined {
  const counts =
    typeof rle.counts === "string"
      ? decodeCompressedRleCounts(rle.counts)
      : rle.counts;
  let offset = 0;
  let minX = rle.width;
  let minY = rle.height;
  let maxX = -1;
  let maxY = -1;

  for (let index = 0; index < counts.length; index += 1) {
    const runLength = counts[index] ?? 0;
    const isForeground = index % 2 === 1;

    if (isForeground && runLength > 0) {
      let remaining = runLength;
      let runOffset = offset;

      while (remaining > 0) {
        const x = Math.floor(runOffset / rle.height);
        const y = runOffset % rle.height;
        const pixelsInColumn = Math.min(remaining, rle.height - y);

        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y + pixelsInColumn - 1);

        runOffset += pixelsInColumn;
        remaining -= pixelsInColumn;
      }
    }

    offset += runLength;
  }

  if (maxX < minX || maxY < minY) {
    return undefined;
  }

  return {
    height: roundTo(maxY - minY + 1, 3),
    width: roundTo(maxX - minX + 1, 3),
    x: roundTo(minX, 3),
    y: roundTo(minY, 3),
  };
}

function decodeCompressedRleCounts(counts: string) {
  const decoded: number[] = [];
  let index = 0;

  while (index < counts.length) {
    let value = 0;
    let shift = 0;
    let charCode: number;

    do {
      charCode = counts.charCodeAt(index) - 48;
      index += 1;
      value |= (charCode & 0x1f) << shift;
      shift += 5;
    } while (charCode & 0x20);

    if (charCode & 0x10) {
      value |= -1 << shift;
    }

    if (decoded.length > 2) {
      value += decoded[decoded.length - 2] ?? 0;
    }

    decoded.push(value);
  }

  return decoded;
}

function getPredictionClassName(
  prediction: Record<string, unknown>,
  context: { readonly promptText: string },
) {
  const candidates = [
    prediction.className,
    prediction.class_name,
    prediction.class,
    prediction.label,
    context.promptText,
  ];

  return candidates.find((candidate) => typeof candidate === "string");
}

function getPredictionConfidence(prediction: Record<string, unknown>) {
  const candidates = [
    prediction.confidence,
    prediction.score,
    prediction.probability,
  ];

  return candidates.find((candidate) => typeof candidate === "number");
}

function getPredictionId(
  prediction: Record<string, unknown>,
  context: {
    readonly predictionIndex: number;
    readonly promptIndex: number;
  },
) {
  const candidates = [
    prediction.detection_id,
    prediction.detectionId,
    prediction.id,
  ];
  const match = candidates.find(
    (candidate) =>
      typeof candidate === "string" || typeof candidate === "number",
  );

  return match ?? `${context.promptIndex}:${context.predictionIndex}`;
}

function getArrayProperty(value: unknown, key: string) {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : undefined;
}

function firstRecord(values: readonly unknown[]) {
  return values.find(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumberArray(value: unknown): value is readonly number[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "number")
  );
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function removeUndefinedProperties<T extends Record<string, unknown>>(
  value: T,
) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as {
    [Key in keyof T]: Exclude<T[Key], undefined>;
  };
}

function roundTo(value: number, decimals: number) {
  return Number(value.toFixed(decimals));
}
