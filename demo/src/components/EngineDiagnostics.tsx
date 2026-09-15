import {
  memo,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import {
  DIAGNOSTICS,
  TRACE_RING_BOUNDS,
  type DiagnosticsSnapshot,
  type Warning,
} from "supervision/web-video-engine";
import type { EngineDiagnosticsTap } from "../diagnostics/engine-diagnostics-tap";
import {
  engineMetricGroups,
  formatInt,
  type MetricDescriptor,
  type MetricStatus,
} from "../diagnostics/engine-metrics";
import { DiagnosticLabel } from "./DiagnosticLabel";
import { EngineDiagnosticsTimeline } from "./EngineDiagnosticsTimeline";

/**
 * The web video engine's own diagnostics, rendered the way the engine renders
 * them: the worker's diagnoses first, the decode-to-screen ledger, then the same
 * eight metric groups under the same names, then the same coverage lanes.
 *
 * The point is comparison. Open the FrameSampler storybook beside this demo and
 * every reading here has a namesake there, so decode, cache, GOP and present can
 * be checked against each other instead of felt.
 */
export const EngineDiagnostics = memo(function EngineDiagnostics({
  tap,
}: {
  readonly tap: EngineDiagnosticsTap;
}) {
  const [live, setLive] = useState(false);
  const [readings, setReadings] = useState(0);
  const readOnce = useCallback(() => {
    setReadings((count) => count + 1);
  }, []);
  const attached = useEngineAttachment(tap);
  const snapshot = useEngineDiagnostics(tap, live, readings);

  return (
    <section className="engine-panel" aria-label="Web video engine diagnostics">
      <header className="engine-panel__header">
        <h2 className="engine-panel__title">Web video engine</h2>
        <span className="engine-panel__rate">
          {readCadence(live, snapshot)}
        </span>
        <EngineTraceRecorder attached={attached} tap={tap} />
      </header>

      <EngineReadingControl
        attached={attached}
        live={live}
        onReadOnce={readOnce}
        onSetLive={setLive}
      />

      {snapshot === null ? (
        <p className="engine-panel__empty">
          {attached
            ? "Nothing read yet. The engine assembles no diagnostics about itself until something asks it to."
            : "No web video engine source is open on this path, so there is nothing to read."}
        </p>
      ) : (
        <>
          <EngineWarnings warnings={snapshot.warnings} />
          <PipelineLedger snapshot={snapshot} />
          {engineMetricGroups.map((group) => (
            <section className="engine-panel__group" key={group.title}>
              <h3 className="engine-panel__group-title">{group.title}</h3>
              <div className="engine-panel__metrics">
                {layOutMetrics(group.metrics).map(({ metric, rightColumn }) => (
                  <EngineMetric
                    key={metric.label}
                    metric={metric}
                    rightColumn={rightColumn}
                    snapshot={snapshot}
                  />
                ))}
              </div>
            </section>
          ))}
          <section className="engine-panel__group">
            <h3 className="engine-panel__group-title">Coverage</h3>
            <EngineDiagnosticsTimeline live={live} snapshot={snapshot} />
          </section>
        </>
      )}
    </section>
  );
});

/**
 * What the panel is doing, in the place that carries the broadcast rate: live
 * readings name their rate, a single reading names itself as held, so a figure
 * standing still is never mistaken for a runtime standing still.
 */
function readCadence(live: boolean, snapshot: DiagnosticsSnapshot | null) {
  if (snapshot === null) {
    return "not reading";
  }

  return live
    ? `${snapshot.status} · ${DIAGNOSTICS.BROADCAST_HZ}Hz`
    : `${snapshot.status} · held`;
}

/**
 * Asking the engine about itself is what makes it broadcast, count every frame
 * and walk the whole file for its keyframes, so the panel asks only when told
 * to. One reading is enough to see every figure below; the switch is for
 * watching one of them move.
 */
const EngineReadingControl = memo(function EngineReadingControl({
  attached,
  live,
  onReadOnce,
  onSetLive,
}: {
  readonly attached: boolean;
  readonly live: boolean;
  readonly onReadOnce: () => void;
  readonly onSetLive: (live: boolean) => void;
}) {
  return (
    <div className="engine-panel__live">
      <DiagnosticLabel
        label="Engine readings"
        tooltip="The engine reports nothing about what it is holding unless it is asked to, and asking makes the worker broadcast ten times a second, count every frame and walk the whole file for keyframes for as long as it is asked. Read once takes a single reading and stops; the panel holds it until something asks again."
      />
      <button
        className="engine-panel__button"
        disabled={!attached || live}
        onClick={onReadOnce}
        title={
          live
            ? "Already reading while it runs"
            : "Take one reading and stop again"
        }
        type="button"
      >
        read once
      </button>
      <label className="engine-panel__switch">
        <input
          checked={live}
          onChange={(event) => {
            onSetLive(event.currentTarget.checked);
          }}
          type="checkbox"
        />
        <span>Read while it runs</span>
      </label>
    </div>
  );
});

/**
 * The trace recorder, so a capture taken here is the same JSON the engine's own
 * panel exports and the two can be diffed offline. Arming allocates the worker's
 * rolling rings; the capture stays downloadable after it stops, which is what
 * makes record, reproduce, stop, download work.
 */
function EngineTraceRecorder({
  attached,
  tap,
}: {
  readonly attached: boolean;
  readonly tap: EngineDiagnosticsTap;
}) {
  const [armed, setArmed] = useState(false);
  const [hasCapture, setHasCapture] = useState(false);
  const windowSeconds = Math.round(TRACE_RING_BOUNDS.snapshotWindowMs / 1000);

  const toggleArm = () => {
    if (armed) {
      tap.disarmTrace();
      setArmed(false);
      setHasCapture(true);
      return;
    }

    tap.armTrace();
    setHasCapture(false);
    setArmed(true);
  };

  const download = async () => {
    const trace = await tap.exportTrace();

    if (trace === null) {
      return;
    }

    const url = URL.createObjectURL(
      new Blob([JSON.stringify(trace, null, 2)], { type: "application/json" }),
    );

    try {
      const anchor = document.createElement("a");
      anchor.download = `video-trace-${Date.now()}.json`;
      anchor.href = url;
      anchor.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  return (
    <span className="engine-recorder">
      <button
        aria-label={armed ? "Disarm trace recorder" : "Arm trace recorder"}
        aria-pressed={armed}
        className={`engine-panel__button${armed ? " engine-panel__button--armed" : ""}`}
        disabled={!attached}
        onClick={toggleArm}
        title={`Trace recorder: the rings keep the last ${windowSeconds}s`}
        type="button"
      >
        rec
      </button>
      <button
        className="engine-panel__button"
        disabled={!attached || (!armed && !hasCapture)}
        onClick={() => {
          void download();
        }}
        title="Export the captured trace as JSON"
        type="button"
      >
        json
      </button>
    </span>
  );
}

/**
 * Walks the two-column flow the grid will produce, so each label knows which
 * half of the panel it lands in and can open its tooltip inward from that edge.
 * A wide metric takes the whole row, which is why the column cannot be read off
 * the index.
 */
function layOutMetrics(
  metrics: readonly MetricDescriptor[],
): readonly { metric: MetricDescriptor; rightColumn: boolean }[] {
  let column = 0;

  return metrics.map((metric) => {
    if (metric.wide) {
      column = 0;
      return { metric, rightColumn: false };
    }

    const rightColumn = column === 1;
    column = column === 1 ? 0 : 1;

    return { metric, rightColumn };
  });
}

/**
 * The decode-to-screen ledger as one row: frames decoded, handed out, dropped,
 * and decodes per presented frame. One row because they read as one fact, what
 * it cost to put the visible frames on screen. No verdict colours: a sane
 * per-frame cost is clip-dependent and unbaselined.
 */
function PipelineLedger({
  snapshot,
}: {
  readonly snapshot: DiagnosticsSnapshot;
}) {
  const { decodedFrames, droppedFrames, paintedFrames } = snapshot.pipeline;
  const perPaint =
    decodedFrames !== null && paintedFrames > 0
      ? `${(decodedFrames / paintedFrames).toFixed(1)}:1`
      : "n/a";

  return (
    <div className="engine-ledger">
      <EngineLedgerCell label="decoded" value={formatInt(decodedFrames)} />
      <EngineLedgerCell label="painted" value={formatInt(paintedFrames)} />
      <EngineLedgerCell label="dropped" value={formatInt(droppedFrames)} />
      <EngineLedgerCell label="per paint" value={perPaint} />
    </div>
  );
}

function EngineLedgerCell({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <span className="engine-ledger__cell">
      <span className="engine-ledger__label">{label}</span>
      <span className="engine-ledger__value">{value}</span>
    </span>
  );
}

/**
 * The worker's own diagnoses, severity first, each collapsed to its title. The
 * scenario, the fix and the numbers that tripped the rule are one click away, so
 * the strip stays dense and a healthy runtime reads as healthy rather than
 * empty.
 */
function EngineWarnings({
  warnings,
}: {
  readonly warnings: readonly Warning[];
}) {
  if (warnings.length === 0) {
    return (
      <p className="engine-warning engine-warning--healthy">
        Runtime healthy. No warnings.
      </p>
    );
  }

  return (
    <div className="engine-warnings">
      {warnings.map((warning) => (
        <EngineWarningRow key={warning.id} warning={warning} />
      ))}
    </div>
  );
}

function EngineWarningRow({ warning }: { readonly warning: Warning }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={`engine-warning engine-warning--${warning.severity}`}>
      <button
        aria-expanded={open}
        className="engine-warning__summary"
        onClick={() => {
          setOpen((current) => !current);
        }}
        type="button"
      >
        <span aria-hidden="true" className="engine-warning__dot" />
        <span className="engine-warning__title">{warning.title}</span>
        <span className="engine-warning__severity">{warning.severity}</span>
      </button>
      {open ? (
        <div className="engine-warning__detail">
          <p>{warning.scenario}</p>
          <p>
            <strong>Fix:</strong> {warning.advice}
          </p>
          <p className="engine-warning__evidence">{warning.evidence}</p>
        </div>
      ) : null}
    </div>
  );
}

function EngineMetric({
  metric,
  rightColumn,
  snapshot,
}: {
  readonly metric: MetricDescriptor;
  readonly rightColumn: boolean;
  readonly snapshot: DiagnosticsSnapshot;
}) {
  const status: MetricStatus = metric.status?.(snapshot) ?? "neutral";

  return (
    <span
      className={`engine-metric${metric.wide ? " engine-metric--wide" : ""}`}
    >
      <DiagnosticLabel
        align={rightColumn ? "end" : "start"}
        label={metric.label}
        tooltip={metric.tooltip}
      />
      <span className="engine-metric__reading">
        <span className="engine-metric__value">{metric.value(snapshot)}</span>
        <span
          aria-hidden="true"
          className={`engine-metric__dot engine-metric__dot--${status}`}
        />
      </span>
    </span>
  );
}

/**
 * Whether an engine source is open at all, which is what the trace recorder
 * answers to: a path with no engine on it has nothing to record, and one that
 * nobody is reading still does.
 */
function useEngineAttachment(tap: EngineDiagnosticsTap) {
  const subscribe = useCallback(
    (listener: () => void) => tap.subscribe(listener),
    [tap],
  );
  const attached = useCallback(() => tap.attached(), [tap]);

  return useSyncExternalStore(subscribe, attached, attached);
}

/**
 * Holds the broadcast open for as long as the panel is asked to read and the
 * tab is visible, and re-reads on every push. The engine assembles nothing
 * while nobody is subscribed, so a Debug tab nobody has asked costs the worker
 * nothing.
 *
 * A single reading holds it open only until the first push lands, and what it
 * left behind is kept here, so the panel goes on showing every figure it read
 * while the worker goes back to silence. Keeping it here rather than reading
 * the engine back is also what makes "held" true: another surface asking for
 * the same broadcast cannot quietly animate a panel that stopped asking.
 */
function useEngineDiagnostics(
  tap: EngineDiagnosticsTap,
  live: boolean,
  readings: number,
) {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || !document.hidden,
  );
  const [held, setHeld] = useState(() => tap.read());

  useEffect(() => {
    const onVisibilityChange = () => {
      setVisible(!document.hidden);
    };

    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (!live || !visible) {
      return undefined;
    }

    const stop = tap.start();

    return () => {
      setHeld(tap.read());
      stop();
    };
  }, [live, tap, visible]);

  useEffect(() => {
    if (readings === 0 || live) {
      return undefined;
    }

    return tap.readOnce(setHeld);
  }, [live, readings, tap]);

  const subscribe = useCallback(
    (listener: () => void) => (live ? tap.subscribe(listener) : () => {}),
    [live, tap],
  );
  const read = useCallback(() => (live ? tap.read() : null), [live, tap]);
  const broadcast = useSyncExternalStore(subscribe, read, read);

  return broadcast ?? held;
}
