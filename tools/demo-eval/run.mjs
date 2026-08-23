/* Demo evaluation: detection sync, transport latency, playback cadence, the
 * gesture stress battery, the per-defect regression guards, and a comparison
 * against the numbers this machine recorded as its baseline. */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { parseArgs } from "node:util";

import {
  buildBaseline,
  compareProvenance,
  compareToBaseline,
  formatRow,
  loadBaseline,
  machineFingerprint,
  median,
  readMetrics,
  sameMachine,
  saveBaseline,
  sourceFingerprint,
  spread,
} from "./baseline.mjs";
import { closeTarget, listTargets, openTarget } from "./cdp.mjs";
import { missingHooks } from "./hooks.mjs";
import {
  guardDetail,
  runBackscrub,
  runBlanking,
  runDrag,
  runFocus,
  runPlayhead,
} from "./scenarios-guards.mjs";
import { layersDetail, runLayers } from "./scenarios-layers.mjs";
import { runThrottle, throttleDetail } from "./scenarios-throttle.mjs";
import {
  cadenceDetail,
  Invalid,
  openDemoPage,
  runBattery,
  runCadence,
  runLatency,
  runSync,
} from "./scenarios.mjs";

const SCENARIOS = [
  "sync",
  "latency",
  "layers",
  "cadence",
  "throttle",
  "blanking",
  "drag",
  "playhead",
  "backscrub",
  "focus",
  "battery",
];
const GUARD_SCENARIOS = new Set([
  "blanking",
  "drag",
  "playhead",
  "backscrub",
  "focus",
]);
const LABEL_WIDTH = 27;
/* Across repeated passes the worst verdict stands, so a scenario that failed
 * or was disturbed once cannot be reported as passing because a later pass
 * happened to run clean. */
const VERDICT_SEVERITY = ["skipped", "pass", "invalid-environment", "fail"];

const { values } = parseArgs({
  options: {
    "chrome-debug-url": { type: "string", default: "http://127.0.0.1:9223" },
    url: { type: "string", default: "http://localhost:5173/" },
    out: { type: "string", default: "tools/demo-eval/report.json" },
    scenario: { type: "string", default: "all" },
    storybook: { type: "string", default: "http://localhost:6006" },
    battery: {
      type: "string",
      default: "http://127.0.0.1:8123/stress-battery.js",
    },
    attempts: { type: "string", default: "3" },
    repeat: { type: "string", default: "1" },
    baseline: { type: "string", default: "tools/demo-eval/baseline.json" },
    "update-baseline": { type: "boolean", default: false },
    "allow-failing-baseline": { type: "boolean", default: false },
    tolerance: { type: "string" },
    view: { type: "string", default: "demo" },
  },
});

const requested =
  values.scenario === "all" ? SCENARIOS : values.scenario.split(",");
const unknown = requested.filter((name) => !SCENARIOS.includes(name));
if (unknown.length > 0) {
  process.stderr.write(
    `unknown scenario "${unknown.join(",")}", expected all or a comma-separated ` +
      `subset of ${SCENARIOS.join("|")}\n`,
  );
  process.exit(2);
}

const selected = requested;
const attempts = Math.max(1, Number(values.attempts) || 1);
const repeat = Math.max(1, Number(values.repeat) || 1);
const startedAt = Date.now();
const report = {
  startedAt,
  repeat,
  machine: machineFingerprint(),
  /* Which tree produced these numbers: a report carrying none can be held up
   * against a baseline recorded on other code with nothing to contradict it. */
  source: sourceFingerprint({ consumer: process.cwd() }),
  media: null,
  fixture: null,
  scenarios: {},
  verdicts: {},
  failures: [],
};
const notes = {};
const metricRuns = [];
let mediaInfo = null;

await main();

