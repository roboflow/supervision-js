import {
  MediaNormalizationContainer,
  MediaNormalizationVideoCodec,
  normalizeMedia,
  type MediaNormalizationProgress,
} from "supervision";

import "./style.css";

const TARGET_FRAME_RATE = 30;
const KEY_FRAME_INTERVAL = 1;

interface ProxyBuildOptions {
  readonly bitrate?: number;
  readonly sourceUrl: string;
}

interface ProxyBuildResult {
  readonly schema: "supervision-js.tools.sam3-fixture.proxy";
  readonly version: 1;
  readonly sourceUrl: string;
  readonly sourceSize: number;
  /** Frame size the source decodes at, which the proxy is re-encoded at. */
  readonly sourceFrame: {
    readonly width: number | null;
    readonly height: number | null;
  };
  readonly mimeType: string;
  readonly size: number;
  readonly normalized: {
    readonly bitrate: number | null;
    readonly container: MediaNormalizationContainer.WebM;
    readonly codec: MediaNormalizationVideoCodec.Vp9;
    readonly frameRate: 30;
    readonly keyFrameInterval: 1;
    readonly audio: "discarded";
  };
}

declare global {
  interface Window {
    buildFixtureProxy: (
      options: ProxyBuildOptions,
    ) => Promise<ProxyBuildResult>;
    readFixtureProxySlice: (offset: number, length: number) => Promise<string>;
    releaseFixtureProxy: () => void;
  }
}

let proxyBlob: Blob | undefined;

const statusElement = document.querySelector<HTMLParagraphElement>("#status");
const outputElement = document.querySelector<HTMLPreElement>("#output");

function setStatus(message: string) {
  if (statusElement) {
    statusElement.textContent = message;
  }
}

function setOutput(value: unknown) {
  if (outputElement) {
    outputElement.textContent = JSON.stringify(value, null, 2);
  }
}

async function buildFixtureProxy(
  options: ProxyBuildOptions,
): Promise<ProxyBuildResult> {
  releaseFixtureProxy();
  setStatus("Loading source media 0%");

  const sourceResponse = await fetch(options.sourceUrl);

  if (!sourceResponse.ok) {
    throw new Error(
      `Unable to fetch ${options.sourceUrl}: ${sourceResponse.status} ${sourceResponse.statusText}`,
    );
  }

  const sourceBlob = await sourceResponse.blob();

  const normalized = await normalizeMedia(sourceBlob, {
    audio: { discard: true },
    container: MediaNormalizationContainer.WebM,
    onProgress: (progress: MediaNormalizationProgress) => {
      setStatus(
        `Normalizing media ${Math.round(Math.min(1, Math.max(0, progress.progress)) * 100)}%`,
      );
    },
    video: {
      ...(options.bitrate === undefined ? {} : { bitrate: options.bitrate }),
      codec: MediaNormalizationVideoCodec.Vp9,
      forceTranscode: true,
      frameRate: TARGET_FRAME_RATE,
      keyFrameInterval: KEY_FRAME_INTERVAL,
    },
  });

  proxyBlob = normalized.blob;

  const result = {
    mimeType: normalized.mimeType,
    normalized: {
      audio: "discarded",
      bitrate: options.bitrate ?? null,
      codec: MediaNormalizationVideoCodec.Vp9,
      container: MediaNormalizationContainer.WebM,
      frameRate: TARGET_FRAME_RATE,
      keyFrameInterval: KEY_FRAME_INTERVAL,
    },
    schema: "supervision-js.tools.sam3-fixture.proxy",
    size: normalized.size,
    sourceFrame: {
      height: normalized.inputMetadata.primaryVideoHeight,
      width: normalized.inputMetadata.primaryVideoWidth,
    },
    sourceSize: sourceBlob.size,
    sourceUrl: options.sourceUrl,
    version: 1,
  } satisfies ProxyBuildResult;

  setStatus("Ready");
  setOutput(result);

  return result;
}

/**
 * The driver pulls the encoded proxy in bounded slices. One evaluate result
 * carrying a whole multi-megabyte file has been seen dropping the debug socket.
 */
async function readFixtureProxySlice(
  offset: number,
  length: number,
): Promise<string> {
  if (!proxyBlob) {
    throw new Error("No fixture proxy has been built.");
  }

  const buffer = await proxyBlob.slice(offset, offset + length).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function releaseFixtureProxy() {
  proxyBlob = undefined;
}

window.buildFixtureProxy = buildFixtureProxy;
window.readFixtureProxySlice = readFixtureProxySlice;
window.releaseFixtureProxy = releaseFixtureProxy;
