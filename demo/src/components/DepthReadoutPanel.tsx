import { describeDepthReadout } from "../depth";
import { useDepthProbe, type DepthProbe } from "../hooks/depth-probe";
import "./depth-readout-panel.css";

export function DepthReadoutPanel({ probe }: { readonly probe: DepthProbe }) {
  const { active, readout } = useDepthProbe(probe);
  const view = describeDepthReadout(active, readout);

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
