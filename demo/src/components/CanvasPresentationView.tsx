import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PlaybackStatus,
  SourceKind,
  WebVideoEngine,
  type DiagnosticsSnapshot,
  type EngineReadySnapshot,
} from "supervision/web-video-engine";

import {
  defaultDemoFixture,
  demoFixtures,
  resolveDemoFixturePlaybackSrc,
} from "../fixtures/demo-fixtures";
import { formatInteger, formatTime } from "../format";
import { CANVAS_PRESENTATION_NOTICE } from "../session/presentation-mode";

const SAMPLE_PARAM = "sample";

/**
 * The engine driving its own canvas, which is the presentation mode the demo's
 * ordinary path cannot select.
 *
 * It is a separate player because the two cannot share a surface.
 * `createMediaSession` composites the engine's
 * frames into a Pixi scene it owns; here the engine holds the canvas and the
 * page never sees a frame, so every layer, picker and readout the session
 * provides has nothing to act on.
 */
export function CanvasPresentationView() {
  const fixture = useSelectedFixture();
  const playbackSrc = resolveDemoFixturePlaybackSrc(fixture);
  const [mount, setMount] = useState<HTMLDivElement | null>(null);
  const engineRef = useRef<WebVideoEngine | null>(null);
  const [metadata, setMetadata] = useState<EngineReadySnapshot | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(
    null,
  );
  const [status, setStatus] = useState(PlaybackStatus.Loading);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!mount) {
      return;
    }

    // This effect owns the element as well as the engine. Binding transfers
    // the canvas for good, so a remount that reused it would hand a detached
    // canvas to the next engine and every engine after the first would fail
    // to bind.
    const canvas = document.createElement("canvas");
    canvas.className = "canvas-presentation__canvas";
    mount.append(canvas);

    const engine = new WebVideoEngine({
      presentation: "canvas",
      source: { kind: SourceKind.Url, url: playbackSrc },
    });
    engineRef.current = engine;

    let released = false;
    const readPlayhead = () => setPlayheadMs(engine.getTimeMs());
    const unsubscribe = [
      engine.subscribe("time", readPlayhead),
      engine.subscribe("frame", readPlayhead),
      engine.subscribe("state", () => setStatus(engine.getStatus())),
      engine.subscribeDiagnostics(() =>
        setDiagnostics(engine.getLatestDiagnostics()),
      ),
    ];

    void (async () => {
      try {
        const ready = await engine.load();

        if (released) {
          return;
        }

        setMetadata(ready);
        engine.bindCanvas(canvas);
        engine.startDiagnostics();
      } catch (error) {
        if (!released) {
          setFailure(error instanceof Error ? error.message : String(error));
        }
      }
    })();

    return () => {
      released = true;
      for (const off of unsubscribe) {
        off();
      }
      engineRef.current = null;
      canvas.remove();
      void engine.dispose();
    };
  }, [mount, playbackSrc]);

  const playing = status === PlaybackStatus.Playing;
  const durationMs = metadata?.durationMs ?? 0;
  const onTogglePlayback = useCallback(() => {
    engineRef.current?.togglePlayback();
  }, []);
  const onStep = useCallback((direction: 1 | -1) => {
    void engineRef.current?.step(direction);
  }, []);
  const onScrub = useCallback((ms: number) => {
    setPlayheadMs(ms);
    engineRef.current?.scrub(ms);
  }, []);
  const onCommit = useCallback((ms: number) => {
    void engineRef.current?.commit(ms);
  }, []);

  return (
    <main className="canvas-presentation">
      <header className="canvas-presentation__header">
        <div>
          <span className="canvas-presentation__eyebrow">
            supervision-js / web video engine
          </span>
          <strong>Canvas presentation</strong>
        </div>
        <label className="canvas-presentation__sample">
          Sample
          <select
            onChange={(event) => openSample(event.target.value)}
            value={fixture.sampleName}
          >
            {demoFixtures.map((option) => (
              <option key={option.sampleName} value={option.sampleName}>
                {option.displayName}
              </option>
            ))}
          </select>
        </label>
      </header>

      <p className="canvas-presentation__notice" role="note">
        {CANVAS_PRESENTATION_NOTICE}
      </p>

      <section
        className="canvas-presentation__stage"
        aria-label="Engine canvas"
      >
        <div className="canvas-presentation__mount" ref={setMount} />
        {failure ? (
          <p className="canvas-presentation__failure" role="alert">
            {failure}
          </p>
        ) : null}
      </section>

      <div
        className="canvas-presentation__transport"
        role="group"
        aria-label="Transport"
      >
        <button
          aria-label="Previous frame"
          disabled={!metadata}
          onClick={() => onStep(-1)}
          type="button"
        >
          -1
        </button>
        <button
          aria-label={playing ? "Pause" : "Play"}
          disabled={!metadata}
          onClick={onTogglePlayback}
          type="button"
        >
          {playing ? "Pause" : "Play"}
        </button>
        <button
          aria-label="Next frame"
          disabled={!metadata}
          onClick={() => onStep(1)}
          type="button"
        >
          +1
        </button>
        <input
          aria-label="Playhead"
          disabled={!metadata}
          max={durationMs}
          min={0}
          onChange={(event) => onScrub(Number(event.target.value))}
          onPointerDown={() => engineRef.current?.beginInteractiveSeek()}
          onPointerUp={(event) => {
            onCommit(Number(event.currentTarget.value));
            void engineRef.current?.endInteractiveSeek();
          }}
          step={1}
          type="range"
          value={Math.min(playheadMs, durationMs)}
        />
        <output className="canvas-presentation__clock">
          {formatTime(playheadMs / 1000)} / {formatTime(durationMs / 1000)}
        </output>
      </div>

      <CanvasPresentationStats diagnostics={diagnostics} status={status} />
    </main>
  );
}

