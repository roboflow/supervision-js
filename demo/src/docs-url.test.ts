import { describe, expect, it } from "vitest";
import { resolveDemoDocsUrl } from "./docs-url";

describe("resolveDemoDocsUrl", () => {
  it("returns an explicitly configured docs URL", () => {
    expect(
      resolveDemoDocsUrl("https://docs.example.com/", {
        hostname: "demo.example.com",
        href: "https://demo.example.com/demo/",
      }),
    ).toBe("https://docs.example.com/");
  });

  it("keeps local demo and docs servers separate", () => {
    expect(
      resolveDemoDocsUrl(undefined, {
        hostname: "127.0.0.1",
        href: "http://127.0.0.1:5173/",
      }),
    ).toBe("http://127.0.0.1:5175");
  });

  it("returns from the deployed demo route to root docs", () => {
    expect(
      resolveDemoDocsUrl(undefined, {
        hostname: "supervision-js-demo.onrender.com",
        href: "https://supervision-js-demo.onrender.com/demo/?embed=docs-playground",
      }),
    ).toBe("https://supervision-js-demo.onrender.com/");
  });
});
