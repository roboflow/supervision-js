import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const folder = resolve(process.argv[2]);
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const pct = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
const lines = [
  "# Annotation antialiasing comparison",
  "",
  "These are real renderer pixels from a fixed 768×512 scene at one output pixel per CSS pixel. The host display's native DPR is recorded separately. Video-like background pixels stayed unchanged, categorical mask IDs stayed unchanged, and switching every option back off restored the original pixels exactly.",
  "",
  "The timing is complete scene submission plus a wait for GPU completion, after warmup. It is a small fixed-scene comparison, not playback/scrub CPU, RAM or FPS. Percent increases look large because the baseline draw is already very short.",
  "",
];
const summary = { reports: [] };
for (const backend of ["webgpu", "webgl"]) {
  const report = JSON.parse(
    readFileSync(resolve(folder, `${backend}.json`), "utf8"),
  );
  const off = report.modes.find((mode) => mode.name === "none");
  lines.push(
    `## ${backend}: native DPR ${report.nativeDpr}, output resolution ${report.output.resolution}`,
    "",
    "| Option | Median ms per complete draw | Paired draw-time increase | Mask edge error | Vector/keypoint edge error | Focus edge error |",
    "|---|---:|---:|---:|---:|---:|",
  );
  const modes = report.modes.map((mode) => {
    const drawMs = median(
      report.timing
        .filter((row) => row.mode === mode.name)
        .map((row) => row.renderAndGpuDrainMs / row.batchDraws),
    );
    const ratios =
      mode.name === "none"
        ? []
        : [1, 2, 3].map((round) => {
            const rows = report.timing.filter(
              (row) => row.candidate === mode.name && row.round === round,
            );
            return (
              rows.find((row) => row.mode === mode.name).renderAndGpuDrainMs /
              rows.find((row) => row.mode === "none").renderAndGpuDrainMs
            );
          });
    const overhead = ratios.length ? (median(ratios) - 1) * 100 : 0;
    const error = Object.fromEntries(
      ["categoricalMasks", "vectorsAndKeypoints", "focus"].map((key) => [
        key,
        mode.regions[key].vsFinerCoverageReference.meanAbsoluteByteDelta,
      ]),
    );
    lines.push(
      `| ${mode.name} | ${drawMs.toFixed(3)} | ${mode.name === "none" ? "baseline" : pct(overhead)} | ${error.categoricalMasks.toFixed(3)} | ${error.vectorsAndKeypoints.toFixed(3)} | ${error.focus.toFixed(3)} |`,
    );
    return {
      name: mode.name,
      medianMsPerDraw: drawMs,
      medianPairedIncreasePercent: overhead,
      referenceError: error,
      maskAlphaChangePercent:
        (mode.regions.categoricalMasks.alphaMass /
          off.regions.categoricalMasks.alphaMass -
          1) *
        100,
    };
  });
  lines.push(
    "",
    "Edge error is average premultiplied RGBA byte difference from the same semantic scene rendered at 4× output resolution and box-downsampled; lower is closer to that coverage reference. This cannot recover mask contour detail discarded before rendering.",
    "",
    `Source head: \`${report.source.head}\`. Imported source/dependency hashes unchanged: **${report.sourceUnchanged}**. GPU/GL errors: **${report.errors.length}**. Teardown warnings: **${report.warnings.length}**.`,
    "",
  );
  summary.reports.push({
    backend,
    status: report.status,
    nativeDpr: report.nativeDpr,
    output: report.output,
    sourceHead: report.source.head,
    sourceUnchanged: report.sourceUnchanged,
    warnings: report.warnings,
    modes,
  });
}
writeFileSync(resolve(folder, "SUMMARY.md"), lines.join("\n") + "\n");
writeFileSync(
  resolve(folder, "SUMMARY.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(resolve(folder, "SUMMARY.md"));
