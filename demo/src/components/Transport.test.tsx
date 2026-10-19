import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { Transport } from "./Transport";

type TransportProps = Parameters<typeof Transport.type>[0];

const noop = () => {};

const baseProps: TransportProps = {
  atClipEnd: false,
  disabled: false,
  isBuffering: false,
  isPlaying: false,
  onSetPlaybackRate: noop,
  onStepFrame: noop,
  onTogglePlayback: noop,
  playbackRate: 1,
  presentedRate: 1,
  waitLabel: null,
};

interface PlayButtonProps {
  readonly "aria-label"?: string;
  readonly className?: string;
  readonly "data-buffering"?: string;
  readonly children?: ReactNode;
}

function playButton(changes: Partial<TransportProps>): PlayButtonProps {
  const found = collect(Transport.type({ ...baseProps, ...changes })).filter(
    (node) => node.props.className === "transport__play",
  );

  if (found.length !== 1) {
    throw new Error(`${found.length} play buttons rendered`);
  }

  return found[0].props;
}

function glyphClassNames(changes: Partial<TransportProps>): string[] {
  return collect(Transport.type({ ...baseProps, ...changes }))
    .map((node) => node.props.className ?? "")
    .filter((className) => className.startsWith("transport__glyph "));
}

function collect(
  node: ReactNode,
  found: ReactElement<PlayButtonProps>[] = [],
): ReactElement<PlayButtonProps>[] {
  if (Array.isArray(node)) {
    for (const child of node) {
      collect(child, found);
    }

    return found;
  }

  if (!isValidElement<PlayButtonProps>(node)) {
    return found;
  }

  found.push(node);

  return collect(node.props.children, found);
}

describe("Transport", () => {
  it("spins while the transport is waiting", () => {
    expect(playButton({ isBuffering: true })["data-buffering"]).toBe("");
  });

  it("keeps spinning while the notice names the wait beside it", () => {
    expect(
      playButton({ isBuffering: true, waitLabel: "Waiting for more video" })[
        "data-buffering"
      ],
    ).toBe("");
  });

  it("never spins while the transport is not waiting", () => {
    expect(
      playButton({ waitLabel: "Waiting for the model" })["data-buffering"],
    ).toBeUndefined();
  });

  it("carries a spinner to put in the action glyph's place", () => {
    expect(glyphClassNames({ isBuffering: true })).toContain(
      "transport__glyph transport__glyph--busy",
    );
  });

  it("names the wait the notice named, rather than the engine's own word", () => {
    expect(
      playButton({ isBuffering: true, waitLabel: "Waiting for the masks" })[
        "aria-label"
      ],
    ).toBe("Play, waiting for the masks");
  });

  it("falls back to the engine's word while no notice has named the wait", () => {
    expect(playButton({ isBuffering: true })["aria-label"]).toBe(
      "Play, buffering",
    );
  });

  it("leaves a settled transport's label alone", () => {
    expect(
      playButton({ waitLabel: "Waiting for more video" })["aria-label"],
    ).toBe("Play");
  });
});
