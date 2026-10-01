import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { initialDocsDepthSettings } from "../docs-depth";
import { DepthLiveCode } from "./DepthRendererControls";

describe("depth live code", () => {
  it("shows the presentation call for the settings it is given", () => {
    const markup = renderToStaticMarkup(
      <DepthLiveCode
        settings={{
          ...initialDocsDepthSettings,
          colormap: "magma",
          opacity: 0.65,
          wipe: 0.4,
        }}
      />,
    );

    expect(markup).toContain("session.setPresentation({");
    expect(markup).toContain("colormap: &quot;magma&quot;");
    expect(markup).toContain("opacity: 0.65");
    expect(markup).toContain("wipe: 0.4");
  });
});
