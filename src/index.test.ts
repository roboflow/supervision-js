import { describe, expect, it } from "vitest";

describe("package entrypoint", () => {
  it("loads before a public API exists", async () => {
    const entrypoint = await import("./index");

    expect(Object.keys(entrypoint)).toEqual([]);
  });
});
