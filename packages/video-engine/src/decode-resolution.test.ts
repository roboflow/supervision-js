import { describe, expect, it } from "vitest";

import {
  cappedResolution,
  displayBoxResolution,
  nativeResolution,
  resolveDecodeDimensions,
  viewportResolution,
} from "./decode-resolution";

const PORTRAIT = { nativeWidth: 1504, nativeHeight: 2016 };
const UNMEASURED = { ...PORTRAIT, displayWidth: null, devicePixelRatio: 1 };

describe("resolveDecodeDimensions", () => {
  it("keeps native dimensions under the default strategy", () => {
    expect(resolveDecodeDimensions(nativeResolution(), UNMEASURED)).toEqual({
      width: 1504,
      height: 2016,
    });
  });

  it("falls back to native when a viewport strategy has no measured box", () => {
    expect(resolveDecodeDimensions(viewportResolution(), UNMEASURED)).toEqual({
      width: 1504,
      height: 2016,
    });
  });

  it("fits a portrait source into a landscape box by its height", () => {
    const strategy = displayBoxResolution({
      boxWidth: 1080,
      boxHeight: 854,
      devicePixelRatio: 1,
    });
    expect(resolveDecodeDimensions(strategy, UNMEASURED)).toEqual({
      width: 638,
      height: 855,
    });
  });

  it("scales the fitted width by the device pixel ratio", () => {
    const strategy = displayBoxResolution({
      boxWidth: 1080,
      boxHeight: 854,
      devicePixelRatio: 1.5,
    });
    expect(resolveDecodeDimensions(strategy, UNMEASURED).width).toBe(956);
  });

  it("clamps a display-box device pixel ratio to the ceiling of 2", () => {
    const at3 = displayBoxResolution({
      boxWidth: 1080,
      boxHeight: 854,
      devicePixelRatio: 3,
    });
    expect(resolveDecodeDimensions(at3, UNMEASURED)).toEqual({
      width: 1275,
      height: 1709,
    });
  });

  it("clamps a viewport device pixel ratio to the ceiling of 2", () => {
    const measured = {
      ...PORTRAIT,
      displayWidth: 400,
      devicePixelRatio: 3,
    };
    expect(resolveDecodeDimensions(viewportResolution(), measured)).toEqual({
      width: 800,
      height: 1072,
    });
  });

  it("never upscales past native", () => {
    const strategy = displayBoxResolution({
      boxWidth: 6000,
      boxHeight: 6000,
      devicePixelRatio: 2,
    });
    expect(resolveDecodeDimensions(strategy, UNMEASURED)).toEqual({
      width: 1504,
      height: 2016,
    });
  });

  it("falls back to native on a box with no area", () => {
    const strategy = displayBoxResolution({
      boxWidth: 0,
      boxHeight: 854,
      devicePixelRatio: 2,
    });
    expect(resolveDecodeDimensions(strategy, UNMEASURED)).toEqual({
      width: 1504,
      height: 2016,
    });
  });

  it("caps a width without consulting the display box", () => {
    expect(resolveDecodeDimensions(cappedResolution(640), UNMEASURED)).toEqual({
      width: 640,
      height: 858,
    });
  });
});
