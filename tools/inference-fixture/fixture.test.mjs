import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDetectionFixture } from "./fixture.mjs";

const sourceSha256 = "a".repeat(64);
const weightsSha256 = "b".repeat(64);

function rawHeader() {
  return {
    schema: "supervision-js.tools.inference-fixture.raw-object-detection",
    authoring: { generator: "run.py" },
    inference: { imageDigest: `sha256:${"c".repeat(64)}` },
    model: {
      alias: "yolov8n-640",
      license: "AGPL-3.0",
      weightsSha256,
    },
    source: {
      duration: 1,
      frameRate: "25/1",
      height: 1080,
      sha256: sourceSha256,
      width: 1920,
    },
  };
}

function trackHeader() {
  return {
    schema: "supervision-js.tools.inference-fixture.bytetrack",
    algorithm: "roboflow-trackers-byte-track-v1",
    trackersVersion: "2.4.0",
  };
}

function rawFrame(sourceFrameIndex, mediaTime, x) {
  return {
    endTime: mediaTime + 0.04,
    mediaTime,
    sourceFrameIndex,
    response: {
      predictions: [
        {
          class: "person",
          class_id: 0,
          confidence: 0.9,
          height: 40,
          width: 20,
          x,
          y: 50,
        },
      ],
    },
  };
}

describe("createDetectionFixture", () => {
  it("turns ByteTrack associations into stable ids and time-bounded open paths", () => {
    const fixture = createDetectionFixture({
      rawRecords: [rawHeader(), rawFrame(0, 0, 10), rawFrame(1, 0.04, 20)],
      trackRecords: [
        trackHeader(),
        {
          associations: [{ predictionIndex: 0, trackId: 7 }],
          sourceFrameIndex: 0,
        },
        {
          associations: [{ predictionIndex: 0, trackId: 7 }],
          sourceFrameIndex: 1,
        },
      ],
      options: {
        maxTracePoints: 50,
        mediaFile: "people-walking.webm",
        sampleName: "people_walking_detection_v1",
        traceWindowSeconds: 2,
      },
    });

    assert.equal(fixture.frames[0].detections[0].id, "person-track:7");
    assert.equal(fixture.frames[0].detections[0].polyline, undefined);
    assert.deepEqual(fixture.frames[1].detections[0].polyline, {
      points: [
        { x: 10, y: 50 },
        { x: 20, y: 50 },
      ],
    });
    assert.equal(fixture.geometry.polylineDetectionCount, 1);
    assert.equal(
      fixture.provenance.tracking.derivedGeometry.algorithm,
      "byte-track-center-trace-v1",
    );
  });

  it("rejects incomplete association and provenance records", () => {
    assert.throws(() =>
      createDetectionFixture({
        rawRecords: [rawHeader(), rawFrame(0, 0, 10)],
        trackRecords: [trackHeader()],
        options: {
          maxTracePoints: 50,
          mediaFile: "people-walking.webm",
          sampleName: "people_walking_detection_v1",
          traceWindowSeconds: 2,
        },
      }),
    );
    assert.throws(() =>
      createDetectionFixture({
        rawRecords: [
          {
            ...rawHeader(),
            model: { ...rawHeader().model, weightsSha256: "bad" },
          },
          rawFrame(0, 0, 10),
        ],
        trackRecords: [
          trackHeader(),
          { associations: [], sourceFrameIndex: 0 },
        ],
        options: {
          maxTracePoints: 50,
          mediaFile: "people-walking.webm",
          sampleName: "people_walking_detection_v1",
          traceWindowSeconds: 2,
        },
      }),
    );
  });
});
