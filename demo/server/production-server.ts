import { createReadStream, existsSync, statSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  handleSam3ProxyRequest,
  handleSam3StreamRequest,
  SAM3_PROXY_PATH,
  SAM3_STREAM_PATH,
} from "./roboflow-sam3-plugin.js";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 3000;
const DEFAULT_DIST_ROOT = fileURLToPath(new URL("../dist/", import.meta.url));
const DEFAULT_DOCS_ROOT = fileURLToPath(
  new URL("../../docs/site/", import.meta.url),
);
const DEFAULT_VANILLA_EXAMPLE_ROOT = fileURLToPath(
  new URL("../../examples/vanilla/dist/", import.meta.url),
);
const DOCS_PATH_PREFIX = "/docs";
const VANILLA_EXAMPLE_PATH_PREFIX = "/examples/vanilla";

type RequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void> | void;

export interface DemoServerOptions {
  readonly docsRoot?: string;
  readonly distRoot?: string;
  readonly sam3ProxyHandler?: RequestHandler;
  readonly sam3StreamHandler?: RequestHandler;
  readonly vanillaExampleRoot?: string;
}

export function createDemoServer(options: DemoServerOptions = {}) {
  return createServer(createDemoRequestHandler(options));
}

export function createDemoRequestHandler(options: DemoServerOptions = {}) {
  const docsRoot = resolve(options.docsRoot ?? DEFAULT_DOCS_ROOT);
  const distRoot = resolve(options.distRoot ?? DEFAULT_DIST_ROOT);
  const vanillaExampleRoot = resolve(
    options.vanillaExampleRoot ?? DEFAULT_VANILLA_EXAMPLE_ROOT,
  );
  const sam3ProxyHandler = options.sam3ProxyHandler ?? handleSam3ProxyRequest;
  const sam3StreamHandler =
    options.sam3StreamHandler ?? handleSam3StreamRequest;

  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const pathname = getRequestPathname(request.url);

      if (pathname === SAM3_PROXY_PATH) {
        await sam3ProxyHandler(request, response);
        return;
      }

      if (pathname === SAM3_STREAM_PATH) {
        await sam3StreamHandler(request, response);
        return;
      }

      if (
        pathname === DOCS_PATH_PREFIX ||
        pathname.startsWith(`${DOCS_PATH_PREFIX}/`)
      ) {
        serveStaticAsset(request, response, docsRoot, DOCS_PATH_PREFIX);
        return;
      }

      if (
        pathname === VANILLA_EXAMPLE_PATH_PREFIX ||
        pathname.startsWith(`${VANILLA_EXAMPLE_PATH_PREFIX}/`)
      ) {
        serveStaticAsset(
          request,
          response,
          vanillaExampleRoot,
          VANILLA_EXAMPLE_PATH_PREFIX,
        );
        return;
      }

      serveStaticAsset(request, response, distRoot);
    } catch (error) {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("content-type", "application/json");
      }

      response.end(
        JSON.stringify({
          error:
            error instanceof Error
              ? error.message
              : "Demo server request failed.",
        }),
      );
    }
  };
}

export function startDemoServer(options: DemoServerOptions = {}) {
  const server = createDemoServer(options);
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const host = process.env.HOST ?? DEFAULT_HOST;

  server.listen(port, host, () => {
    console.log(`supervision-js demo listening on http://${host}:${port}`);
  });

  return server;
}

export function resolveStaticAssetPath(
  requestUrl: string | undefined,
  distRoot: string,
  pathPrefix = "",
) {
  const pathname = getRequestPathname(requestUrl);
  const unprefixedPathname = stripPathPrefix(pathname, pathPrefix);

  if (unprefixedPathname === null) {
    return null;
  }

  const decodedPathname = decodeURIComponent(unprefixedPathname);
  const hasExtension = extname(decodedPathname) !== "";
  const requestedPath =
    decodedPathname === "/" ? "/index.html" : decodedPathname;
  const candidate = resolve(distRoot, `.${requestedPath}`);

  if (!isPathInside(candidate, distRoot)) {
    return null;
  }

  if (isReadableFile(candidate)) {
    return candidate;
  }

  if (!hasExtension) {
    const indexPath = resolve(distRoot, "index.html");
    return isReadableFile(indexPath) ? indexPath : null;
  }

  return null;
}

function serveStaticAsset(
  request: IncomingMessage,
  response: ServerResponse,
  distRoot: string,
  pathPrefix = "",
) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.statusCode = 405;
    response.end("Method not allowed.");
    return;
  }

  const assetPath = resolveStaticAssetPath(request.url, distRoot, pathPrefix);

  if (!assetPath) {
    response.statusCode = 404;
    response.end("Not found.");
    return;
  }

  response.statusCode = 200;
  response.setHeader("cache-control", getCacheControl(assetPath, pathPrefix));
  response.setHeader("content-type", getContentType(assetPath));

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  createReadStream(assetPath).pipe(response);
}

function getRequestPathname(requestUrl: string | undefined) {
  return new URL(requestUrl ?? "/", "http://localhost").pathname;
}

function stripPathPrefix(pathname: string, pathPrefix: string) {
  if (!pathPrefix) {
    return pathname;
  }

  if (pathname === pathPrefix) {
    return "/";
  }

  if (pathname.startsWith(`${pathPrefix}/`)) {
    return pathname.slice(pathPrefix.length);
  }

  return null;
}

function isPathInside(candidate: string, root: string) {
  const resolvedRoot = resolve(root);
  return (
    candidate === resolvedRoot || candidate.startsWith(`${resolvedRoot}${sep}`)
  );
}

function isReadableFile(filePath: string) {
  return existsSync(filePath) && statSync(filePath).isFile();
}

function getCacheControl(filePath: string, pathPrefix: string) {
  if (pathPrefix === DOCS_PATH_PREFIX) {
    return "no-cache";
  }

  return filePath.includes(`${sep}assets${sep}`)
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

function getContentType(filePath: string) {
  switch (extname(filePath)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".mp4":
      return "video/mp4";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webm":
      return "video/webm";
    default:
      return "application/octet-stream";
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startDemoServer();
}
