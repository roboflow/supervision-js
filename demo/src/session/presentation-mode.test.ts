import { describe, expect, it } from "vitest";

import {
  CANVAS_PRESENTATION_NOTICE,
  readDemoPresentationMode,
} from "./presentation-mode";

describe("readDemoPresentationMode", () => {
  it("runs frames presentation when nothing asks otherwise", () => {
    expect(readDemoPresentationMode("")).toBe("frames");
    expect(readDemoPresentationMode("?decode=native")).toBe("frames");
  });

  it("opens canvas presentation on request", () => {
    expect(readDemoPresentationMode("?presentation=canvas")).toBe("canvas");
  });

  it("ignores a presentation it cannot open", () => {
    expect(readDemoPresentationMode("?presentation=frames")).toBe("frames");
    expect(readDemoPresentationMode("?presentation=webgpu")).toBe("frames");
  });

  it("says annotations are impossible in canvas mode", () => {
    expect(CANVAS_PRESENTATION_NOTICE).toMatch(/boxes/);
    expect(CANVAS_PRESENTATION_NOTICE).toMatch(/permanently/);
  });
});
