import { describe, expect, it } from "vitest";

import { isEnginePresentationRequested } from "./engine-presentation-mode";

describe("engine presentation switch", () => {
  it.each([
    ["?present=engine", true],
    ["?fixture=horse_trail&present=engine", true],
    ["?present=mediabunny", false],
    ["", false],
  ])("reads %s as %s", (search, expected) => {
    expect(isEnginePresentationRequested(search)).toBe(expected);
  });
});
