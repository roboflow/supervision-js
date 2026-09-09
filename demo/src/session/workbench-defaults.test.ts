import { describe, expect, it } from "vitest";

import {
  applyDemoMediaPath,
  DemoMediaPath,
  type DemoSessionOptions,
} from "./session-options";
import {
  countChangedDemoSessionOptions,
  demoInitialSessionOptions,
} from "./workbench-defaults";

describe("what the workbench opens on", () => {
  it("opens on the reader the library ships with", () => {
    expect(applyDemoMediaPath(demoInitialSessionOptions)).toBe(
      DemoMediaPath.Mediabunny,
    );
  });

  it("counts nothing changed on the options a clip opens with", () => {
    expect(countChangedDemoSessionOptions(demoInitialSessionOptions)).toBe(0);
  });

  it("counts a media path returned to the workbench's own as unchanged", () => {
    const moved: DemoSessionOptions = {
      ...demoInitialSessionOptions,
      mediaPath: DemoMediaPath.Engine,
    };

    expect(countChangedDemoSessionOptions(moved)).toBe(1);
    expect(
      countChangedDemoSessionOptions({
        ...moved,
        mediaPath: DemoMediaPath.Mediabunny,
      }),
    ).toBe(0);
  });

  /* Reset hands these options back. An empty set would clear `mediaPath`, and
   * an absent `mediaPath` is the engine, so Reset would move the session onto
   * a path nobody picked. */
  it("names a media path, so clearing the panel cannot switch the reader", () => {
    expect(demoInitialSessionOptions.mediaPath).toBeDefined();
  });
});
