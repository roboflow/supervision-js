import { renderToStaticMarkup } from "react-dom/server";
import type { DiagnosticsSnapshot } from "supervision-js-web-video-engine";
import type { MediaRendererSource } from "supervision";
import { describe, expect, it } from "vitest";

import type { EngineDiagnosticsTap } from "../diagnostics/engine-diagnostics-tap";
import { EngineDiagnostics } from "./EngineDiagnostics";

/** A tap with an engine on the other side of it and nothing read yet. */
function silentTap(): EngineDiagnosticsTap {
  return {
    armTrace() {},
    attached: () => true,
    disarmTrace() {},
    exportTrace: async () => null,
    read: (): DiagnosticsSnapshot | null => null,
    readOnce: () => () => {},
    start: () => () => {},
    subscribe: () => () => {},
    tap: (source: MediaRendererSource) => source,
  };
}

describe("EngineDiagnostics", () => {
  /* Asking the engine about itself starts the worker broadcast, the per-frame
   * counters and a walk over the whole file, so opening the panel asks nothing.
   * The offer then has to be on screen, and it has to say what it costs. */
  it("offers the reading rather than taking it", () => {
    const markup = renderToStaticMarkup(
      <EngineDiagnostics tap={silentTap()} />,
    );

    expect(markup).toContain("Read while it runs");
    expect(markup).toContain("read once");
    expect(markup).toContain("not reading");
  });

  it("says which side of the panel has nothing to report", () => {
    const detached: EngineDiagnosticsTap = {
      ...silentTap(),
      attached: () => false,
    };

    expect(
      renderToStaticMarkup(<EngineDiagnostics tap={detached} />),
    ).toContain("No video engine source is open");
    expect(
      renderToStaticMarkup(<EngineDiagnostics tap={silentTap()} />),
    ).toContain("Nothing read yet");
  });
});
