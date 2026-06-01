import type { ReactNode } from "react";
import { DemoViewMode } from "../session/demo-view-mode";

export function DemoShell({
  controlBar,
  mode,
  onModeChange,
  performanceStrip,
  renderControls,
  sourceControls,
  statusPanel,
  viewport,
}: {
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

  return (
    <main className={shellClassName}>
      <div className="demo-shell__viewport">{viewport}</div>
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
          <div className="demo-shell__mode" role="tablist">
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
        {sourceControls}
        {controlBar}
        {performanceStrip}
        {renderControls}
        {mode === DemoViewMode.Debug ? statusPanel : null}
      </aside>
    </main>
  );
}
