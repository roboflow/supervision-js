import { useCallback, useMemo, useRef, useState, type DragEvent } from "react";
import { MediaRendererPlaybackState, type MediaSourceState } from "supervision";
import type { FrameTimelineData } from "supervision/web-video-engine";

import { ControlBar } from "../components/ControlBar";
import { PlayerHotkeys } from "../components/PlayerHotkeys";
import { RendererViewport } from "../components/RendererViewport";
import { readTimelineFrames } from "../components/timeline-frames";
import { selectViewportSessionState } from "../components/viewport-overlay";
import { resolveDemoDocsUrl } from "../docs-url";
import { formatInteger, formatTime } from "../format";
import { useViewportOverlay } from "../hooks/useViewportOverlay";
import { PlayerSpeedControl } from "./PlayerSpeedControl";
import {
  createFilePlayerSource,
  defaultPlayerSource,
  findVideoFile,
  listPlayerSamples,
  type PlayerSource,
} from "./player-source";
import { usePlayerSession } from "./usePlayerSession";

const docsUrl = resolveDemoDocsUrl(
  import.meta.env.VITE_SUPERVISION_DOCS_URL,
  globalThis.location,
);
const samples = listPlayerSamples();
const noRanges = [] as const;

/**
 * The web video engine on its own: a sample or a file from disk, played,
 * stepped and scrubbed through the same media session, viewport and control
 * bar the workbench uses, with nothing drawn over the picture.
 */
export function PlayerApp() {
  const [source, setSource] = useState<PlayerSource>(() =>
    defaultPlayerSource(samples),
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepthRef = useRef(0);
  const player = usePlayerSession(source);
  const viewportSessionState = useMemo(
    () => selectViewportSessionState(player.sessionState),
    [player.sessionState],
  );
  const viewportOverlay = useViewportOverlay(
    viewportSessionState,
    null,
    player.mediaState,
  );
  const alertMessage = notice ?? player.errorMessage;
  const isPlaying = player.playbackState === MediaRendererPlaybackState.Playing;

  const openFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }

    const file = findVideoFile(files);

    if (!file) {
      setNotice(`${files[0].name} is not a video file.`);
      return;
    }

    setNotice(null);
    setSource(createFilePlayerSource(file));
  }, []);

  // Enter and leave fire for every child the pointer crosses, so the overlay
  // follows a depth count rather than the last event.
  const dropHandlers = {
    onDragEnter: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setDragging(true);
    },
    onDragLeave: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDragging(false);
    },
    onDragOver: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDrop: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setDragging(false);
      openFiles(event.dataTransfer.files);
    },
  };

  return (
    <>
      <PlayerHotkeys
        currentTime={player.rendererState?.currentTime ?? null}
        disabled={!player.canUseRenderer}
        duration={player.duration}
        isPlaying={isPlaying}
        onPause={player.onPause}
        onPlay={player.onPlay}
        onSeek={player.onSeek}
        onSetPlaybackRate={player.onSetPlaybackRate}
        onStepFrame={player.onStepFrame}
        onTogglePlayback={player.onTogglePlayback}
        playbackRate={player.playbackRate}
      />
      <main className="demo-shell demo-shell--demo" {...dropHandlers}>
        <header className="demo-shell__header">
          <div className="demo-shell__brand">
            <div className="demo-shell__mark" aria-hidden="true">
              <img
                alt=""
                src={`${import.meta.env.BASE_URL}roboflow-logomark.svg`}
              />
            </div>
            <div className="demo-shell__title">
              <span className="demo-shell__eyebrow">
                Roboflow / supervision
              </span>
              <strong>supervision-js</strong>
              <span>Web video player</span>
            </div>
          </div>
          <nav aria-label="Pages" className="demo-shell__mode">
            <a href={docsUrl} rel="noreferrer" target="_blank">
              Docs
            </a>
            <a aria-current="page" href="player">
              Player
            </a>
            <a href="./">Demo</a>
          </nav>
        </header>

        <div className="demo-shell__workspace">
          <aside
            aria-label="Player controls"
            className="demo-shell__inspector player-shell__inspector"
          >
            <div className="demo-shell__panels">
              <section
                aria-label="Media source controls"
                className="source-controls"
              >
                <header className="inspector-card__header">
                  <h2>Source</h2>
                </header>
                <div className="source-controls__mode">
                  {samples.map((sample) => (
                    <button
                      aria-pressed={
                        source.kind === "sample" && source.id === sample.id
                      }
                      key={sample.id}
                      onClick={() => {
                        setNotice(null);
                        setSource(sample);
                      }}
                      type="button"
                    >
                      {sample.label}
                    </button>
                  ))}
                </div>
                <label className="source-field source-field--file">
                  <span>Your video</span>
                  <input
                    accept="video/*,.mkv,.mov"
                    onChange={(event) => {
                      openFiles(event.currentTarget.files);
                      // Picking the same file again is still a request to open it.
                      event.currentTarget.value = "";
                    }}
                    type="file"
                  />
                  <strong>
                    {source.kind === "file"
                      ? source.label
                      : "Choose or drop a video file"}
                  </strong>
                </label>
                <p className="selection-panel__hint">
                  Files play straight from disk and never leave this tab.
                </p>
                {alertMessage ? (
                  <p
                    className="selection-panel__hint player-shell__alert"
                    role="alert"
                  >
                    {alertMessage}
                  </p>
                ) : null}
              </section>

              <PlayerSpeedControl
                disabled={!player.canUseRenderer}
                isPlaying={isPlaying}
                onSetPlaybackRate={player.onSetPlaybackRate}
                playbackRate={player.playbackRate}
                presentedRate={player.presentedRate}
              />

              <VideoPanel
                frameTimeline={player.frameTimeline}
                label={source.label}
                origin={source.kind === "file" ? "Local file" : "Sample"}
                source={player.rendererState?.source ?? null}
              />
            </div>
          </aside>

          <section className="demo-shell__stage" aria-label="Renderer stage">
            <div className="demo-shell__viewport player-shell__viewport">
              <RendererViewport
                containerRef={player.containerRef}
                explained={viewportOverlay.explained}
                overlay={viewportOverlay.overlay}
              />
              {dragging ? (
                <div className="player-shell__drop" aria-hidden="true">
                  <strong>Drop to play</strong>
                  <span>MP4, MOV, WebM or MKV, read straight from disk</span>
                </div>
              ) : null}
            </div>
            <ControlBar
              annotations={false}
              canUseRenderer={player.canUseRenderer}
              duration={player.duration}
              frameTimeline={player.frameTimeline}
              onScrub={player.onScrub}
              onSeek={player.onSeek}
              onSetPlaybackRate={player.onSetPlaybackRate}
              onStepFrame={player.onStepFrame}
              onTogglePlayback={player.onTogglePlayback}
              playbackRate={player.playbackRate}
              playbackState={player.playbackState}
              presentedRate={player.presentedRate}
              processedRanges={noRanges}
              processingRanges={noRanges}
              sourceResidency={null}
              waitLabel={viewportOverlay.overlay?.label ?? null}
            />
          </section>
        </div>
      </main>
    </>
  );
}

