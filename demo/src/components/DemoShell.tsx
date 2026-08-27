import type { ReactNode } from "react";
import { DemoEvalHook } from "../eval-hooks";
import { DemoViewMode } from "../session/demo-view-mode";

export function DemoShell({
  benchmarksPanel,
  controlBar,
  docsUrl,
  mode,
  onModeChange,
  performanceStrip,
  presentationDiagnostics,
  qualityControls,
  renderControls,
  selectionPanel,
  sessionOptionsPanel,
  sourceControls,
  statusPanel,
  viewport,
}: {
  readonly benchmarksPanel: ReactNode;
  readonly controlBar: ReactNode;
  readonly docsUrl: string;
  readonly mode: DemoViewMode;
  readonly onModeChange: (mode: DemoViewMode) => void;
  readonly performanceStrip: ReactNode;
  readonly presentationDiagnostics: ReactNode;
  readonly qualityControls: ReactNode;
  readonly renderControls: ReactNode;
  readonly selectionPanel: ReactNode;
  readonly sessionOptionsPanel: ReactNode;
  readonly sourceControls: ReactNode;
  readonly statusPanel: ReactNode;
  readonly viewport: ReactNode;
}) {
  const shellClassName = ["demo-shell", `demo-shell--${mode}`].join(" ");
  const isBenchmarksMode = mode === DemoViewMode.Benchmarks;

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
            {sourceControls}
            {qualityControls}
            {sessionOptionsPanel}
            {selectionPanel}
            {renderControls}
            {mode === DemoViewMode.Debug ? performanceStrip : null}
            {mode === DemoViewMode.Debug ? presentationDiagnostics : null}
            {mode === DemoViewMode.Debug ? statusPanel : null}
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
