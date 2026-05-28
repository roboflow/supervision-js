import { useEffect, useRef, useState } from "react";

import {
  createInitialBenchmarkRenderer,
  type BenchmarkOverlayFrame,
  type BenchmarkRenderStrategy,
  type BenchmarkRendererState,
  type BenchmarkSourceProbeState,
  type BenchmarkState,
  type BenchmarkUpdateStrategy,
  type InitialBenchmarkRenderer,
} from "./benchmarkRenderer";

const sampleVideoSrc = "/media/proof.mp4";
type BenchmarkMode = "off" | BenchmarkUpdateStrategy;
type FrameTimingQuality = "insufficient" | "throttled" | "usable";
type BenchmarkSweepResult = {
  readonly cacheState: string;
  readonly frameAvgMs: number | null;
  readonly frameP95Ms: number | null;
  readonly frameP99Ms: number | null;
  readonly frameQuality: FrameTimingQuality;
  readonly frameSampleCount: number;
  readonly mode: BenchmarkMode;
  readonly presentCostMs: number | null;
  readonly renderedElementCount: number;
  readonly renderStrategy: "media-only" | BenchmarkRenderStrategy;
  readonly redrawCostMs: number;
  readonly shapeCount: number;
};
type BenchmarkSweepCase = {
  readonly mode: BenchmarkMode;
  readonly renderStrategy: BenchmarkRenderStrategy;
  readonly shapeCount: number;
};

const benchmarkSweepCounts = [500, 1500, 3000, 6000, 12000, 24000] as const;
const benchmarkSweepTrialMs = 1100;
const minimumUsableFrameSamples = 10;
const throttledFrameThresholdMs = 250;

