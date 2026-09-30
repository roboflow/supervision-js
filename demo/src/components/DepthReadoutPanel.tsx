import type { DepthMapKind, DepthReadout } from "supervision";
import { describeDepthReadout } from "../docs-depth";
import "./depth-readout-panel.css";

/**
 * What the depth map holds under the pointer. The block keeps one height and
 * one set of rows in every state, so hovering never moves what sits below it.
 */
export function DepthReadoutPanel(props: {
  readonly readout: DepthReadout | null;
  readonly kind?: DepthMapKind;
}) {
  const view = describeDepthReadout(props.readout, props.kind);

  return (
    <section className="depth-readout" aria-label="Depth under the pointer">
      <header>
        <strong>Under the pointer</strong>
        <span aria-live="polite">{view.status}</span>
      </header>
      <dl>
        {view.rows.map(({ label, value }) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
