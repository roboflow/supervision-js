import { describe, expect, it } from "vitest";

import { IMMUTABLE_ASSET_PATH } from "./pages-preview.vite.config";

describe("IMMUTABLE_ASSET_PATH", () => {
  it("matches the names the build emits", () => {
    for (const name of [
      "000000-BhqPG9ym.json",
      "1min-horse-video-DS5K9pcE.mov",
      "index-D9O99vei.js",
      "basketball_sample-BYPdHQeT.mp4",
    ]) {
      expect(IMMUTABLE_ASSET_PATH.test(`/assets/${name}`)).toBe(true);
    }
  });

  it("leaves a hand-written name revalidating, however hash-shaped it reads", () => {
    for (const name of [
      "docs-annotation-renderer.js",
      "my-detections.json",
      "style-override.css",
      "custom.css",
      "icons.svg",
    ]) {
      expect(IMMUTABLE_ASSET_PATH.test(`/assets/${name}`)).toBe(false);
    }
  });

  it("claims nothing outside the build's own asset directory", () => {
    expect(IMMUTABLE_ASSET_PATH.test("/index-D9O99vei.js")).toBe(false);
    expect(IMMUTABLE_ASSET_PATH.test("/demo/")).toBe(false);
  });
});