function createBenchmarkSweepCases(): BenchmarkSweepCase[] {
  const cases: BenchmarkSweepCase[] = [
    {
      mode: "off",
      renderStrategy: "graphics",
      shapeCount: 0,
    },
  ];

  for (const renderStrategy of ["graphics", "particle-edges"] as const) {
    const modes: readonly BenchmarkUpdateStrategy[] =
      renderStrategy === "graphics"
        ? ["static", "static-cached", "redraw-each-frame"]
        : ["static", "redraw-each-frame"];

    for (const mode of modes) {
      for (const shapeCount of benchmarkSweepCounts) {
        cases.push({ mode, renderStrategy, shapeCount });
      }
    }
  }

  return cases;
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getFrameTimingQuality(benchmark: BenchmarkState): FrameTimingQuality {
  const frameDeltas = [benchmark.frameDeltaMs, benchmark.frameDeltaP95Ms];

  if (
    frameDeltas.some(
      (value) => value !== null && value >= throttledFrameThresholdMs,
    )
  ) {
    return "throttled";
  }

  if (
    benchmark.measurementSampleCount < minimumUsableFrameSamples ||
    benchmark.frameDeltaMs === null ||
    benchmark.frameDeltaP95Ms === null ||
    benchmark.frameDeltaP99Ms === null
  ) {
    return "insufficient";
  }

  return "usable";
}

function formatFrameTimingReadout(benchmark: BenchmarkState | undefined) {
  if (!benchmark) {
    return "-";
  }

  const frameQuality = getFrameTimingQuality(benchmark);
  const sampleLabel = `${benchmark.measurementSampleCount} samples`;

  if (frameQuality !== "usable") {
    return `${frameQuality} | ${sampleLabel}`;
  }

  return `${formatMs(benchmark.frameDeltaMs)} avg | ${formatMs(
    benchmark.frameDeltaP95Ms,
  )} p95 | ${formatMs(benchmark.frameDeltaP99Ms)} p99 | ${sampleLabel}`;
}

function formatSweepFrameMetric(
  frameQuality: FrameTimingQuality,
  value: number | null,
) {
  return frameQuality === "usable" ? formatMs(value) : "-";
}

const proofOverlayFrames: readonly BenchmarkOverlayFrame[] = [
  {
    mediaTime: 0,
    rects: [
      {
        height: 168,
        strokeAlpha: 0.9,
        strokeColor: 0x00ff66,
        strokeWidth: 4,
        width: 224,
        x: 88,
        y: 72,
      },
    ],
  },
  {
    mediaTime: 1.25,
    rects: [
      {
        height: 164,
        strokeAlpha: 0.9,
        strokeColor: 0x38bdf8,
        strokeWidth: 4,
        width: 224,
        x: 320,
        y: 128,
      },
    ],
  },
  {
    mediaTime: 2.5,
    rects: [
      {
        height: 180,
        strokeAlpha: 0.95,
        strokeColor: 0xfacc15,
        strokeWidth: 5,
        width: 280,
        x: 560,
        y: 240,
      },
    ],
  },
  {
    mediaTime: 3.75,
    rects: [
      {
        height: 220,
        strokeAlpha: 0.9,
        strokeColor: 0xfb7185,
        strokeWidth: 4,
        width: 360,
        x: 760,
        y: 340,
      },
    ],
  },
];

export function App() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const effectRunRef = useRef(0);
  const rendererRef = useRef<InitialBenchmarkRenderer | null>(null);
  const sweepRunRef = useRef(0);
  const [rendererState, setRendererState] =
    useState<BenchmarkRendererState | null>(null);
  const [sourceState, setSourceState] =
    useState<BenchmarkSourceProbeState | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [benchmarkMode, setBenchmarkMode] =
    useState<BenchmarkMode>("static-cached");
  const [benchmarkRenderStrategy, setBenchmarkRenderStrategy] =
    useState<BenchmarkRenderStrategy>("graphics");
  const [benchmarkShapeCount, setBenchmarkShapeCount] = useState(1200);
  const [sweepResults, setSweepResults] = useState<BenchmarkSweepResult[]>([]);
  const [sweepRunning, setSweepRunning] = useState(false);
  const [sweepStatus, setSweepStatus] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const runId = effectRunRef.current + 1;
    effectRunRef.current = runId;
    let renderer: InitialBenchmarkRenderer | undefined;
    let lastReadoutAt = 0;
    let cleanedUp = false;
    const isActive = () => !cleanedUp && effectRunRef.current === runId;

    container.replaceChildren();
    rendererRef.current = null;
    setErrorMessage(null);
    setRendererState(null);
    setSourceState(null);

    void createInitialBenchmarkRenderer({
      autoPlay: false,
      benchmark:
        benchmarkMode === "off"
          ? undefined
          : {
              renderStrategy: benchmarkRenderStrategy,
              shapeCount: benchmarkShapeCount,
              updateStrategy: benchmarkMode,
            },
      container,
      fit: "contain",
      loop: true,
      onFrame: () => {
        const now = performance.now();

        if (!isActive() || now - lastReadoutAt < 250 || !renderer) {
          return;
        }

        lastReadoutAt = now;
        setRendererState(renderer.getState());
      },
      onSource: (state) => {
        if (isActive()) {
          setSourceState(state);
        }
      },
      overlayFrames: proofOverlayFrames,
      src: sampleVideoSrc,
    })
      .then(async (createdRenderer) => {
        if (!isActive()) {
          createdRenderer.destroy();
          return;
        }

        renderer = createdRenderer;
        rendererRef.current = createdRenderer;
        setRendererState(createdRenderer.getState());
        setSourceState(createdRenderer.getState().source);

        try {
          await createdRenderer.play();
          if (isActive()) {
            setRendererState(createdRenderer.getState());
          }
        } catch (error: unknown) {
          if (isActive()) {
            setRendererState(createdRenderer.getState());
            setErrorMessage(
              error instanceof Error
                ? error.message
                : "Unable to play the initial benchmark renderer.",
            );
          }
        }
      })
      .catch((error: unknown) => {
        if (isActive()) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Unable to start the initial benchmark renderer.",
          );
        }
      });

    return () => {
      cleanedUp = true;
      if (rendererRef.current === renderer) {
        rendererRef.current = null;
      }
      renderer?.destroy();
    };
  }, [benchmarkMode, benchmarkRenderStrategy, benchmarkShapeCount]);

  const matchesSweepCase = (
    state: BenchmarkRendererState | null,
    sweepCase: BenchmarkSweepCase,
  ) => {
    if (!state || state.playbackState === "loading") {
      return false;
    }

    if (sweepCase.mode === "off") {
      return !state.benchmark.enabled;
    }

    return (
      state.benchmark.enabled &&
      state.benchmark.renderStrategy === sweepCase.renderStrategy &&
      state.benchmark.shapeCount === sweepCase.shapeCount &&
      state.benchmark.updateStrategy === sweepCase.mode
    );
  };

  const waitForSweepCase = async (
    sweepCase: BenchmarkSweepCase,
    runId: number,
  ) => {
    const startedAt = performance.now();

    while (performance.now() - startedAt < 5000) {
      if (sweepRunRef.current !== runId) {
        return null;
      }

      const renderer = rendererRef.current;
      const state = renderer?.getState() ?? null;

      if (renderer && matchesSweepCase(state, sweepCase)) {
        return renderer;
      }

      await sleep(50);
    }

    return rendererRef.current;
  };

  const captureSweepResult = (
    sweepCase: BenchmarkSweepCase,
    state: BenchmarkRendererState,
  ): BenchmarkSweepResult => {
    const benchmark = state.benchmark;
    const frameQuality = getFrameTimingQuality(benchmark);

    return {
      cacheState: benchmark.cacheEnabled
        ? benchmark.cacheApplied
          ? "applied"
          : "pending"
        : "off",
      frameAvgMs: benchmark.frameDeltaMs,
      frameP95Ms: benchmark.frameDeltaP95Ms,
      frameP99Ms: benchmark.frameDeltaP99Ms,
      frameQuality,
      frameSampleCount: benchmark.measurementSampleCount,
      mode: sweepCase.mode,
      presentCostMs: benchmark.lastPresentUpdateCostMs,
      renderedElementCount: benchmark.renderedElementCount,
      renderStrategy:
        sweepCase.mode === "off" ? "media-only" : benchmark.renderStrategy,
      redrawCostMs: benchmark.lastUpdateCostMs,
      shapeCount: benchmark.shapeCount,
    };
  };

  const runBenchmarkSweep = async () => {
    const runId = sweepRunRef.current + 1;
    sweepRunRef.current = runId;
    const sweepCases = createBenchmarkSweepCases();

    setSweepRunning(true);
    setSweepResults([]);
    setSweepStatus(`0 / ${sweepCases.length}`);

    for (const [index, sweepCase] of sweepCases.entries()) {
      if (sweepRunRef.current !== runId) {
        break;
      }

      setBenchmarkMode(sweepCase.mode);
      setBenchmarkRenderStrategy(sweepCase.renderStrategy);
      setBenchmarkShapeCount(sweepCase.shapeCount);
      setSweepStatus(`${index + 1} / ${sweepCases.length}`);

      const renderer = await waitForSweepCase(sweepCase, runId);

      if (!renderer || sweepRunRef.current !== runId) {
        break;
      }

      await sleep(benchmarkSweepTrialMs);

      const state = rendererRef.current?.getState() ?? renderer.getState();

      if (!matchesSweepCase(state, sweepCase)) {
        continue;
      }

      setSweepResults((results) => [
        ...results,
        captureSweepResult(sweepCase, state),
      ]);
    }

    if (sweepRunRef.current === runId) {
      setSweepRunning(false);
      setSweepStatus(null);
    }
  };

  const stopBenchmarkSweep = () => {
    sweepRunRef.current += 1;
    setSweepRunning(false);
    setSweepStatus(null);
  };

  return (
    <main
      style={{
        background: "#101114",
        color: "#f5f7fb",
        display: "grid",
        gridTemplateRows: "1fr auto",
        minHeight: "100vh",
      }}
    >
      <div
        ref={containerRef}
        style={{
          minHeight: 0,
          overflow: "hidden",
        }}
      />
      <aside
        style={{
          alignItems: "center",
          background: "#1a1d23",
          borderTop: "1px solid #2c3038",
          display: "flex",
          flexWrap: "wrap",
          gap: 16,
          minHeight: 48,
          padding: "8px 12px",
        }}
      >
        <Readout label="State" value={rendererState?.playbackState ?? "-"} />
        <Readout
          label="Frames"
          value={String(rendererState?.presentedFrames ?? "-")}
        />
        <Readout
          label="Time"
          value={
            rendererState ? `${rendererState.currentTime.toFixed(2)}s` : "-"
          }
        />
        <Readout
          label="Overlay"
          value={
            rendererState
              ? rendererState.activeOverlayFrameTime === null
                ? `none | ${rendererState.activeOverlayRectCount} rects`
                : `${rendererState.activeOverlayFrameTime.toFixed(2)}s | ${rendererState.activeOverlayRectCount} rects`
              : "-"
          }
        />
        <Readout
          label="Shapes"
          value={
            rendererState?.benchmark.enabled
              ? `${rendererState.benchmark.shapeCount} | ${rendererState.benchmark.updateStrategy}`
              : "off"
          }
        />
        <Readout
          label="Strategy"
          value={
            rendererState?.benchmark.enabled
              ? rendererState.benchmark.renderStrategy
              : "media-only"
          }
        />
        <Readout
          label="Elements"
          value={String(rendererState?.benchmark.renderedElementCount ?? 0)}
        />
        <label
          style={{
            alignItems: "center",
            display: "inline-flex",
            gap: 6,
            lineHeight: 1.4,
            whiteSpace: "nowrap",
          }}
        >
          <strong style={{ color: "#9ca3af", fontWeight: 600 }}>Mode</strong>
          <select
            onChange={(event) =>
              setBenchmarkMode(event.target.value as BenchmarkMode)
            }
            style={{
              background: "#111318",
              border: "1px solid #343a46",
              color: "#f5f7fb",
              padding: "4px 6px",
            }}
            value={benchmarkMode}
          >
            <option value="off">media-only</option>
            <option value="static">static</option>
            <option value="static-cached">static-cached</option>
            <option value="redraw-each-frame">redraw-each-frame</option>
          </select>
        </label>
        <label
          style={{
            alignItems: "center",
            display: "inline-flex",
            gap: 6,
            lineHeight: 1.4,
            whiteSpace: "nowrap",
          }}
        >
          <strong style={{ color: "#9ca3af", fontWeight: 600 }}>
            Strategy
          </strong>
          <select
            onChange={(event) =>
              setBenchmarkRenderStrategy(
                event.target.value as BenchmarkRenderStrategy,
              )
            }
            style={{
              background: "#111318",
              border: "1px solid #343a46",
              color: "#f5f7fb",
              padding: "4px 6px",
            }}
            value={benchmarkRenderStrategy}
          >
            <option value="graphics">graphics</option>
            <option value="particle-edges">particle-edges</option>
          </select>
        </label>
        <label
          style={{
            alignItems: "center",
            display: "inline-flex",
            gap: 6,
            lineHeight: 1.4,
            whiteSpace: "nowrap",
          }}
        >
          <strong style={{ color: "#9ca3af", fontWeight: 600 }}>Count</strong>
          <input
            min={0}
            onChange={(event) =>
              setBenchmarkShapeCount(
                Math.max(0, Math.floor(event.target.valueAsNumber || 0)),
              )
            }
            step={100}
            style={{
              background: "#111318",
              border: "1px solid #343a46",
              color: "#f5f7fb",
              padding: "4px 6px",
              width: 88,
            }}
            type="number"
            value={benchmarkShapeCount}
          />
        </label>
        <Readout
          label="Frame"
          value={formatFrameTimingReadout(rendererState?.benchmark)}
        />
        <Readout
          label="Sample"
          value={formatMs(rendererState?.benchmark.lastSampleRequestCostMs)}
        />
        <Readout
          label="Media draw"
          value={formatMs(rendererState?.benchmark.lastMediaDrawCostMs)}
        />
        <Readout
          label="Upload"
          value={formatMs(rendererState?.benchmark.lastTextureUploadCostMs)}
        />
        <Readout
          label="Present"
          value={formatMs(rendererState?.benchmark.lastPresentUpdateCostMs)}
        />
        <Readout
          label="Shape redraw"
          value={
            rendererState
              ? `${formatMs(rendererState.benchmark.lastUpdateCostMs, 2)} | text off`
              : "-"
          }
        />
        <Readout
          label="Cache"
          value={
            rendererState?.benchmark.enabled
              ? rendererState.benchmark.cacheEnabled
                ? rendererState.benchmark.cacheApplied
                  ? "enabled | applied"
                  : "enabled | pending"
                : "off"
              : "off"
          }
        />
        <button
          disabled={sweepRunning}
          onClick={() => {
            void runBenchmarkSweep();
          }}
          style={{
            background: sweepRunning ? "#2c3038" : "#2563eb",
            border: "1px solid #3b82f6",
            color: "#f5f7fb",
            cursor: sweepRunning ? "default" : "pointer",
            padding: "5px 10px",
          }}
          type="button"
        >
          Sweep
        </button>
        {sweepRunning ? (
          <button
            onClick={stopBenchmarkSweep}
            style={{
              background: "#111318",
              border: "1px solid #4b5563",
              color: "#f5f7fb",
              cursor: "pointer",
              padding: "5px 10px",
            }}
            type="button"
          >
            Stop
          </button>
        ) : null}
        {sweepStatus ? <Readout label="Sweep" value={sweepStatus} /> : null}
        <Readout
          label="Size"
          value={
            rendererState?.mediaWidth && rendererState.mediaHeight
              ? `${rendererState.mediaWidth} x ${rendererState.mediaHeight}`
              : "-"
          }
        />
        <Readout
          label="Source"
          value={
            sourceState
              ? [
                  sourceState.status,
                  sourceState.formatName,
                  sourceState.duration === null
                    ? null
                    : `${sourceState.duration.toFixed(2)}s`,
                  sourceState.primaryVideoWidth &&
                  sourceState.primaryVideoHeight
                    ? `${sourceState.primaryVideoWidth} x ${sourceState.primaryVideoHeight}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" | ")
              : "-"
          }
        />
        <Readout label="Audio" value="video-only" />
        {errorMessage ? <Readout label="Error" value={errorMessage} /> : null}
        {!errorMessage && rendererState?.playbackState === "error" ? (
          <Readout
            label="Error"
            value={
              rendererState.source.errorMessage ??
              "Unable to decode media with Mediabunny."
            }
          />
        ) : null}
        <SweepResults results={sweepResults} />
      </aside>
    </main>
  );
}

function formatMs(value: number | null | undefined, digits = 1) {
  return value === null || value === undefined
    ? "-"
    : `${value.toFixed(digits)}ms`;
}

function SweepResults({
  results,
}: {
  results: readonly BenchmarkSweepResult[];
}) {
  if (results.length === 0) {
    return null;
  }

  return (
    <div
      style={{
        flexBasis: "100%",
        overflowX: "auto",
      }}
    >
      <table
        style={{
          borderCollapse: "collapse",
          color: "#f5f7fb",
          fontSize: 12,
          minWidth: 1120,
          width: "100%",
        }}
      >
        <thead>
          <tr>
            <SweepHeader>Mode</SweepHeader>
            <SweepHeader>Strategy</SweepHeader>
            <SweepHeader>Count</SweepHeader>
            <SweepHeader>Elements</SweepHeader>
            <SweepHeader>Frame quality</SweepHeader>
            <SweepHeader>Frame samples</SweepHeader>
            <SweepHeader>Frame avg</SweepHeader>
            <SweepHeader>p95</SweepHeader>
            <SweepHeader>p99</SweepHeader>
            <SweepHeader>Redraw</SweepHeader>
            <SweepHeader>Present</SweepHeader>
            <SweepHeader>Cache</SweepHeader>
          </tr>
        </thead>
        <tbody>
          {results.map((result, index) => (
            <tr
              key={`${result.mode}-${result.renderStrategy}-${result.shapeCount}-${index}`}
            >
              <SweepCell>{result.mode}</SweepCell>
              <SweepCell>{result.renderStrategy}</SweepCell>
              <SweepCell>{String(result.shapeCount)}</SweepCell>
              <SweepCell>{String(result.renderedElementCount)}</SweepCell>
              <SweepCell>{result.frameQuality}</SweepCell>
              <SweepCell>{String(result.frameSampleCount)}</SweepCell>
              <SweepCell>
                {formatSweepFrameMetric(result.frameQuality, result.frameAvgMs)}
              </SweepCell>
              <SweepCell>
                {formatSweepFrameMetric(result.frameQuality, result.frameP95Ms)}
              </SweepCell>
              <SweepCell>
                {formatSweepFrameMetric(result.frameQuality, result.frameP99Ms)}
              </SweepCell>
              <SweepCell>{formatMs(result.redrawCostMs, 2)}</SweepCell>
              <SweepCell>{formatMs(result.presentCostMs, 2)}</SweepCell>
              <SweepCell>{result.cacheState}</SweepCell>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SweepHeader({ children }: { children: string }) {
  return (
    <th
      style={{
        borderBottom: "1px solid #343a46",
        color: "#9ca3af",
        fontWeight: 600,
        padding: "6px 8px",
        textAlign: "left",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </th>
  );
}

function SweepCell({ children }: { children: string }) {
  return (
    <td
      style={{
        borderBottom: "1px solid #242832",
        padding: "6px 8px",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </td>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        gap: 6,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
      }}
    >
      <strong style={{ color: "#9ca3af", fontWeight: 600 }}>{label}</strong>
      <span>{value}</span>
    </span>
  );
}
