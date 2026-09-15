import { memo, useState } from "react";

import type { DemoLibraryDeparture } from "../session/library-defaults";

export const LibraryDeparturesPanel = memo(function LibraryDeparturesPanel({
  departures,
}: {
  readonly departures: readonly DemoLibraryDeparture[] | null;
}) {
  const [open, setOpen] = useState(false);

  return (
    <section className="session-options" aria-label="Differs from the library">
      <header className="inspector-card__header">
        <button
          aria-expanded={open}
          className="pipeline-panel__toggle"
          disabled={departures === null || departures.length === 0}
          onClick={() => setOpen((current) => !current)}
          type="button"
        >
          <h2>Differs from the library</h2>
          <span aria-hidden="true" className="pipeline-panel__chevron" />
        </button>
      </header>
      <p className="session-options__hint">{summarize(departures)}</p>
      {open && departures !== null ? (
        <dl className="library-departures">
          {departures.map((departure) => (
            <div className="library-departure" key={departure.setting}>
              <dt>{departure.setting}</dt>
              <dd>
                <span className="library-departure__values">
                  <span className="library-departure__value">
                    {departure.value}
                  </span>
                  <span className="library-departure__library">
                    library: {departure.library}
                  </span>
                </span>
                <span className="library-departure__why">{departure.why}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
});

function summarize(departures: readonly DemoLibraryDeparture[] | null) {
  if (departures === null) {
    return "Waiting for a clip to open.";
  }

  if (departures.length === 0) {
    return "Nothing. This session runs on the values the library resolves for itself.";
  }

  const count =
    departures.length === 1
      ? "One setting"
      : `${String(departures.length)} settings`;

  return `${count} this workbench runs that createMediaSession would not pick on its own. Everything else is the library's own default.`;
}