/** What is open, in the selection panel's own card and grid. */
function VideoPanel({
  frameTimeline,
  label,
  origin,
  source,
}: {
  readonly frameTimeline: FrameTimelineData | null;
  readonly label: string;
  readonly origin: string;
  readonly source: MediaSourceState | null;
}) {
  const frameCount = readTimelineFrames(frameTimeline)?.frameCount ?? null;

  return (
    <section aria-label="Video" className="selection-panel">
      <header className="inspector-card__header">
        <h2>Video</h2>
      </header>
      <div className="selection-details">
        <div className="selection-details__title">
          <strong title={label}>{label}</strong>
          <span>{origin}</span>
        </div>
        <dl className="selection-details__grid">
          <VideoDatum
            label="Size"
            value={
              source?.primaryVideoWidth && source.primaryVideoHeight
                ? `${source.primaryVideoWidth} x ${source.primaryVideoHeight}`
                : "-"
            }
          />
          <VideoDatum
            label="Frame rate"
            value={
              source?.estimatedFrameRate
                ? `${source.estimatedFrameRate.toFixed(2).replace(/\.?0+$/, "")} fps`
                : "-"
            }
          />
          <VideoDatum
            label="Frames"
            value={frameCount === null ? "-" : formatInteger(frameCount)}
          />
          <VideoDatum
            label="Duration"
            value={formatTime(source?.duration ?? null)}
          />
        </dl>
      </div>
    </section>
  );
}

function VideoDatum({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function carriesFiles(event: DragEvent) {
  return Array.from(event.dataTransfer.types).includes("Files");
}
