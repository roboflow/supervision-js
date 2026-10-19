import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  RangeSlider,
  moveRangeThumb,
  nearestRangeThumb,
  rangeKeyTarget,
} from "./RangeSlider";

const bounds = { max: 35, min: 0 };
const range = { max: 20, min: 4 };
const step = 0.1;

describe("the range slider", () => {
  it("moves only the thumb it is told to, on the step", () => {
    expect(moveRangeThumb(range, "min", 6.04, bounds, step)).toEqual({
      max: 20,
      min: 6,
    });
    expect(moveRangeThumb(range, "max", 27.27, bounds, step)).toEqual({
      max: 27.3,
      min: 4,
    });
  });

  it("keeps each thumb inside the track and a step short of the other", () => {
    expect(moveRangeThumb(range, "min", -3, bounds, step).min).toBe(0);
    expect(moveRangeThumb(range, "max", 90, bounds, step).max).toBe(35);
    expect(moveRangeThumb(range, "min", 25, bounds, step)).toEqual({
      max: 20,
      min: 19.9,
    });
    expect(moveRangeThumb(range, "max", 1, bounds, step)).toEqual({
      max: 4.1,
      min: 4,
    });
  });

  it("steps a thumb with the arrows, ten steps with Shift or Page keys, and jumps to an end with Home and End", () => {
    const key = (name: string, coarse = false) =>
      rangeKeyTarget(name, coarse, 20, bounds, step);

    expect(key("ArrowRight")).toBeCloseTo(20.1);
    expect(key("ArrowDown")).toBeCloseTo(19.9);
    expect(key("ArrowLeft", true)).toBeCloseTo(19);
    expect(key("PageUp")).toBeCloseTo(21);
    expect(key("Home")).toBe(0);
    expect(key("End")).toBe(35);
    expect(key("Tab")).toBeNull();
  });

  it("grabs the nearer thumb where the track is pressed", () => {
    expect(nearestRangeThumb(range, 1)).toBe("min");
    expect(nearestRangeThumb(range, 11)).toBe("min");
    expect(nearestRangeThumb(range, 13)).toBe("max");
    expect(nearestRangeThumb(range, 30)).toBe("max");
    expect(nearestRangeThumb({ max: 5, min: 5 }, 9)).toBe("max");
  });

  it("names both thumbs and gives each the values it can take", () => {
    const markup = renderToStaticMarkup(
      <RangeSlider
        bounds={bounds}
        colors={["#000000", "#ffffff"]}
        format={(value) => `${value} px`}
        labels={{ max: "Max (px)", min: "Min (px)" }}
        onChange={() => {}}
        step={step}
        value={range}
      />,
    );
    const thumbs = markup.match(/<div[^>]*role="slider"[^>]*>/g) ?? [];

    expect(thumbs).toHaveLength(2);
    expect(thumbs[0]).toContain('aria-label="Min (px)"');
    expect(thumbs[0]).toContain('aria-valuemin="0"');
    expect(thumbs[0]).toContain('aria-valuemax="20"');
    expect(thumbs[0]).toContain('aria-valuenow="4"');
    expect(thumbs[0]).toContain('aria-valuetext="4 px"');
    expect(thumbs[1]).toContain('aria-label="Max (px)"');
    expect(thumbs[1]).toContain('aria-valuemin="4"');
    expect(thumbs[1]).toContain('aria-valuemax="35"');
    expect(thumbs[1]).toContain('tabindex="0"');
  });
});
