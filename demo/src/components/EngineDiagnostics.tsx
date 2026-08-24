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
} from "supervision-js-video-engine";
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
 * The video engine's own diagnostics, rendered the way the engine renders them:
 * the worker's diagnoses first, the decode-to-screen ledger, then the same eight
 * metric groups under the same names, then the same coverage lanes.
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
  const snapshot = useEngineDiagnostics(tap);

  return (
    <section className="engine-panel" aria-label="Video engine diagnostics">
      <header className="engine-panel__header">
        <h2 className="engine-panel__title">Video Engine</h2>
        <span className="engine-panel__rate">
          {snapshot?.status ?? "idle"} · {DIAGNOSTICS.BROADCAST_HZ}Hz
        </span>
        <EngineTraceRecorder attached={snapshot !== null} tap={tap} />
      </header>

      {snapshot === null ? (
        <p className="engine-panel__empty">
          waiting for the first broadcast from the engine worker
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
            <EngineDiagnosticsTimeline snapshot={snapshot} />
          </section>
        </>
      )}
    </section>
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
        className={`engine-recorder__button${armed ? " engine-recorder__button--armed" : ""}`}
        disabled={!attached}
        onClick={toggleArm}
        title={`Trace recorder: the rings keep the last ${windowSeconds}s`}
        type="button"
      >
        rec
      </button>
      <button
        className="engine-recorder__button"
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
 * Holds the broadcast open for as long as the panel is mounted and the tab is
 * visible, and re-reads on every push. The engine assembles nothing while
 * nobody is subscribed, so a closed Debug tab costs the worker nothing.
 */
function useEngineDiagnostics(tap: EngineDiagnosticsTap) {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || !document.hidden,
  );

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
    if (!visible) {
      return undefined;
    }

    return tap.start();
  }, [tap, visible]);

  const subscribe = useCallback(
    (listener: () => void) => tap.subscribe(listener),
    [tap],
  );
  const read = useCallback(() => tap.read(), [tap]);

  return useSyncExternalStore(subscribe, read, read);
}
