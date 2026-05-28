import type { ReactNode } from "react";

export function DemoShell({
  controlBar,
  statusPanel,
  viewport,
}: {
  readonly controlBar: ReactNode;
  readonly statusPanel: ReactNode;
  readonly viewport: ReactNode;
}) {
  return (
    <main className="demo-shell">
      <div className="demo-shell__viewport">{viewport}</div>
      <aside className="demo-shell__panel" aria-label="Demo controls">
        {controlBar}
        {statusPanel}
      </aside>
    </main>
  );
}