async function main() {
  for (let pass = 1; pass <= repeat; pass += 1) {
    const measured = await measure(pass);
    metricRuns.push(readMetrics(measured.scenarios));
  }

  report.metrics = summariseMetrics();
  await compareAgainstBaseline();
  await writeReport();
  printSummary();

  if (Object.values(report.verdicts).includes("fail")) process.exitCode = 1;
  if ((report.baseline?.regressions?.length ?? 0) > 0) process.exitCode = 1;
}

/** One full pass over the selected scenarios, folded into the shared report. */
async function measure(pass) {
  const scenarios = {};
  const demoScenarios = selected.filter((name) => name !== "battery");
  let page = null;

  if (demoScenarios.length > 0) {
    try {
      await assertChrome();
      await sweepStaleTargets();
      page = await openDemoPage(values["chrome-debug-url"], values.url, {
        viewMode: values.view,
      });
      mediaInfo = page.info;
      report.media = {
        duration: mediaInfo.duration,
        frameRate: mediaInfo.frameRate,
        backend: mediaInfo.backend,
        viewMode: mediaInfo.viewMode,
      };
      report.fixture = mediaInfo.fixture;
      await checkHookContract(page);
    } catch (error) {
      for (const name of demoScenarios) {
        record(pass, scenarios, name, null, describe(error));
      }
    }
  }

  if (page) {
    const runners = {
      sync: runSync,
      latency: runLatency,
      layers: runLayers,
      cadence: runCadence,
      throttle: runThrottle,
      blanking: runBlanking,
      drag: runDrag,
      playhead: runPlayhead,
      backscrub: runBackscrub,
      focus: runFocus,
    };
    try {
      for (const name of demoScenarios) {
        await attempt(pass, scenarios, name, () =>
          runners[name](page.session, page.info, attempts),
        );
      }
    } finally {
      page.session.close();
      await closeTarget(values["chrome-debug-url"], page.targetId);
    }
  }

  if (selected.includes("battery")) {
    if (demoScenarios.length === 0) {
      await sweepStaleTargets().catch(() => {});
    }
    await attempt(pass, scenarios, "battery", () =>
      runBattery(values["chrome-debug-url"], values.storybook, values.battery),
    );
  }

  return { scenarios };
}

/**
 * A scenario that cannot find the control it drives reports
 * invalid-environment, which is the tool declining to turn a disturbed window
 * into a number rather than a defect, so the run still reads as acceptable.
 * Three gates sat in that state for a whole merge. Resolving the hooks up
 * front turns the same drift into a failure that names what moved.
 */
async function checkHookContract(page) {
  if (page.info.viewMode === "benchmarks") return;
  const missing = await missingHooks(page.session);
  keepWorse("contract", missing.length > 0 ? "fail" : "pass");
  if (missing.length === 0) return;
  report.failures.push(
    `contract: the demo is not stamping ${missing.join(", ")}, so every ` +
      "scenario that drives those controls measures nothing",
  );
}

async function assertChrome() {
  const targets = await listTargets(values["chrome-debug-url"]).catch(() => {
    throw new Invalid(
      `no Chrome debug endpoint at ${values["chrome-debug-url"]}; ` +
        "start Chrome with --remote-debugging-port",
    );
  });
  if (!Array.isArray(targets)) {
    throw new Invalid(`${values["chrome-debug-url"]} is not a CDP endpoint`);
  }
}

/**
 * A run that dies between openTarget and its finally leaves demo/story tabs
 * behind, and those tabs hold hardware VideoDecoder sessions that starve the
 * next run. Closing the whole set would quit Chrome, so a blank tab is opened
 * first when every page is stale.
 */
async function sweepStaleTargets() {
  const chromeDebugUrl = values["chrome-debug-url"];
  const demoOrigin = new URL(values.url).origin;
  const storybookOrigin = new URL(values.storybook).origin;
  const pages = (await listTargets(chromeDebugUrl)).filter(
    (target) => target.type === "page",
  );
  const stale = pages.filter(
    (target) =>
      target.url.startsWith(demoOrigin) ||
      target.url.startsWith(storybookOrigin),
  );

  if (stale.length === 0) return;
  if (stale.length === pages.length) {
    await openTarget(chromeDebugUrl, "about:blank");
  }
  for (const target of stale) {
    await closeTarget(chromeDebugUrl, target.id);
  }
  process.stderr.write(
    `closed ${stale.length} stale tab(s) from a previous run\n`,
  );
}

