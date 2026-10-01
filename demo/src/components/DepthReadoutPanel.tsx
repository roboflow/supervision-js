import type { DepthReadout } from "supervision";
import {
  describeDepthReadout,
  type DocsDepthReadoutContext,
} from "../docs-depth";
import "./depth-readout-panel.css";

/**
 * What the depth map holds under the pointer. The block keeps one height and
 * one set of rows in every state, so hovering never moves what sits below it.
 */
export function DepthReadoutPanel(
  props: DocsDepthReadoutContext & { readonly readout: DepthReadout | null },
) {
  const view = describeDepthReadout(props.readout, props);

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
