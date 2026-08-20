/* Demo evaluation: paint discipline, detection sync, transport latency and the
 * gesture stress battery, measured over CDP against a running demo. */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import { closeTarget, listTargets, openTarget } from "./cdp.mjs";
import { layersDetail, runLayers } from "./scenarios-layers.mjs";
import { runThrottle, throttleDetail } from "./scenarios-throttle.mjs";
import {
  Invalid,
  openDemoPage,
  runBattery,
  runLatency,
  runPaints,
  runSync,
} from "./scenarios.mjs";

const SCENARIOS = [
  "paints",
  "sync",
  "latency",
  "layers",
  "throttle",
  "battery",
];
const LABEL_WIDTH = 27;

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
  },
});

if (values.scenario !== "all" && !SCENARIOS.includes(values.scenario)) {
  process.stderr.write(
    `unknown scenario "${values.scenario}", expected all|${SCENARIOS.join("|")}\n`,
  );
  process.exit(2);
}

const selected = values.scenario === "all" ? SCENARIOS : [values.scenario];
const attempts = Math.max(1, Number(values.attempts) || 1);
const startedAt = Date.now();
const report = { startedAt, scenarios: {}, verdicts: {}, failures: [] };
const notes = {};
let mediaInfo = null;

await main();

async function main() {
  const demoScenarios = selected.filter((name) => name !== "battery");
  let page = null;

  if (demoScenarios.length > 0) {
    try {
      await assertChrome();
      await sweepStaleTargets();
      page = await openDemoPage(values["chrome-debug-url"], values.url);
      mediaInfo = page.info;
    } catch (error) {
      for (const name of demoScenarios) {
        report.verdicts[name] = "invalid-environment";
        notes[name] = describe(error);
      }
    }
  }

  if (page) {
    const runners = {
      paints: runPaints,
      sync: runSync,
      latency: runLatency,
      layers: runLayers,
      throttle: runThrottle,
    };
    try {
      for (const name of demoScenarios) {
        await record(name, () =>
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
    await record("battery", () =>
      runBattery(values["chrome-debug-url"], values.storybook, values.battery),
    );
  }

  await writeReport();
  printSummary();
  if (Object.values(report.verdicts).includes("fail")) process.exitCode = 1;
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

async function record(name, run) {
  try {
    const result = await run();
    if (result.skipped) {
      report.verdicts[name] = "skipped";
      notes[name] = result.skipped;
      return;
    }
    report.scenarios[name] = result.scenario;
    report.failures.push(...result.failures);
    report.verdicts[name] = result.failures.length === 0 ? "pass" : "fail";
  } catch (error) {
    report.verdicts[name] = "invalid-environment";
    notes[name] = describe(error);
  }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
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
  ];
  if (selected.some((name) => name !== "battery")) {
    lines.push(field("page", values.url));
  }
  if (mediaInfo) {
    lines.push(
      field(
        "media",
        `${mediaInfo.duration}s at ${mediaInfo.frameRate}fps, ${mediaInfo.backend}`,
      ),
    );
  }

  for (const name of selected) {
    lines.push("", `${name}  ${report.verdicts[name] ?? "not run"}`);
    if (notes[name]) lines.push(...wrap(notes[name]));
    const scenario = report.scenarios[name];
    if (scenario) lines.push(...detail(name, scenario));
  }

  const failures = report.failures;
  lines.push("", `failures  ${failures.length}`);
  for (const failure of failures) lines.push(...wrap(failure));
  lines.push("", field("report", notes.reportPath));
  process.stdout.write(`${lines.join("\n")}\n`);
}

function detail(name, scenario) {
  if (name === "paints") {
    const { paused, playing } = scenario;
    return [
      field("paused paints", `${paused.paintCount}  (limit 0)`),
      field(
        "paused layout / commit",
        `${paused.layoutCount} / ${paused.commitCount}`,
      ),
      field("paused scene renders", paused.sceneRenderDelta),
      field("playing paints", playing.paintCount),
      field(
        "playing style recalcs",
        `${playing.styleRecalcRate ?? 0}/s  (limit ${playing.styleRecalcRateLimit ?? 0}/s)`,
      ),
      field(
        "playing viewport paints",
        `${playing.viewportPaintCount ?? 0}  (limit 0)`,
      ),
      field(
        "playing canvas class",
        `${playing.canvasRectClass ?? "none"} x${playing.canvasPaintCount}` +
          `${playing.canvasRectSource ? ` (${playing.canvasRectSource})` : ""}`,
      ),
      field(
        "playing DOM paint rate",
        `${playing.domPaintRate}/s  (limit ${playing.domPaintRateLimit}/s)`,
      ),
      field(
        "playing damage off picture",
        `${playing.damage.largestOutsidePicture?.size ?? "none"}` +
          ` ${playing.damage.largestOutsidePicture?.area ?? 0}px²` +
          `  (limit ${playing.damageAreaLimit}px²)`,
      ),
      field(
        "playing present rate",
        `${playing.presentRate}/s via ${playing.presentRateSource}`,
      ),
      field(
        "playing media advanced",
        `${playing.mediaAdvancedSeconds}s over ${playing.elapsedSeconds}s`,
      ),
      field("playing scene renders", playing.sceneRenderDelta),
      field(
        "playing layout / commit",
        `${playing.layoutCount} / ${playing.commitCount}`,
      ),
      ...playing.rects
        .slice(0, 4)
        .map((rect) => field(`  rect ${rect.size}`, `${rect.count} paints`)),
    ];
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
