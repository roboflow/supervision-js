import { describe, expect, it, vi } from "vitest";

import {
  AnnotationFrameMutationKind,
  createEditableAnnotationFrameSession,
} from "#detections/editable-annotation-frame-session";
import type { DetectionFrame, OrientedBoxGeometry } from "#types/detections";

describe("editable annotation frame session", () => {
  const createOrientedFrame = (): DetectionFrame => ({
    mediaTime: 0,
    detections: [
      {
        id: "obb",
        orientedBox: {
          points: [
            { x: 0, y: 2 },
            { x: 2, y: 0 },
            { x: 4, y: 2 },
            { x: 2, y: 4 },
          ],
        },
      },
    ],
  });

  it("freezes oriented-box snapshots without freezing caller-owned geometry", () => {
    const frame = createOrientedFrame();
    const original = frame.detections[0]!.orientedBox!;
    const session = createEditableAnnotationFrameSession(frame);
    const snapshot = session.getSnapshot().detections[0]!.orientedBox!;

    for (const value of [original, original.points, ...original.points]) {
      expect(Object.isFrozen(value)).toBe(false);
    }
    for (const value of [snapshot, snapshot.points, ...snapshot.points]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    Object.assign(original.points[0], { x: 99 });
    expect(snapshot.points[0]).toEqual({ x: 0, y: 2 });
  });

  it("allows oriented-box point edits in transact without changing previous snapshots", () => {
    const frame = createOrientedFrame();
    const session = createEditableAnnotationFrameSession(frame);
    const previous = session.getSnapshot();
    const current = session.transact(
      (detections) => {
        detections[0]!.orientedBox!.points[0].x = 1;
        detections[0]!.orientedBox!.points[1] = { x: 3, y: 0 };
      },
      ["obb"],
    );

    expect(previous.detections[0]!.orientedBox).toEqual(
      frame.detections[0]!.orientedBox,
    );
    expect(current.detections[0]!.orientedBox!.points.slice(0, 2)).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 0 },
    ]);
    expect(Object.isFrozen(current.detections[0]!.orientedBox!.points[0])).toBe(
      true,
    );
    session.replace(previous);
    expect(session.getSnapshot()).toEqual(previous);
    session.replace(current);
    expect(session.getSnapshot()).toEqual(current);
  });

  it("rejects malformed oriented-box edits without committing or notifying", () => {
    const session = createEditableAnnotationFrameSession(createOrientedFrame());
    const previous = session.getSnapshot();
    const listener = vi.fn();
    session.subscribe(listener);
    const malformed = {
      points: [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 0, y: 2 },
      ],
    } as unknown as OrientedBoxGeometry;

    expect(() => session.update("obb", { orientedBox: malformed })).toThrow(
      "orientedBox",
    );
    expect(() =>
      session.add({ id: "invalid", orientedBox: malformed }),
    ).toThrow("orientedBox");
    expect(() =>
      session.replace({
        mediaTime: 0,
        detections: [{ id: "invalid", orientedBox: malformed }],
      }),
    ).toThrow("orientedBox");
    expect(() =>
      session.transact((detections) => {
        detections[0]!.orientedBox!.points[0].y = Infinity;
      }),
    ).toThrow("orientedBox");
    expect(session.getSnapshot()).toBe(previous);
    expect(listener).not.toHaveBeenCalled();
  });

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
});
