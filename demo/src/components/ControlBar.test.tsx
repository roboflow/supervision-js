import { MediaRendererPlaybackState } from "supervision";
import { describe, expect, it } from "vitest";

import { areControlBarPropsEqual, ControlBar } from "./ControlBar";

type ControlBarProps = Parameters<typeof areControlBarPropsEqual>[0];

const noop = () => {};

const baseProps: ControlBarProps = {
  canUseRenderer: true,
  duration: 70.42,
  onScrub: noop,
  onSeek: noop,
  onSetPlaybackRate: noop,
  onStepFrame: noop,
  onTogglePlayback: noop,
  playbackRate: 8,
  playbackState: MediaRendererPlaybackState.Playing,
  presentedRate: 8,
  processedRanges: [],
  processingRanges: [],
  sourceResidency: null,
};

/** One change each, so a prop the comparator stops watching fails a case. */
const otherPropChanges: readonly Partial<ControlBarProps>[] = [
  { canUseRenderer: false },
  { duration: 9.13 },
  { onScrub: () => {} },
  { onSeek: () => {} },
  { onSetPlaybackRate: () => {} },
  { onStepFrame: () => {} },
  { onTogglePlayback: () => {} },
  { playbackRate: 4 },
  { playbackState: MediaRendererPlaybackState.Paused },
  { processedRanges: [{ endTime: 12, startTime: 4 }] },
  { processingRanges: [{ endTime: 12, startTime: 4 }] },
  {
    sourceResidency: {
      prefetchedBytes: 0,
      ranges: [{ end: 512, start: 0 }],
      residentBytes: 512,
      totalBytes: 1024,
      warming: false,
    },
  },
];

function withProps(changes: Partial<ControlBarProps>): ControlBarProps {
  return { ...baseProps, ...changes };
}

describe("areControlBarPropsEqual", () => {
  it("holds the bar still while a measured rate wanders inside the speed it was asked for", () => {
    expect(
      areControlBarPropsEqual(
        withProps({ presentedRate: 7.98 }),
        withProps({ presentedRate: 8.04 }),
      ),
    ).toBe(true);
  });

  it("commits when the picture drops behind the speed it was asked for", () => {
    expect(
      areControlBarPropsEqual(
        withProps({ presentedRate: 8 }),
        withProps({ presentedRate: 6.1 }),
      ),
    ).toBe(false);
  });

  it("commits when the shortfall moves the tenth the speed pill quotes", () => {
    expect(
      areControlBarPropsEqual(
        withProps({ presentedRate: 6.1 }),
        withProps({ presentedRate: 6.2 }),
      ),
    ).toBe(false);
  });

  it("holds still while a shortfall wanders under the tenth it is quoted to", () => {
    expect(
      areControlBarPropsEqual(
        withProps({ presentedRate: 6.12 }),
        withProps({ presentedRate: 6.14 }),
      ),
    ).toBe(true);
  });

  it("reads an unmeasured rate the way it reads a kept one", () => {
    expect(
      areControlBarPropsEqual(
        withProps({ presentedRate: null }),
        withProps({ presentedRate: 8 }),
      ),
    ).toBe(true);
  });

  it("commits when a shortfall stops being measured", () => {
    expect(
      areControlBarPropsEqual(
        withProps({ presentedRate: 6.1 }),
        withProps({ presentedRate: null }),
      ),
    ).toBe(false);
  });

  it("leaves a slowed picture alone, which no rate can fall behind", () => {
    expect(
      areControlBarPropsEqual(
        withProps({ playbackRate: 0.5, presentedRate: 0.5 }),
        withProps({ playbackRate: 0.5, presentedRate: 0.1 }),
      ),
    ).toBe(true);
  });

  it("commits when the picture drops behind at the default speed", () => {
    expect(
      areControlBarPropsEqual(
        withProps({ playbackRate: 1, presentedRate: 1 }),
        withProps({ playbackRate: 1, presentedRate: 0.2 }),
      ),
    ).toBe(false);
  });

  it("commits on every prop but the presented rate", () => {
    for (const change of otherPropChanges) {
      expect(
        areControlBarPropsEqual(baseProps, withProps(change)),
        Object.keys(change)[0],
      ).toBe(false);
    }
  });

  it("covers every prop the bar takes", () => {
    expect(
      otherPropChanges.flatMap((change) => Object.keys(change)).sort(),
    ).toEqual(
      Object.keys(baseProps)
        .filter((key) => key !== "presentedRate")
        .sort(),
    );
  });

  it("is the comparator the bar is memoised with", () => {
    const memoised: {
      readonly $$typeof: symbol;
      readonly compare?: unknown;
    } = ControlBar;

    expect(memoised.compare).toBe(areControlBarPropsEqual);
  });
});
