import { memo } from "react";

import { DEMO_DEFAULT_MEDIA_PATH } from "../session/workbench-defaults";
import {
  DemoMediaPath,
  type DemoOptionSupport,
} from "../session/session-options";
import { ControlNote } from "./InspectorControls";
import { demoMediaPathCopy, demoMediaPathOrder } from "./media-path-copy";

export const MediaPathPanel = memo(function MediaPathPanel({
  onChange,
  path,
  support,
}: {
  readonly onChange: (path: DemoMediaPath) => void;
  readonly path: DemoMediaPath;
  readonly support: DemoOptionSupport;
}) {
  return (
    <section className="media-path" aria-label="Media path">
      <header className="inspector-card__header">
        <h2>Media path</h2>
      </header>
      <p className="session-options__hint">
        Which reader opens the clip and turns it into pictures. A clip opens on
        the one the library ships with, so what you see first is what a project
        that installed nothing else gets. Picking the other reopens the clip and
        picks up where you left off.
      </p>
      <div className="media-path__options">
        {demoMediaPathOrder.map((option) => (
          <MediaPathOption
            current={option === path}
            disabled={!support.supported}
            key={option}
            onChange={onChange}
            path={option}
          />
        ))}
      </div>
      {support.supported ? null : <ControlNote>{support.reason}</ControlNote>}
    </section>
  );
});

function MediaPathOption({
  current,
  disabled,
  onChange,
  path,
}: {
  readonly current: boolean;
  readonly disabled: boolean;
  readonly onChange: (path: DemoMediaPath) => void;
  readonly path: DemoMediaPath;
}) {
  const copy = demoMediaPathCopy[path];

  return (
    <button
      aria-pressed={current}
      className="media-path__option"
      disabled={disabled}
      onClick={() => onChange(path)}
      type="button"
    >
      <span className="media-path__option-head">
        <strong>{copy.label}</strong>
        {path === DEMO_DEFAULT_MEDIA_PATH ? (
          <span className="media-path__badge">opens here</span>
        ) : null}
      </span>
      <span className="media-path__option-summary">{copy.summary}</span>
      <span className="media-path__option-facts">
        <MediaPathFact label="Good at" value={copy.goodAt} />
        <MediaPathFact label="Costs" value={copy.costs} />
        <MediaPathFact label="Pick it when" value={copy.pickWhen} />
        <MediaPathFact label="Import" value={copy.imports} />
      </span>
    </button>
  );
}

function MediaPathFact({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <span className="media-path__fact">
      <span className="media-path__fact-label">{label}</span>
      <span className="media-path__fact-value">{value}</span>
    </span>
  );
}
