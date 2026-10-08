import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const directory = resolve(process.argv[2] ?? "");
const read = (name) =>
  JSON.parse(readFileSync(resolve(directory, name), "utf8"));
const plan = read("plan.json");
const complete = read("complete.json");
if (complete.status !== "complete" || plan.evidenceOnly)
  throw Error("summary requires a completed uninstrumented cost plan");
const records = complete.results.map((name) => read(`${name}.json`));
const mean = (values) => {
  const finite = values.filter(Number.isFinite);
  return finite.length
    ? finite.reduce((sum, value) => sum + value, 0) / finite.length
    : null;
};
const number = (value, digits = 1) =>
  Number.isFinite(value) ? value.toFixed(digits) : "—";
const signed = (value, suffix) =>
  `${value >= 0 ? "+" : ""}${number(value)}${suffix}`;
const resident = (record) =>
  record.memoryAfter.reduce((sum, row) => sum + row.rssMiB, 0);
const rows = [];
for (const [workload, cap] of [
  ["play1", 1],
  ["play8", 1],
  ["scrub", 1],
  ["play8", 2],
]) {
  const pairs = [1, 2]
    .map((pair) => {
      const off = records.find(
        (record) =>
          record.workload === workload &&
          record.cap === cap &&
          record.pair === pair &&
          !record.smooth,
      );
      const on = records.find(
        (record) =>
          record.workload === workload &&
          record.cap === cap &&
          record.pair === pair &&
          record.smooth,
      );
      return off && on ? { off, on } : null;
    })
    .filter(Boolean);
  if (!pairs.length) throw Error(`missing pair ${workload} DPR${cap}`);
  const aggregate = (key) => ({
    off: mean(pairs.map(({ off }) => key(off))),
    on: mean(pairs.map(({ on }) => key(on))),
  });
  const cpu = aggregate((record) => record.cpuTotal);
  const memory = aggregate(resident);
  const cadence = aggregate(
    (record) => record.behavior.summary.distinctSourceHz,
  );
  const gap = aggregate((record) => record.behavior.summary.sourceGapP95Ms);
  const noMask = aggregate(
    (record) => record.behavior.summary.sourceSamplesWithoutMaskStamp,
  );
  rows.push({
    workload,
    cap,
    pairs: pairs.length,
    cpu,
    residentMiB: memory,
    sourceHz: cadence,
    gapP95Ms: gap,
    sourceSamplesWithoutMaskStamp: noMask,
  });
}
const table = rows.map((row) => {
  const label =
    row.workload === "scrub"
      ? "Recorded human scrub"
      : `${row.workload.slice(4)}× playback`;
  const cpuChange = (row.cpu.on / row.cpu.off - 1) * 100;
  return `| ${label}, DPR${row.cap} | ${row.pairs} | ${number(row.cpu.off)}% → ${number(row.cpu.on)}% (${signed(cpuChange, "%")}) | ${number(row.residentMiB.off)} → ${number(row.residentMiB.on)} MiB (${signed(row.residentMiB.on - row.residentMiB.off, " MiB")}) | ${number(row.sourceHz.off)} → ${number(row.sourceHz.on)} | ${number(row.gapP95Ms.off)} → ${number(row.gapP95Ms.on)} ms |`;
});
const text = `# Annotation edge smoothing: measured cost\n\nHorse Trail, Web Video Engine, headed Chrome/WebGPU, current native monitor DPR2. Output DPR is listed per row. Same committed/built input hashes for off/on: \`${plan.inputs.head}\`.\n\n| Workload | Off/on pairs | Chrome CPU (100% = one core) | Resident memory after window | Distinct media presentations/s | Presentation gap p95 |\n| --- | ---: | --- | --- | --- | --- |\n${table.join("\n")}\n\nCPU changes are means of short paired windows. Two pairs counterbalance order at output DPR1; the DPR2 stress pair has no replication. These values are incremental cost of the global AA toggle on this branch, rather than gains over main.\n\nResident memory is the sum of Chrome process RSS, including browser overhead. Shared pages can be counted more than once, and GPU texture memory is not completely captured. Values report memory after the window; raw records also retain starting/peak memory and cache diagnostics.\n\nPresentation counts use the renderer's committed media clock, render count and mask stamp. Deliberately skipping source frames during 8× playback is expected. rAF samples alone cannot prove what pixels reached the display; the separate detailed GPU mask/submission evidence pass checks actual direct/offscreen mask draws. No screenshot, trace, profiler or GPU/worker hook ran in these cost windows.\n`;
writeFileSync(resolve(directory, "COST-SUMMARY.md"), text, { flag: "wx" });
writeFileSync(
  resolve(directory, "COST-SUMMARY.json"),
  JSON.stringify({ head: plan.inputs.head, rows }, null, 2) + "\n",
  { flag: "wx" },
);
console.log(text);
