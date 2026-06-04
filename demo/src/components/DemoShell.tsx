import type { ReactNode } from "react";
import { DemoViewMode } from "../session/demo-view-mode";

export function DemoShell({
  benchmarksPanel,
  controlBar,
  mode,
  onModeChange,
  performanceStrip,
  renderControls,
  sourceControls,
  statusPanel,
  viewport,
}: {
  readonly benchmarksPanel: ReactNode;
  readonly controlBar: ReactNode;
  readonly mode: DemoViewMode;
  readonly onModeChange: (mode: DemoViewMode) => void;
  readonly performanceStrip: ReactNode;
  readonly renderControls: ReactNode;
  readonly sourceControls: ReactNode;
  readonly statusPanel: ReactNode;
  readonly viewport: ReactNode;
}) {
  const shellClassName = ["demo-shell", `demo-shell--${mode}`].join(" ");
  const isBenchmarksMode = mode === DemoViewMode.Benchmarks;

  return (
    <main className={shellClassName}>
      <div
        aria-hidden={isBenchmarksMode}
        className={[
          "demo-shell__viewport",
          isBenchmarksMode ? "demo-shell__viewport--hidden" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {viewport}
      </div>
      <aside className="demo-shell__panel" aria-label="Demo controls">
        <div className="demo-shell__header">
          <div className="demo-shell__brand">
            <div className="demo-shell__mark" aria-hidden="true">
              <span />
            </div>
            <div className="demo-shell__title">
              <strong>supervision-js</strong>
              <span>CV media rendering workbench</span>
            </div>
          </div>
          {isBenchmarksMode ? null : sourceControls}
          <div className="demo-shell__mode" role="tablist">
            <button
              aria-pressed={mode === DemoViewMode.Benchmarks}
              onClick={() => onModeChange(DemoViewMode.Benchmarks)}
              type="button"
            >
              Benchmarks
            </button>
            <button
              aria-pressed={mode === DemoViewMode.Demo}
              onClick={() => onModeChange(DemoViewMode.Demo)}
              type="button"
            >
              Demo
            </button>
            <button
              aria-pressed={mode === DemoViewMode.Debug}
              onClick={() => onModeChange(DemoViewMode.Debug)}
              type="button"
            >
              Debug
            </button>
          </div>
        </div>
        {isBenchmarksMode ? (
          benchmarksPanel
        ) : (
          <>
            {controlBar}
            {performanceStrip}
            {renderControls}
            {mode === DemoViewMode.Debug ? statusPanel : null}
          </>
        )}
      </aside>
    </main>
  );
}
