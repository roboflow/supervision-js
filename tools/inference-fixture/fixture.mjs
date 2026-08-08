export const RAW_SCHEMA =
  "supervision-js.tools.inference-fixture.raw-object-detection";
export const TRACK_SCHEMA = "supervision-js.tools.inference-fixture.bytetrack";
export const TRACE_ALGORITHM = "byte-track-center-trace-v1";

/**
 * Returns a frozen, renderer-neutral DetectionFrame timeline from raw model
 * responses plus a separately recorded ByteTrack association pass. Random
 * inference request ids and detection ids are deliberately not propagated.
 */
export function createDetectionFixture({ rawRecords, trackRecords, options }) {
  const { rawHeader, rawFrames } = parseRawRecords(rawRecords);
  const { trackHeader, associationsBySourceFrame } =
    parseTrackRecords(trackRecords);
  validateProvenance(rawHeader, trackHeader, options);

  const histories = new Map();
  const frames = rawFrames.map((rawFrame) => {
    const associations = associationsBySourceFrame.get(
      rawFrame.sourceFrameIndex,
    );
    if (!associations) {
      throw new Error(
        `Missing ByteTrack associations for source frame ${rawFrame.sourceFrameIndex}.`,
      );
    }
    const trackByPrediction = new Map(
      associations.map((association) => [
        association.predictionIndex,
        association.trackId,
      ]),
    );
    const predictions = rawFrame.response.predictions ?? [];
    const detections = predictions
      .map((prediction, predictionIndex) => {
        const trackId = trackByPrediction.get(predictionIndex);
        if (trackId === undefined) return undefined;
        const rect = normalizeRect(prediction);
        if (!rect) return undefined;
        const history = histories.get(trackId) ?? [];
        const point = { x: rect.x, y: rect.y };
        const trace = [...history, { mediaTime: rawFrame.mediaTime, point }]
          .filter(
            (entry) =>
              entry.mediaTime >=
              rawFrame.mediaTime - options.traceWindowSeconds,
          )
          .slice(-options.maxTracePoints);
        histories.set(trackId, trace);

        return {
          className: prediction.class,
          confidence: round(prediction.confidence, 6),
          id: `person-track:${trackId}`,
          metadata: {
            sourceFrameIndex: rawFrame.sourceFrameIndex,
            tracker: {
              algorithm: TRACE_ALGORITHM,
              trackId,
            },
          },
          polyline:
            trace.length >= 2
              ? { points: trace.map((entry) => entry.point) }
              : undefined,
          rect,
          sourceId: rawHeader.model.alias,
        };
      })
      .filter(Boolean)
      .sort(
        (left, right) =>
          left.id.localeCompare(right.id) || left.rect.x - right.rect.x,
      );

    return {
      detections,
      endTime: rawFrame.endTime,
      frameIndex: rawFrame.sourceFrameIndex,
      mediaTime: rawFrame.mediaTime,
    };
  });

  return {
    classNames: [
      ...new Set(
        frames.flatMap((frame) =>
          frame.detections.map((detection) => detection.className),
        ),
      ),
    ],
    frames,
    geometry: summarizeGeometry(frames),
    inference: {
      frameRate: parseFrameRate(rawHeader.source.frameRate),
      modelId: rawHeader.model.alias,
    },
    provenance: {
      authoring: rawHeader.authoring,
      inference: rawHeader.inference,
      model: rawHeader.model,
      rawOutput: {
        schema: rawHeader.schema,
      },
      source: rawHeader.source,
      tracking: {
        ...trackHeader,
        derivedGeometry: {
          algorithm: TRACE_ALGORITHM,
          anchor: "center-rect",
          maxTracePoints: options.maxTracePoints,
          traceWindowSeconds: options.traceWindowSeconds,
        },
      },
    },
    schema: "supervision-js.tools.inference-fixture.detections",
    source: { sampleName: options.sampleName },
    version: 1,
    video: {
      duration: rawHeader.source.duration,
      file: options.mediaFile,
      frameRate: parseFrameRate(rawHeader.source.frameRate),
      height: rawHeader.source.height,
      width: rawHeader.source.width,
    },
  };
}

export function parseRawRecords(records) {
  const [rawHeader, ...rawFrames] = records;
  if (rawHeader?.schema !== RAW_SCHEMA) {
    throw new Error(`Expected ${RAW_SCHEMA} header.`);
  }
  if (!rawFrames.length) {
    throw new Error("Raw inference output contains no frame records.");
  }
  return { rawFrames, rawHeader };
}

export function parseTrackRecords(records) {
  const [trackHeader, ...trackFrames] = records;
  if (trackHeader?.schema !== TRACK_SCHEMA) {
    throw new Error(`Expected ${TRACK_SCHEMA} header.`);
  }
  const associationsBySourceFrame = new Map(
    trackFrames.map((frame) => [frame.sourceFrameIndex, frame.associations]),
  );
  return { associationsBySourceFrame, trackHeader };
}

export function validateProvenance(rawHeader, trackHeader, options) {
  if (!isSha256(rawHeader?.source?.sha256)) {
    throw new Error("Raw output must record the source SHA-256.");
  }
  if (!isSha256(rawHeader?.model?.weightsSha256)) {
    throw new Error("Raw output must record the model weight SHA-256.");
  }
  if (!rawHeader?.model?.license) {
    throw new Error("Raw output must record the model license.");
  }
  if (!rawHeader?.inference?.imageDigest?.startsWith("sha256:")) {
    throw new Error("Raw output must record the Inference image digest.");
  }
  if (!trackHeader?.algorithm || !trackHeader?.trackersVersion) {
    throw new Error(
      "Track output must record algorithm and package provenance.",
    );
  }
  if (!(options.traceWindowSeconds > 0) || options.maxTracePoints < 2) {
    throw new Error(
      "Trace options must retain at least two positive-duration points.",
    );
  }
}

function normalizeRect(prediction) {
  if (
    ![prediction.x, prediction.y, prediction.width, prediction.height].every(
      Number.isFinite,
    ) ||
    !(prediction.width > 0) ||
    !(prediction.height > 0)
  ) {
    return undefined;
  }
  return {
    height: round(prediction.height, 3),
    width: round(prediction.width, 3),
    x: round(prediction.x, 3),
    y: round(prediction.y, 3),
  };
}

function summarizeGeometry(frames) {
  return {
    boxDetectionCount: frames.reduce(
      (total, frame) => total + frame.detections.length,
      0,
    ),
    keypointDetectionCount: 0,
    maskDetectionCount: 0,
    polygonDetectionCount: 0,
    polylineDetectionCount: frames.reduce(
      (total, frame) =>
        total +
        frame.detections.filter((detection) => detection.polyline).length,
      0,
    ),
  };
}

function parseFrameRate(value) {
  const [numerator, denominator] = String(value).split("/").map(Number);
  return denominator ? numerator / denominator : numerator;
}

function round(value, digits) {
  return Number(value.toFixed(digits));
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
