import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createDemoRequestHandler,
  resolveStaticAssetPath,
} from "./production-server";

describe("production demo server", () => {
  it("routes SAM3 API requests to injected handlers", async () => {
    const distRoot = await createFixtureDist();
    const handler = vi.fn((_request, response) => {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });
    const requestHandler = createDemoRequestHandler({
      distRoot,
      sam3StreamHandler: handler,
    });
    const response = createFakeResponse();

    await requestHandler(
      createFakeRequest("/api/roboflow/sam3/concept_segment_stream"),
      response,
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(JSON.stringify({ ok: true }));
  });

  it("resolves static assets and falls back to index for app routes", async () => {
    const distRoot = await createFixtureDist();

    expect(resolveStaticAssetPath("/", distRoot)).toBe(
      join(distRoot, "index.html"),
    );
    expect(resolveStaticAssetPath("/assets/app.js", distRoot)).toBe(
      join(distRoot, "assets", "app.js"),
    );
    expect(resolveStaticAssetPath("/upload", distRoot)).toBe(
      join(distRoot, "index.html"),
    );
  });

  it("serves generated docs from the /docs path prefix", async () => {
    const docsRoot = await createFixtureDist("docs");

    expect(resolveStaticAssetPath("/docs", docsRoot, "/docs")).toBe(
      join(docsRoot, "index.html"),
    );
    expect(
      resolveStaticAssetPath("/docs/assets/app.js", docsRoot, "/docs"),
    ).toBe(join(docsRoot, "assets", "app.js"));
    expect(
      resolveStaticAssetPath("/assets/app.js", docsRoot, "/docs"),
    ).toBeNull();
  });

  it("does not cache generated docs assets as immutable", async () => {
    const docsRoot = await createFixtureDist("docs-cache");
    const requestHandler = createDemoRequestHandler({ docsRoot });
    const response = createFakeResponse();

    await requestHandler(
      createFakeRequest("/docs/assets/app.js", "GET"),
      response,
    );

    expect(response.setHeader).toHaveBeenCalledWith(
      "cache-control",
      "no-cache",
    );
  });

  it("keeps built demo assets immutable", async () => {
    const distRoot = await createFixtureDist("demo-cache");
    const requestHandler = createDemoRequestHandler({ distRoot });
    const response = createFakeResponse();

    await requestHandler(createFakeRequest("/assets/app.js", "GET"), response);

    expect(response.setHeader).toHaveBeenCalledWith(
      "cache-control",
      "public, max-age=31536000, immutable",
    );
  });

  it("serves the vanilla example from the /examples/vanilla path prefix", async () => {
    const vanillaExampleRoot = await createFixtureDist("vanilla-example");

    expect(
      resolveStaticAssetPath(
        "/examples/vanilla",
        vanillaExampleRoot,
        "/examples/vanilla",
      ),
    ).toBe(join(vanillaExampleRoot, "index.html"));
    expect(
      resolveStaticAssetPath(
        "/examples/vanilla/assets/app.js",
        vanillaExampleRoot,
        "/examples/vanilla",
      ),
    ).toBe(join(vanillaExampleRoot, "assets", "app.js"));
    expect(
      resolveStaticAssetPath(
        "/assets/app.js",
        vanillaExampleRoot,
        "/examples/vanilla",
      ),
    ).toBeNull();
  });

  it("does not resolve path traversal requests", async () => {
    const distRoot = await createFixtureDist();

    expect(resolveStaticAssetPath("/../package.json", distRoot)).toBeNull();
  });
});

async function createFixtureDist(name = "demo-server") {
  const root = join(tmpdir(), `supervision-js-${name}-${crypto.randomUUID()}`);
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), "<main>demo</main>");
  await writeFile(join(root, "assets", "app.js"), "console.log('demo');");
  return root;
}

function createFakeRequest(url: string, method = "POST") {
  return {
    method,
    url,
  } as IncomingMessage;
}

function createFakeResponse() {
  const response = {
    body: "",
    headersSent: false,
    setHeader: vi.fn(),
    statusCode: 0,
    end: vi.fn((body?: string) => {
      response.body = body ?? "";
      response.headersSent = true;
    }),
  };

  return response as unknown as ServerResponse & { body: string };
}