async function attempt(pass, scenarios, name, run) {
  try {
    const result = await run();
    if (result.skipped) {
      keepWorse(name, "skipped");
      notes[name] = result.skipped;
      return;
    }
    record(pass, scenarios, name, result);
  } catch (error) {
    record(pass, scenarios, name, null, describe(error));
  }
}

function keepWorse(name, verdict) {
  const existing = report.verdicts[name];
  if (
    existing === undefined ||
    VERDICT_SEVERITY.indexOf(verdict) > VERDICT_SEVERITY.indexOf(existing)
  ) {
    report.verdicts[name] = verdict;
  }
}

function record(pass, scenarios, name, result, invalidReason) {
  const prefix = repeat > 1 ? `run ${pass}: ` : "";
  if (result === null) {
    keepWorse(name, "invalid-environment");
    notes[name] = `${prefix}${invalidReason}`;
    return;
  }
  scenarios[name] = result.scenario;
  report.scenarios[name] = result.scenario;
  report.failures.push(
    ...result.failures.map((failure) => `${prefix}${failure}`),
  );
  keepWorse(name, result.failures.length > 0 ? "fail" : "pass");
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Median and spread of every registry metric across the repeated passes. */
function summariseMetrics() {
  const keys = new Set(metricRuns.flatMap((run) => Object.keys(run)));
  const summary = {};
  for (const key of keys) {
    const samples = metricRuns
      .map((run) => run[key])
      .filter((value) => typeof value === "number");
    if (samples.length === 0) continue;
    summary[key] = {
      value: median(samples),
      samples,
      spread: spread(samples),
    };
  }
  return summary;
}

async function compareAgainstBaseline() {
  const path = resolve(process.cwd(), values.baseline);
  const measured = Object.fromEntries(
    Object.entries(report.metrics).map(([key, entry]) => [key, entry.value]),
  );
  const recorded = await loadBaseline(path);

  if (values["update-baseline"]) {
    const failing = Object.entries(report.verdicts).filter(
      ([, verdict]) => verdict === "fail" || verdict === "invalid-environment",
    );
    if (failing.length > 0 && !values["allow-failing-baseline"]) {
      report.baseline = {
        path,
        updated: false,
        reason:
          `refusing to record a baseline while ${failing
            .map(([name, verdict]) => `${name} is ${verdict}`)
            .join(", ")}; fix it, or pass --allow-failing-baseline to freeze ` +
          "these numbers on purpose",
      };
      return;
    }
    const next = buildBaseline({
      source: report.source,
      recordedWithFailures: failing.map(
        ([name, verdict]) => `${name}: ${verdict}`,
      ),
      runs: repeat,
      media: mediaInfo
        ? `${mediaInfo.duration}s at ${mediaInfo.frameRate}fps, ${mediaInfo.backend}`
        : null,
      fixture: report.fixture,
      viewMode: mediaInfo?.viewMode ?? null,
      samples: Object.fromEntries(
        Object.entries(report.metrics).map(([key, entry]) => [
          key,
          entry.samples,
        ]),
      ),
      values: measured,
    });
    await saveBaseline(path, next);
    report.baseline = {
      path,
      updated: true,
      metrics: Object.keys(measured).length,
      source: report.source,
      withFailures: failing.map(([name, verdict]) => `${name}: ${verdict}`),
      dirty: Object.entries(report.source)
        .filter(([, entry]) => entry?.dirty)
        .map(([name]) => name),
    };
    return;
  }

  if (recorded === null || recorded.unreadable) {
    report.baseline = {
      path,
      updated: false,
      reason:
        recorded?.unreadable ??
        `no baseline at ${values.baseline}; run with --update-baseline once the ` +
          "numbers are ones you would defend",
    };
    return;
  }

  const comparison = compareToBaseline(measured, recorded, {
    tolerancePercent: values.tolerance ? Number(values.tolerance) : undefined,
  });
  /* A metric belongs to the scenario its key is named for, and a run of one
   * scenario has nothing to say about the rest. */
  const mine = (row) => selected.includes(row.key.split(".")[0]);
  report.baseline = {
    path,
    updated: false,
    recordedAt: recorded.recordedAt,
    recordedOn: recorded.machine,
    recordedFrom: recorded.source ?? null,
    recordedFixture: recorded.fixture ?? null,
    recordedView: recorded.viewMode ?? null,
    sameMachine: sameMachine(recorded.machine, report.machine),
    provenance: compareProvenance(recorded, report),
    tolerancePercent: comparison.tolerancePercent,
    rows: comparison.rows.filter(mine),
    regressions: comparison.regressions.filter(mine),
  };
}

async function writeReport() {
  const path = resolve(process.cwd(), values.out);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  notes.reportPath = path;
}

function printSummary() {
  const lines = [
    `demo-eval  ${new Date(startedAt).toISOString()}`,
    field("chrome", values["chrome-debug-url"]),
    field("tree", commits(report.source)),
  ];
  if (selected.some((name) => name !== "battery")) {
    lines.push(field("page", values.url));
  }
  if (repeat > 1) lines.push(field("passes", repeat));
  if (mediaInfo) {
    lines.push(
      field(
        "media",
        `${mediaInfo.duration}s at ${mediaInfo.frameRate}fps, ${mediaInfo.backend}`,
      ),
      field("clip", report.fixture?.id ?? "unnamed"),
      field("view", mediaInfo.viewMode),
    );
  }
  if (report.verdicts.contract) {
    lines.push(field("hooks", report.verdicts.contract));
  }

  for (const name of selected) {
    lines.push("", `${name}  ${report.verdicts[name] ?? "not run"}`);
    if (notes[name]) lines.push(...wrap(notes[name]));
    const scenario = report.scenarios[name];
    if (scenario) lines.push(...detail(name, scenario));
  }

  lines.push(...baselineSummary());

  const failures = report.failures;
  lines.push("", `failures  ${failures.length}`);
  for (const failure of failures) lines.push(...wrap(failure));
  lines.push("", field("report", notes.reportPath));
  process.stdout.write(`${lines.join("\n")}\n`);
}

function baselineSummary() {
  const baseline = report.baseline;
  if (!baseline) return [];
  const lines = ["", "baseline"];
  if (baseline.updated) {
    lines.push(
      ...wrap(`recorded ${baseline.metrics} metrics to ${baseline.path}`),
      ...wrap(commits(baseline.source)),
    );
    if (baseline.withFailures.length > 0) {
      lines.push(
        ...wrap(
          `recorded while ${baseline.withFailures.join(", ")}; those numbers are ` +
            "the state of a known defect, not a target to defend",
        ),
      );
    }
    if (baseline.dirty.length > 0) {
      lines.push(
        ...wrap(
          `PROVISIONAL: ${baseline.dirty.join(" and ")} had uncommitted changes, so ` +
            "these numbers describe work in flight rather than a commit anyone can " +
            "check out. Re-record once the tree is clean.",
        ),
      );
    }
    return lines;
  }
  if (baseline.reason) {
    lines.push(...wrap(baseline.reason));
    return lines;
  }
  if (baseline.recordedView && baseline.recordedView !== mediaInfo?.viewMode) {
    lines.push(
      ...wrap(
        `recorded in the ${baseline.recordedView} view, measured in the ` +
          `${mediaInfo?.viewMode}; the two views put different work on the ` +
          "main thread and the percentages below are not comparing the same page",
      ),
    );
  }
  lines.push(
    field("recorded", `${baseline.recordedAt} on ${baseline.recordedOn.cpu}`),
    field("from", commits(baseline.recordedFrom)),
    field("measured", commits(report.source)),
    field(
      "clip",
      `${baseline.recordedFixture?.id ?? "unrecorded"} then, ` +
        `${report.fixture?.id ?? "unnamed"} now`,
    ),
    field("tolerance", `${baseline.tolerancePercent}% past the noise floor`),
  );
  for (const warning of baseline.provenance ?? []) lines.push(...wrap(warning));
  if (!baseline.sameMachine) {
    lines.push(
      ...wrap(
        `recorded on ${baseline.recordedOn.cpu} (${baseline.recordedOn.cores} cores), ` +
          `running on ${report.machine.cpu} (${report.machine.cores} cores); the ` +
          "percentages below compare two different machines",
      ),
    );
  }
  const moved = baseline.rows.filter((row) => row.verdict !== "steady");
  lines.push(
    field(
      "moved",
      `${baseline.regressions.length} regressed, ` +
        `${moved.length - baseline.regressions.length} improved or new, ` +
        `${baseline.rows.length - moved.length} steady`,
    ),
  );
  for (const row of baseline.rows) {
    if (row.verdict === "steady") continue;
    lines.push(...wrap(`${row.verdict.toUpperCase()}  ${formatRow(row)}`));
  }
  return lines;
}

function commits(source) {
  return (
    Object.entries(source ?? {})
      .map(
        ([name, entry]) =>
          `${name} ${entry?.commit ?? "unknown"}${entry?.dirty ? " (dirty)" : ""}`,
      )
      .join(", ") || "unrecorded"
  );
}

function detail(name, scenario) {
  if (GUARD_SCENARIOS.has(name)) {
    return guardDetail(name, scenario, field);
  }
  if (name === "sync") {
    return [
      field("frame period", `${scenario.framePeriodMs}ms`),
      field("settle budget", `${scenario.settleLimitMs}ms`),
      ...scenario.seeks.map((seek) =>
        field(
          `  seek ${seek.requested}s`,
          `landed ${seek.requestedToCurrentMs}ms, detection ` +
            `${seek.currentToDetectionMs === null ? "none" : `${seek.currentToDetectionMs}ms`}` +
            `, settle ${seek.settleMs}ms`,
        ),
      ),
    ];
  }
  if (name === "layers") {
    return layersDetail(scenario, field);
  }
  if (name === "cadence") {
    return cadenceDetail(scenario, field);
  }
  if (name === "throttle") {
    return throttleDetail(scenario, field);
  }
  if (name === "latency") {
    return [
      field(
        "seek p50 / p95 / max",
        `${scenario.seek.p50} / ${scenario.seek.p95} / ${scenario.seek.max} ms` +
          `  (limit ${scenario.seek.limitMs})`,
      ),
      field(
        "step p50 / p95 / max",
        `${scenario.step.p50} / ${scenario.step.p95} / ${scenario.step.max} ms` +
          `  (limit ${scenario.step.limitMs})`,
      ),
    ];
  }
  return [
    field("story", scenario.storyUrl),
    field("runs", `${scenario.total}, ${scenario.failures} failing`),
    ...scenario.byScenario.map((entry) =>
      field(`  ${entry.name}`, `${entry.ratio}  ${entry.verdict}`),
    ),
  ];
}

function field(label, value) {
  const line = `  ${String(label).padEnd(LABEL_WIDTH)}${value}`;
  if (line.length <= 80) return line;
  return [`  ${label}`, ...wrap(value, 72, "    ")].join("\n");
}

function wrap(text, width = 74, indent = "  ") {
  const lines = [];
  let current = "";
  for (const word of String(text).split(/\s+/)) {
    if (current && current.length + word.length + 1 > width) {
      lines.push(`${indent}${current}`);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(`${indent}${current}`);
  return lines;
}
