import type { ReactNode } from "react";

export function DemoShell({
  controlBar,
  renderControls,
  sourceControls,
  statusPanel,
  viewport,
}: {
  readonly controlBar: ReactNode;
  readonly renderControls: ReactNode;
  readonly sourceControls: ReactNode;
  readonly statusPanel: ReactNode;
  readonly viewport: ReactNode;
}) {
  return (
    <main className="demo-shell">
      <div className="demo-shell__viewport">{viewport}</div>
      <aside className="demo-shell__panel" aria-label="Demo controls">
        {sourceControls}
        {controlBar}
        {renderControls}
        {statusPanel}
      </aside>
    </main>
  );
}
