import {
  DetectionMaskEncoding,
  type Detection,
  type DetectionMask,
} from "supervision-js";
import {
  computeDetectionMaskRect,
  encodeCompressedRleCounts,
  polygonToRect,
} from "supervision-js/editing";

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
  const normalizedMask = normalizeRleMask(rle);
  const rect =
    polygonPoints.length > 0
      ? polygonToRect({ points: polygonPoints })
      : normalizedMask
        ? computeDetectionMaskRect(normalizedMask)
        : undefined;

  return removeUndefinedProperties({
    className: getPredictionClassName(prediction, context),
    confidence: getPredictionConfidence(prediction),
    id: getPredictionId(prediction, context),
    mask: normalizedMask,
    metadata: removeUndefinedProperties({
      sam3Prompt: context.promptText,
      sam3PromptIndex: context.promptIndex,
      sam3RawMask: rle ? undefined : mask,
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

function normalizeRleMask(
  rle:
    | {
        readonly counts: string | readonly number[];
        readonly height: number;
        readonly width: number;
      }
    | undefined,
): DetectionMask | undefined {
  if (!rle) return undefined;
  return {
    counts:
      typeof rle.counts === "string"
        ? rle.counts
        : encodeCompressedRleCounts(rle.counts),
    encoding: DetectionMaskEncoding.CompressedRle,
    height: rle.height,
    width: rle.width,
  };
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