function CanvasPresentationStats({
  diagnostics,
  status,
}: {
  readonly diagnostics: DiagnosticsSnapshot | null;
  readonly status: PlaybackStatus;
}) {
  const stats: readonly (readonly [string, string, string])[] = [
    ["status", "Status", status],
    ["presentation", "Presentation", diagnostics?.presentation ?? "-"],
    ["renderer", "Renderer", diagnostics?.renderer ?? "unresolved"],
    [
      "webgpu",
      "WebGPU available",
      diagnostics ? String(diagnostics.webgpuAvailable) : "-",
    ],
    [
      "paintedFrames",
      "Painted frames",
      diagnostics ? formatInteger(diagnostics.pipeline.paintedFrames) : "-",
    ],
    [
      "decodedFrames",
      "Decoded frames",
      diagnostics?.pipeline.decodedFrames === null ||
      diagnostics?.pipeline.decodedFrames === undefined
        ? "-"
        : formatInteger(diagnostics.pipeline.decodedFrames),
    ],
    [
      "droppedFrames",
      "Dropped frames",
      diagnostics ? formatInteger(diagnostics.pipeline.droppedFrames) : "-",
    ],
    [
      "paintFps",
      "Paint rate",
      diagnostics?.realtime.effectivePaintFps === null ||
      diagnostics?.realtime.effectivePaintFps === undefined
        ? "-"
        : `${diagnostics.realtime.effectivePaintFps.toFixed(2)} fps`,
    ],
    [
      "presentedRate",
      "Presented rate",
      diagnostics?.presentedRate === null ||
      diagnostics?.presentedRate === undefined
        ? "-"
        : `${diagnostics.presentedRate.toFixed(2)}x`,
    ],
    [
      "warnings",
      "Warnings",
      diagnostics?.warnings.length
        ? diagnostics.warnings.map((warning) => warning.id).join(", ")
        : "none",
    ],
  ];

  return (
    <dl className="canvas-presentation__stats">
      {stats.map(([key, label, value]) => (
        <div className="canvas-presentation__stat" data-stat={key} key={key}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function useSelectedFixture() {
  return useMemo(() => {
    const requested = new URLSearchParams(
      globalThis.location?.search ?? "",
    ).get(SAMPLE_PARAM);

    return (
      demoFixtures.find((fixture) => fixture.sampleName === requested) ??
      defaultDemoFixture
    );
  }, []);
}

/**
 * A transferred canvas cannot be handed back, so a sample change reloads the
 * page and the next engine opens on a fresh element.
 */
function openSample(sampleName: string) {
  const url = new URL(globalThis.location.href);

  url.searchParams.set(SAMPLE_PARAM, sampleName);
  globalThis.location.assign(url);
}
