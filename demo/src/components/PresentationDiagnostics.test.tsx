import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import {
  RenderPreparationArtifactFrameStatus,
  RenderPreparationArtifactKind,
} from "supervision";

import type { PresentationDiagnosticsSample } from "../diagnostics/presentation-diagnostics";
import type { PresentedFrameRecord } from "../diagnostics/presented-frame-tap";
import {
  presentationSampleUnchanged,
  PresentedFrameTimeline,
  readPreparationGateTargetRanges,
} from "./PresentationDiagnostics";

const RING_CAPACITY = 300;

function record(paintSeq: number): PresentedFrameRecord {
  return {
    frameIndex: paintSeq,
    mediaTimeMs: paintSeq * 33.367,
    mediaTimeS: (paintSeq * 33.367) / 1000,
    paintSeq,
    quality: paintSeq % 2 === 0 ? "exact" : "preview",
    wallTimeMs: 1000 + paintSeq * 33.367,
  };
}

/** The ring as it stands after `presentedCount` frames, oldest first. */
function ring(presentedCount: number): readonly PresentedFrameRecord[] {
  const first = Math.max(0, presentedCount - RING_CAPACITY);

  return Array.from(
    { length: Math.min(presentedCount, RING_CAPACITY) },
    (_, at) => record(first + at),
  );
}

function sample(
  presentedCount: number,
  overrides: Partial<PresentationDiagnosticsSample> = {},
): PresentationDiagnosticsSample {
  const records = ring(presentedCount);

  return {
    lastPresented: records.at(-1) ?? null,
    presentedCount,
    presentedPerSecond: 30,
    readinessBands: [{ startTime: 0, endTime: 4 }],
    renderCount: presentedCount,
    ticks: records,
    ...overrides,
  };
}

/** The keys of every element whose class name starts with `prefix`, in tree
 *  order. Elements handed to a component as children are built before it runs,
 *  so this reads them without a DOM to render them into. */
function keysOf(node: unknown, prefix: string, keys: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) keysOf(child, prefix, keys);
    return keys;
  }

  if (typeof node !== "object" || node === null || !("props" in node)) {
    return keys;
  }

  const element = node as ReactElement<{
    children?: unknown;
    className?: string;
  }>;

  if (element.props.className?.startsWith(prefix)) {
    keys.push(String(element.key));
  }

  return keysOf(element.props.children, prefix, keys);
}

function tickKeys(presentedCount: number) {
  return keysOf(
    PresentedFrameTimeline({
      detectionRanges: [],
      duration: 70,
      gateTargetRanges: [],
      playheadTime: 1,
      readinessBands: [],
      ticks: ring(presentedCount),
    }),
    "presented-timeline__tick",
  );
}

describe("presented frame ticks", () => {
  /* The ring holds 300, so from the 301st frame on every position in it maps
   * to a different record on every poll. A tick keyed by where it sits is a
   * tick React remounts four times a second for the rest of the session, all
   * 300 of them; keyed by the frame it draws, the survivors are left alone. */
  it("keys a tick by the frame it draws, not by where it sits", () => {
    const before = tickKeys(RING_CAPACITY + 40);
    const after = tickKeys(RING_CAPACITY + 48);

    expect(before).toHaveLength(RING_CAPACITY);
    expect(after).toHaveLength(RING_CAPACITY);
    expect(before[0]).toBe("40");
    expect(after.slice(0, RING_CAPACITY - 8)).toEqual(before.slice(8));
  });
});

describe("render-preparation gate target", () => {
  const heldArtifact = {
    activeFrame: {
      key: "mask:9.5",
      mediaTime: 9.5,
      status: RenderPreparationArtifactFrameStatus.Pending,
    },
    gateHold: {
      reason: "leadBelowRequirement" as never,
      requiredAheadSeconds: 1.25,
    },
    kind: RenderPreparationArtifactKind.MaskFrame,
    pendingCount: 1,
    preparedCount: 2,
  };

  it("draws the active gate target and wraps it at the end of a looping clip", () => {
    expect(readPreparationGateTargetRanges(heldArtifact, 10)).toEqual([
      { endTime: 10, startTime: 9.5 },
      { endTime: 0.75, startTime: 0 },
    ]);
  });

  it("draws no target when the gate is clear", () => {
    expect(
      readPreparationGateTargetRanges({ ...heldArtifact, gateHold: null }, 10),
    ).toEqual([]);
  });
});

describe("presentationSampleUnchanged", () => {
  it("drops a poll that found the same picture", () => {
    expect(presentationSampleUnchanged(sample(120), sample(120))).toBe(true);
  });

  it("takes a poll that found any reading it draws moved", () => {
    const before = sample(120);

    expect(presentationSampleUnchanged(before, sample(121))).toBe(false);
    expect(
      presentationSampleUnchanged(
        before,
        sample(120, { presentedPerSecond: 29 }),
      ),
    ).toBe(false);
    expect(
      presentationSampleUnchanged(before, sample(120, { renderCount: 121 })),
    ).toBe(false);
    expect(
      presentationSampleUnchanged(
        before,
        sample(120, { lastPresented: record(999) }),
      ),
    ).toBe(false);
    expect(
      presentationSampleUnchanged(
        before,
        sample(120, { readinessBands: [{ startTime: 0, endTime: 5 }] }),
      ),
    ).toBe(false);
    expect(
      presentationSampleUnchanged(
        before,
        sample(120, { readinessBands: null }),
      ),
    ).toBe(false);
  });

  it("reads a second frame of the same media time as a second frame", () => {
    const before = sample(120);
    const twice = sample(120, {
      lastPresented: { ...record(119), paintSeq: 120 },
    });

    expect(presentationSampleUnchanged(before, twice)).toBe(false);
  });

  it("keeps a pair of unmeasured readings equal", () => {
    const idle = sample(0, {
      lastPresented: null,
      presentedPerSecond: null,
      readinessBands: null,
      renderCount: null,
    });

    expect(presentationSampleUnchanged(idle, idle)).toBe(true);
  });
});
