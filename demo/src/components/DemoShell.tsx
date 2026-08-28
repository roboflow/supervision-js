import type { ReactNode } from "react";
import { DemoEvalHook, inspectorTabEvalHook } from "../eval-hooks";
import { DemoInspectorTab } from "../session/inspector-tabs";
import { DemoViewMode } from "../session/demo-view-mode";

const tabLabels: Record<DemoInspectorTab, string> = {
  [DemoInspectorTab.Clip]: "Clip",
  [DemoInspectorTab.Diagnostics]: "Diagnose",
  [DemoInspectorTab.Session]: "Session",
  [DemoInspectorTab.Style]: "Style",
};

const tabOrder: readonly DemoInspectorTab[] = [
  DemoInspectorTab.Clip,
  DemoInspectorTab.Style,
  DemoInspectorTab.Session,
  DemoInspectorTab.Diagnostics,
];

export function DemoShell({
  benchmarksPanel,
  controlBar,
  departureCount,
  docsUrl,
  libraryDeparturesPanel,
  mediaPathPanel,
  mode,
  onModeChange,
  onTabChange,
  performanceStrip,
  pipelinePanel,
  presentationDiagnostics,
  qualityControls,
  renderControls,
  selectionPanel,
  sessionOptionsPanel,
  slowWorkPanel,
  sourceControls,
  statusPanel,
  tab,
  viewport,
}: {
  readonly benchmarksPanel: ReactNode;
  readonly controlBar: ReactNode;
  /** How many settings differ from the library, for the Session tab's badge. */
  readonly departureCount: number | null;
  readonly docsUrl: string;
  readonly libraryDeparturesPanel: ReactNode;
  readonly mediaPathPanel: ReactNode;
  readonly mode: DemoViewMode;
  readonly onModeChange: (mode: DemoViewMode) => void;
  readonly onTabChange: (tab: DemoInspectorTab) => void;
  readonly performanceStrip: ReactNode;
  readonly pipelinePanel: ReactNode;
  readonly presentationDiagnostics: ReactNode;
  readonly qualityControls: ReactNode;
  readonly renderControls: ReactNode;
  readonly selectionPanel: ReactNode;
  readonly sessionOptionsPanel: ReactNode;
  readonly slowWorkPanel: ReactNode;
  readonly sourceControls: ReactNode;
  readonly statusPanel: ReactNode;
  readonly tab: DemoInspectorTab;
  readonly viewport: ReactNode;
}) {
  const shellClassName = ["demo-shell", `demo-shell--${mode}`].join(" ");
  const isBenchmarksMode = mode === DemoViewMode.Benchmarks;
  const diagnosing = mode === DemoViewMode.Debug;

  return (
    <main className={shellClassName} data-eval={DemoEvalHook.Shell}>
      <header className="demo-shell__header">
        <div className="demo-shell__brand">
          <div className="demo-shell__mark" aria-hidden="true">
            <img
              alt=""
              src={`${import.meta.env.BASE_URL}roboflow-logomark.svg`}
            />
          </div>
          <div className="demo-shell__title">
            <span className="demo-shell__eyebrow">Roboflow / supervision</span>
            <strong>supervision-js</strong>
            <span>CV media rendering workbench</span>
          </div>
        </div>
        <div className="demo-shell__mode" role="tablist">
          <a href={docsUrl} rel="noreferrer" target="_blank">
            Docs
          </a>
          <button
            aria-pressed={mode === DemoViewMode.Benchmarks}
            data-eval={DemoEvalHook.BenchmarksView}
            onClick={() => onModeChange(DemoViewMode.Benchmarks)}
            type="button"
          >
            Benchmarks
          </button>
          <button
            aria-pressed={mode === DemoViewMode.Demo}
            data-eval={DemoEvalHook.DemoView}
            onClick={() => onModeChange(DemoViewMode.Demo)}
            type="button"
          >
            Demo
          </button>
          <button
            aria-pressed={mode === DemoViewMode.Debug}
            data-eval={DemoEvalHook.DebugView}
            onClick={() => onModeChange(DemoViewMode.Debug)}
            type="button"
          >
            Debug
          </button>
        </div>
      </header>

      {isBenchmarksMode ? (
        <section className="demo-shell__benchmarks" aria-label="Benchmarks">
          {benchmarksPanel}
        </section>
      ) : (
        <div className="demo-shell__workspace">
          <aside className="demo-shell__inspector" aria-label="Demo controls">
            <nav className="inspector-tabs" aria-label="Control groups">
              {tabOrder.map((entry) => (
                <button
                  aria-pressed={entry === tab}
                  data-eval={inspectorTabEvalHook(entry)}
                  key={entry}
                  onClick={() => onTabChange(entry)}
                  type="button"
                >
                  {tabLabels[entry]}
                  {entry === DemoInspectorTab.Session &&
                  departureCount !== null &&
                  departureCount > 0 ? (
                    <span className="inspector-tabs__badge">
                      {departureCount}
                    </span>
                  ) : null}
                </button>
              ))}
            </nav>

            <div className="demo-shell__panels">
              {tab === DemoInspectorTab.Clip ? (
                <>
                  {sourceControls}
                  {selectionPanel}
                </>
              ) : null}

              {tab === DemoInspectorTab.Style ? (
                <>
                  {renderControls}
                  {qualityControls}
                </>
              ) : null}

              {tab === DemoInspectorTab.Session ? (
                <>
                  {mediaPathPanel}
                  {libraryDeparturesPanel}
                  {sessionOptionsPanel}
                </>
              ) : null}

              {tab === DemoInspectorTab.Diagnostics ? (
                <>
                  {diagnosing ? null : (
                    <DiagnosticsOff
                      onTurnOn={() => onModeChange(DemoViewMode.Debug)}
                    />
                  )}
                  {diagnosing ? (
                    <>
                      {pipelinePanel}
                      {performanceStrip}
                      {presentationDiagnostics}
                      {statusPanel}
                      {slowWorkPanel}
                    </>
                  ) : null}
                </>
              ) : null}
            </div>
          </aside>
          <section className="demo-shell__stage" aria-label="Renderer stage">
            <div className="demo-shell__viewport">{viewport}</div>
            {controlBar}
          </section>
        </div>
      )}
    </main>
  );
}

/**
 * Timing every layer of every present costs about ten points of process CPU on
 * a 120Hz display, and a reading nobody is looking at is a reading nobody
 * should pay for. The switch says what it turns on, so the column is never
 * empty and silent.
 */
function DiagnosticsOff({ onTurnOn }: { readonly onTurnOn: () => void }) {
  return (
    <section className="session-options" aria-label="Diagnostics">
      <header className="inspector-card__header">
        <h2>Diagnostics are off</h2>
        <button onClick={onTurnOn} type="button">
          Turn on
        </button>
      </header>
      <p className="session-options__hint">
        The pipeline path, the presented-frame ledger, the renderer&rsquo;s own
        state and the web video engine&rsquo;s readings all live here, and this
        shows them. Timing every layer of every frame costs about ten points of
        CPU on a 120Hz display, so those figures start with the next clip that
        opens rather than on the clip already running.
      </p>
    </section>
  );
}
