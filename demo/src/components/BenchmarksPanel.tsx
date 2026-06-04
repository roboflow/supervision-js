import type { ReactNode } from "react";

const maskRenderingComparison = {
  from: {
    label: "Compressed RLE loop",
    value: "47-55ms",
  },
  note: "CPU mask loop to prepared ID-mask shader",
  to: {
    label: "PNG ID-mask shader",
    value: "6.7-9.6ms",
  },
} as const;

const headlineMetrics = [
  {
    label: "5s prepared window",
    value: "1.2GB -> 1.6MB",
    note: "RGBA vs PNG ID-mask",
  },
  {
    label: "Class style update",
    value: "12B",
    note: "palette uniforms",
  },
] as const;

const runtimeRows = [
  {
    activeFrame: "2.4-3.6ms",
    frameBytes: "7.9 MB",
    name: "RGBA fill",
    prep: "18-19ms",
    role: "Baseline",
    selected: false,
    windowBytes: "1.2 GB",
  },
  {
    activeFrame: "6.3-8.6ms",
    frameBytes: "7.9 MB",
    name: "RGBA fill + CPU border",
    prep: "47-55ms",
    role: "Too heavy",
    selected: false,
    windowBytes: "1.2 GB",
  },
  {
    activeFrame: "-",
    frameBytes: "2.0 MB",
    name: "Raw ID mask",
    prep: "16-17ms",
    role: "Fallback",
    selected: false,
    windowBytes: "297 MB",
  },
  {
    activeFrame: "5.2-5.7ms",
    frameBytes: "11 KB",
    name: "PNG ID mask + palette shader",
    prep: "18-21ms",
    role: "Chosen fill",
    selected: true,
    windowBytes: "1.6 MB",
  },
  {
    activeFrame: "6.7-9.6ms",
    frameBytes: "11 KB",
    name: "PNG ID mask + border shader",
    prep: "18-21ms",
    role: "Chosen border",
    selected: true,
    windowBytes: "1.6 MB",
  },
] as const;

const storageRows = [
  ["Video fixture", "4.7 MB"],
  ["Chunked detections", "3.3 MB"],
  ["RLE counts", "1.8 MB"],
  ["5s RLE hot window", "1.0 MB"],
  ["5s RGBA prepared window", "1.2 GB"],
  ["5s PNG ID-mask window", "1.6 MB"],
  ["Palette style update", "12 B"],
] as const;

const pipelineRows = [
  ["Cold", "RLE detections"],
  ["Hot", "Buffered detection frames"],
  ["Prepared", "PNG ID-mask frame artifacts"],
  ["Active", "Pixi shader palette render"],
] as const;

export function BenchmarksPanel() {
  return (
    <section className="benchmarks-panel" aria-label="Benchmark summary">
      <div className="benchmark-metrics" aria-label="Benchmark highlights">
        <article className="benchmark-comparison-card">
          <div className="benchmark-comparison-card__side">
            <span>{maskRenderingComparison.from.label}</span>
            <strong>{maskRenderingComparison.from.value}</strong>
          </div>
          <div className="benchmark-comparison-card__arrow" aria-hidden="true">
            -&gt;
          </div>
          <div className="benchmark-comparison-card__side">
            <span>{maskRenderingComparison.to.label}</span>
            <strong>{maskRenderingComparison.to.value}</strong>
          </div>
          <small>{maskRenderingComparison.note}</small>
        </article>
        {headlineMetrics.map((metric) => (
          <article className="benchmark-metric-card" key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <small>{metric.note}</small>
          </article>
        ))}
      </div>

      <div className="benchmarks-grid">
        <BenchmarkCard title="Mask Runtime Strategy">
          <table className="benchmark-table">
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Prep</th>
                <th>Active</th>
                <th>Frame</th>
                <th>5s</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {runtimeRows.map((row) => (
                <tr
                  className={
                    row.selected ? "benchmark-table__row--selected" : undefined
                  }
                  key={row.name}
                >
                  <th scope="row">{row.name}</th>
                  <td>{row.prep}</td>
                  <td>{row.activeFrame}</td>
                  <td>{row.frameBytes}</td>
                  <td>{row.windowBytes}</td>
                  <td>{row.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </BenchmarkCard>

        <BenchmarkCard title="Storage Pressure">
          <table className="benchmark-table benchmark-table--compact">
            <tbody>
              {storageRows.map(([label, value]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  <td>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </BenchmarkCard>

        <BenchmarkCard title="Chosen Pipeline">
          <table className="benchmark-table benchmark-table--compact">
            <tbody>
              {pipelineRows.map(([stage, value]) => (
                <tr key={stage}>
                  <th scope="row">{stage}</th>
                  <td>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </BenchmarkCard>
      </div>
    </section>
  );
}

function BenchmarkCard({
  children,
  title,
}: {
  readonly children: ReactNode;
  readonly title: string;
}) {
  return (
    <section className="benchmark-card">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
