/**
 * Source translation: what the engine hands mediabunny for each VideoSource
 * variant. Mocks mediabunny so the constructed source records its arguments.
 */

import { describe, expect, it, vi } from "vitest";

import { toMediabunnySource } from "./decode-source";
import { createSourceResidency } from "./source-residency";
import { SourceKind } from "./types";

vi.mock("mediabunny", () => ({
  UrlSource: class {
    constructor(
      readonly url: string,
      readonly options?: { requestInit?: RequestInit },
    ) {}
  },
  BlobSource: class {
    constructor(readonly blob: Blob) {}
  },
  ReadableStreamSource: class {
    constructor(readonly stream: ReadableStream<Uint8Array>) {}
  },
}));

const URL_STRING = "https://cdn.example.test/clip.mp4";

function urlSource(crossOrigin?: "anonymous" | "use-credentials") {
  return toMediabunnySource({
    kind: SourceKind.Url,
    url: URL_STRING,
    crossOrigin,
  }) as unknown as { url: string; options?: { requestInit?: RequestInit } };
}

describe("toMediabunnySource", () => {
  it("leaves the fetch alone when the source declares no crossOrigin", () => {
    const source = urlSource();
    expect(source.url).toBe(URL_STRING);
    expect(source.options).toBeUndefined();
  });

  it("anonymous asks for a CORS fetch that carries no credentials", () => {
    expect(urlSource("anonymous").options?.requestInit).toEqual({
      mode: "cors",
      credentials: "omit",
    });
  });

  it("use-credentials asks for a CORS fetch that carries them", () => {
    expect(urlSource("use-credentials").options?.requestInit).toEqual({
      mode: "cors",
      credentials: "include",
    });
  });

  it("routes the demuxer's reads through a residency when one is given", () => {
    const residency = createSourceResidency({
      url: URL_STRING,
      budgetBytes: 1024,
      fetchImpl: (async () => new Response()) as unknown as typeof fetch,
    });
    const source = toMediabunnySource(
      { kind: SourceKind.Url, url: URL_STRING },
      residency,
    ) as unknown as { options?: { fetchFn?: typeof fetch } };
    expect(source.options?.fetchFn).toBe(residency.fetchFn);
  });
});
