import { describe, expect, it, vi } from "vitest";

import {
  AnnotationFrameMutationKind,
  createEditableAnnotationFrameSession,
} from "#detections/editable-annotation-frame-session";
import { DetectionMaskEncoding } from "#types/detections";

describe("editable annotation frame session", () => {
  const initialFrame = {
    detections: [
      {
        id: "first",
        rect: { height: 10, width: 10, x: 0, y: 0 },
      },
    ],
    mediaTime: 0,
  } as const;

  it("emits immutable before/after snapshots for id-based edits", () => {
    const session = createEditableAnnotationFrameSession(initialFrame);
    const listener = vi.fn();
    session.subscribe(listener);

    const updated = session.update("first", { className: "person" });
    expect(updated.detections[0]?.className).toBe("person");
    expect(Object.isFrozen(updated)).toBe(true);
    expect(Object.isFrozen(updated.detections[0]?.rect)).toBe(true);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        detectionIds: ["first"],
        kind: AnnotationFrameMutationKind.Update,
        previous: expect.objectContaining({
          detections: initialFrame.detections,
        }),
        current: updated,
      }),
    );
  });

  it("adds, removes, replaces, and batches by stable id", () => {
    const session = createEditableAnnotationFrameSession(initialFrame);
    session.add({
      id: "second",
      polygon: {
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
        ],
      },
    });
    expect(session.getSnapshot().detections).toHaveLength(2);

    session.transact((detections) => detections.reverse(), ["first", "second"]);
    expect(session.getSnapshot().detections[0]?.id).toBe("second");

    session.remove("first");
    expect(session.getSnapshot().detections.map(({ id }) => id)).toEqual([
      "second",
    ]);
  });

  it("provides deep mutable transaction data without mutating snapshots", () => {
    const session = createEditableAnnotationFrameSession({
      detections: [
        {
          id: "editable",
          keypoints: {
            edges: [[0, 1]],
            points: [
              { x: 1, y: 2 },
              { x: 3, y: 4 },
            ],
          },
          metadata: { review: { status: "draft" } },
          polygon: {
            points: [
              { x: 1, y: 1 },
              { x: 2, y: 1 },
              { x: 1, y: 2 },
            ],
          },
          rect: { height: 10, width: 10, x: 5, y: 5 },
        },
      ],
      mediaTime: 0,
    });
    const previous = session.getSnapshot();

    const current = session.transact(
      (detections) => {
        const detection = detections[0]!;
        detection.rect!.x = 10;
        detection.polygon!.points[0]!.x = 9;
        detection.keypoints!.points[0]!.y = 8;
        (detection.metadata!.review as { status: string }).status = "approved";
      },
      ["editable"],
    );

    expect(previous.detections[0]?.rect?.x).toBe(5);
    expect(previous.detections[0]?.polygon?.points[0]?.x).toBe(1);
    expect(previous.detections[0]?.keypoints?.points[0]?.y).toBe(2);
    expect(current.detections[0]?.rect?.x).toBe(10);
    expect(current.detections[0]?.polygon?.points[0]).toEqual({ x: 9, y: 1 });
    expect(current.detections[0]?.keypoints?.points[0]).toEqual({ x: 1, y: 8 });
    expect(current.detections[0]?.metadata).toMatchObject({
      review: { status: "approved" },
    });
    expect(Object.isFrozen(current.detections[0]?.polygon?.points[0])).toBe(
      true,
    );
  });

  it("rejects missing, duplicate, and changing ids", () => {
    expect(() =>
      createEditableAnnotationFrameSession({
        detections: [{ rect: { height: 1, width: 1, x: 0, y: 0 } }],
        mediaTime: 0,
      }),
    ).toThrow("require a stable id");

    const session = createEditableAnnotationFrameSession(initialFrame);
    expect(() => session.add(initialFrame.detections[0])).toThrow(
      "already exists",
    );
    expect(() => session.update("first", { id: "changed" })).toThrow(
      "preserve the stable id",
    );
  });

  it("snapshots a dense bitmap mask without freezing its bytes", () => {
    // `Object.freeze()` throws on an array buffer view with elements, so the
    // snapshot's deep freeze has to step over mask bytes. Every mask used to
    // arrive RLE-encoded, where the payload is a string, which is why this
    // only became reachable once the encoding widened.
    const data = new Uint8Array([0, 255, 0, 255]);
    const session = createEditableAnnotationFrameSession({
      detections: [
        {
          id: "dense",
          mask: {
            data,
            encoding: DetectionMaskEncoding.DenseBitmap,
            height: 2,
            width: 2,
          },
        },
      ],
      mediaTime: 0,
    });

    const snapshot = session.getSnapshot();
    const mask = snapshot.detections[0]?.mask;

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(mask)).toBe(true);
    // Shared, not deep-copied: duplicating a full-resolution mask per frame is
    // exactly the cost this encoding exists to avoid.
    expect(mask && "data" in mask ? mask.data : null).toBe(data);
    expect(Object.isFrozen(data)).toBe(false);
  });
});
