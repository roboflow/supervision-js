import {
  BaseLabelStyle,
  BaseMaskStyle,
  BaseBoxStyle,
  BoxShape,
  createChunkedDetectionFrameSource,
  createMediaSession,
  DetectionFrameSelectionMode,
  MediaRendererFit,
  MediaRendererPlaybackState,
  annotationRenderers,
  type DetectionFrameChunk,
  type DetectionFrameChunkDescriptor,
  type DetectionFrameChunkManifest,
  type MediaSession,
  type MediaSessionState,
} from "supervision";

import "./style.css";

import basketballManifestUrl from "../../../demo/fixtures/basketball_sam3/detections.manifest.json?url";
import basketballVideoUrl from "../../../demo/fixtures/basketball_sample/basketball_sample.mp4?url";

const chunkUrls = import.meta.glob(
  "../../../demo/fixtures/basketball_sam3/detections/*.json",
  {
    eager: true,
    import: "default",
    query: "?url",
  },
) as Record<string, string>;

const viewer = requireElement<HTMLDivElement>("viewer");
const playToggle = requireElement<HTMLButtonElement>("play-toggle");
const statusText = requireElement<HTMLElement>("session-status");
const timeText = requireElement<HTMLElement>("session-time");
const detectionText = requireElement<HTMLElement>("session-detections");

let session: MediaSession | null = null;

void startExample().catch((error: unknown) => {
  statusText.textContent =
    error instanceof Error ? error.message : "Unable to start example.";
  console.error(error);
});

async function startExample() {
  const manifest = await fetchJson<DetectionFrameChunkManifest>(
    basketballManifestUrl,
  );
  const detectionSource = createChunkedDetectionFrameSource({
    fetchChunk,
    manifest,
  });

  session = await createMediaSession({
    container: viewer,
    detections: {
      source: detectionSource,
      sync: {
        frameIndexOriginTime: 0,
        frameRate: manifest.frameRate,
        selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
      },
    },
    media: basketballVideoUrl,
    onState: renderSessionState,
    presentation: {
      renderers: [
        annotationRenderers.box({
          style: new BaseBoxStyle({
            cornerRadius: 8,
            shape: BoxShape.RoundedRect,
            stroke: (detection) => ({
              alpha: 1,
              color: resolveClassColor(detection.className),
              width: 3,
            }),
          }),
        }),
        annotationRenderers.label({
          style: new BaseLabelStyle({
            background: (detection) => ({
              alpha: 0.78,
              color: resolveClassColor(detection.className),
            }),
            includeConfidence: true,
          }),
        }),
        annotationRenderers.mask({
          style: new BaseMaskStyle({
            color: (detection) => resolveClassColor(detection.className),
            opacity: 0.45,
            stroke: (detection) => ({
              alpha: 1,
              color: resolveClassColor(detection.className),
              width: 3,
            }),
          }),
        }),
      ],
    },
    renderer: {
      autoPlay: false,
      fit: MediaRendererFit.Contain,
      loop: true,
      onFrame: ({ currentTime }) => {
        timeText.textContent = `${currentTime.toFixed(2)}s`;
      },
    },
  });

  playToggle.addEventListener("click", () => {
    const currentSession = session;

    if (!currentSession) {
      return;
    }

    const state = currentSession.getState();

    if (state.renderer?.playbackState === MediaRendererPlaybackState.Playing) {
      currentSession.pause();
      return;
    }

    void currentSession.play();
  });
}

async function fetchChunk(
  chunk: DetectionFrameChunkDescriptor,
): Promise<DetectionFrameChunk> {
  const src = chunk.src.split("/").at(-1);
  const chunkUrl = Object.entries(chunkUrls).find(([path]) =>
    path.endsWith(`/${src}`),
  )?.[1];

  if (!chunkUrl) {
    throw new Error(`Missing detection chunk asset: ${chunk.src}`);
  }

  return fetchJson<DetectionFrameChunk>(chunkUrl);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Unable to load ${url}: ${response.status}`);
  }

  return (await response.json()) as T;
}

function renderSessionState(state: MediaSessionState) {
  statusText.textContent = state.status;
  detectionText.textContent = String(state.renderer?.activeDetectionCount ?? 0);

  const isPlaying =
    state.renderer?.playbackState === MediaRendererPlaybackState.Playing;
  playToggle.textContent = isPlaying ? "Pause" : "Play";
}

function resolveClassColor(className: string | undefined) {
  switch (className) {
    case "basketball":
      return 0xf97316;
    case "white team player":
      return 0xf8fafc;
    case "yellow team player":
      return 0xfacc15;
    default:
      return 0x38bdf8;
  }
}

function requireElement<T extends HTMLElement>(id: string) {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing #${id} element.`);
  }

  return element as T;
}
