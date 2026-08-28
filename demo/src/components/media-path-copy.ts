import { DemoMediaPath } from "../session/session-options";

/** What one media path is, in the terms someone choosing between them needs. */
export interface DemoMediaPathCopy {
  /** What you import to get it. */
  readonly imports: string;
  readonly label: string;
  /** When you would pick this one. */
  readonly pickWhen: string;
  /** What it costs. */
  readonly costs: string;
  /** What it is good at. */
  readonly goodAt: string;
  /** What it does with the clip. */
  readonly summary: string;
}

export const demoMediaPathCopy: Record<DemoMediaPath, DemoMediaPathCopy> = {
  [DemoMediaPath.Mediabunny]: {
    costs:
      "Every jump decodes forward from the nearest keyframe and keeps nothing, so dragging the playhead waits for a decode at each stop.",
    goodAt:
      "Playing a clip through. It is also the only path that can convert the file first, which is how a codec the browser cannot step through becomes one it can.",
    imports:
      "createMediaSession, from supervision. Hand it the file and nothing else.",
    label: "Mediabunny",
    pickWhen:
      "Pick it for playback and light scrubbing, and whenever the file has to be converted before it will play at all.",
    summary:
      "The library is handed the clip's address and reads and decodes it itself. This is what createMediaSession does with a URL and no source of your own.",
  },
  [DemoMediaPath.Engine]: {
    costs:
      "Memory for the frames it keeps, and it reads the file itself, so the library's conversion step never runs on this path.",
    goodAt:
      "Scrubbing and frame stepping. A drag paints from frames it already decoded instead of waiting, and jumping into the middle of a long file fetches only the ranges it needs.",
    imports:
      "createVideoEngineMediaRendererSource, from supervision/web-video-engine. Pass what it returns as the media.",
    label: "Web video engine",
    pickWhen:
      "Pick it for annotation work: scrubbing, stepping frame by frame, and long files served over the network.",
    summary:
      "A separate decoder opens the clip: it decodes in a worker, keeps frames it has already decoded, and fetches the file in ranges as it needs them.",
  },
};

export const demoMediaPathOrder: readonly DemoMediaPath[] = [
  DemoMediaPath.Mediabunny,
  DemoMediaPath.Engine,
];
