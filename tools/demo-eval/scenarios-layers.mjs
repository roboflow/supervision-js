/* Render-layer sweep: playback frame time for each layer combination, budgeted
 * against the layers-off floor measured in the same run. */

import { delay } from "./cdp.mjs";
import {
  at,
  Hook,
  LAYER_TOGGLE_HOOKS,
  layerToggleSelector,
  openControls,
  VIEW_MODE_PREFIX,
  viewModeSelector,
} from "./hooks.mjs";
import { percentile, round } from "./stats.mjs";

const SEEK_SECONDS = 2;
const SETTLE_MS = 500;
const SAMPLE_FRAMES = 240;
const WARMUP_FRAMES = 5;
const MIN_VALID_FRAMES = 150;
const SAMPLE_DEADLINE_MS = 45_000;
const SAMPLE_TIMEOUT_MS = 70_000;
const CONTROL_SETTLE_MS = 150;
const SLOW_FRAME_MS = 20;
const DROPPED_FRAME_MS = 34;
const P95_FLOOR_MULTIPLE = 2;
const P95_ABSOLUTE_SLACK_MS = 4;
const DROPPED_FRAME_LIMIT = 0;
const VIEW_MODE_SETTLE_MS = 15_000;
const VIEW_MODE_POLL_MS = 100;

const TOGGLE_LABELS = [
  "Boxes",
  "Masks",
  "Polygons",
  "Polylines",
  "Keypoints",
  "Labels",
  "Focus",
];

const FLOOR_CONFIG = "masks-off/focus-off";

const CONFIGS = [
  {
    name: "masks-on/border-default",
    toggles: { Masks: true },
    border: "baseline",
  },
  { name: "masks-on/border-max", toggles: { Masks: true }, border: "max" },
  {
    name: "masks-off/focus-on",
    toggles: { Masks: false, Focus: true },
    border: "baseline",
  },
  {
    name: "masks-on/focus-off",
    toggles: { Masks: true, Focus: false },
    border: "baseline",
  },
  {
    name: FLOOR_CONFIG,
    toggles: { Masks: false, Focus: false },
    border: "baseline",
  },
  {
    name: "everything-on",
    toggles: {
      Boxes: true,
      Masks: true,
      Polygons: true,
      Polylines: true,
      Keypoints: true,
      Labels: true,
      Focus: true,
    },
    border: "baseline",
  },
];

class Invalid extends Error {}

const READ_CONTROLS = `(() => {
  const toggles = {};
  for (const [name, hook] of Object.entries(${JSON.stringify(LAYER_TOGGLE_HOOKS)})) {
    const input = document.querySelector('[data-eval="' + hook + '"] input');
    if (input) toggles[name] = { checked: input.checked, disabled: input.disabled };
  }
  const input = document.querySelector(${at(Hook.MaskBorderSlider)} + ' input[type="range"]');
  const state = window.__demoRenderer.getState();
  return {
    toggles,
    border: input
      ? { value: Number(input.value), min: Number(input.min), max: Number(input.max), disabled: input.disabled }
      : null,
    playbackState: state.playbackState,
    currentTime: state.currentTime,
  };
})()`;

const setToggle = (label, checked) => `(() => {
  const input = document.querySelector(${layerToggleSelector(label)} + " input");
  if (!input) return { found: false };
  if (input.checked !== ${checked} && !input.disabled) input.click();
  return { found: true, disabled: input.disabled, checked: input.checked };
})()`;

const setBorder = (value) => `(() => {
  const input = document.querySelector(${at(Hook.MaskBorderSlider)} + ' input[type="range"]');
  if (!input) return { found: false };
  if (input.disabled) return { found: true, disabled: true, value: Number(input.value) };
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, String(${value}));
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return { found: true, disabled: false, value: Number(input.value) };
})()`;

const READ_STAGE = `(() => {
  const shell = document.querySelector(${at(Hook.Shell)});
  const pressed = document.querySelector(
    '[data-eval^="' + ${JSON.stringify(VIEW_MODE_PREFIX)} + '"][aria-pressed="true"]',
  );
  const mode = pressed
    ? pressed.getAttribute("data-eval").slice(${JSON.stringify(VIEW_MODE_PREFIX)}.length)
    : null;
  const mount = document.querySelector(${at(Hook.ViewportMount)});
  const canvases = mount
    ? [...mount.querySelectorAll("canvas")].map((canvas) => ({
        width: canvas.width,
        height: canvas.height,
      }))
    : [];
  const renderer = window.__demoRenderer;
  let rendererState = null;
  let rendererError = renderer ? null : "window.__demoRenderer is not defined";
  if (renderer) {
    try {
      const state = renderer.getState();
      rendererState = {
        playbackState: state.playbackState,
        sourceStatus: state.source.status,
      };
    } catch (error) {
      rendererError = String(error?.message ?? error);
    }
  }
  return {
    canvases,
    hasMount: !!mount,
    hasShell: !!shell,
    mode,
    rendererError,
    rendererState,
  };
})()`;

const clickViewMode = (mode) => `(() => {
  const button = document.querySelector(${viewModeSelector(mode)});
  if (!button) return { found: false };
  button.click();
  return { found: true };
})()`;

const sampler = (seekSeconds) => `(async () => {
  const renderer = window.__demoRenderer;
  await renderer.seek(${seekSeconds});
  await renderer.play();
  await new Promise((resolve) => setTimeout(resolve, ${SETTLE_MS}));
  const snapshot = () => {
    const state = renderer.getState();
    return {
      at: performance.now(),
      currentTime: state.currentTime,
      playbackState: state.playbackState,
      presentedFrames: state.presentedFrames,
    };
  };
  const before = snapshot();
  const deltas = [];
  await new Promise((resolve) => {
    const deadline = setTimeout(resolve, ${SAMPLE_DEADLINE_MS});
    let last = performance.now();
    const tick = (now) => {
      deltas.push(now - last);
      last = now;
      if (deltas.length < ${SAMPLE_FRAMES}) requestAnimationFrame(tick);
      else { clearTimeout(deadline); resolve(); }
    };
    requestAnimationFrame(tick);
  });
  const after = snapshot();
  renderer.pause();
  return { deltas, before, after, visibility: document.visibilityState };
})()`;

export async function runLayers(session, info, attempts) {
  await session.send("Page.bringToFront");
  const roundTrip = await checkViewModeRoundTrip(session);
  await openControls(session);
  const baseline = await session.readJson(READ_CONTROLS);
  assertControls(baseline);

  const seekSeconds = Math.min(SEEK_SECONDS, round(info.duration / 2, 3));
  const tries = Math.max(1, attempts);
  const unavailable = TOGGLE_LABELS.filter(
    (label) => baseline.toggles[label]?.disabled,
  );
  const measured = [];

  try {
    for (const config of CONFIGS) {
      measured.push(
        await runConfig(session, config, baseline, seekSeconds, tries),
      );
    }

    const floor = measured.find((row) => row.name === FLOOR_CONFIG);
    if (!floor) throw new Invalid(`the ${FLOOR_CONFIG} floor never measured`);
    const p95BudgetMs = round(
      Math.max(
        floor.p95 * P95_FLOOR_MULTIPLE,
        floor.p95 + P95_ABSOLUTE_SLACK_MS,
      ),
      2,
    );

    const rows = [];
    for (const row of measured) {
      let judged = judge(row, floor.p95, p95BudgetMs);
      /* Another agent's build or test run on this machine lands inside a
       * measurement window as a burst of long frames, so a breach is only
       * declared when it survives a second measurement. */
      if (judged.verdict === "fail") {
        const config = CONFIGS.find((entry) => entry.name === row.name);
        const repeat = await runConfig(
          session,
          config,
          baseline,
          seekSeconds,
          tries,
        );
        judged = { ...judge(repeat, floor.p95, p95BudgetMs), remeasured: true };
        judged.firstAttempt = {
          p95: row.p95,
          over34ms: row.over34ms,
          reasons: judge(row, floor.p95, p95BudgetMs).reasons,
        };
      }
      rows.push(judged);
    }

    const failures = [
      ...roundTrip.failures,
      ...rows.flatMap((row) =>
        row.reasons.map((reason) => `layers: ${row.name} ${reason}`),
      ),
    ];

    return {
      scenario: {
        viewModeRoundTrip: roundTrip.observed,
        seekSeconds,
        settleMs: SETTLE_MS,
        sampleFrames: SAMPLE_FRAMES,
        warmupFrames: WARMUP_FRAMES,
        minValidFrames: MIN_VALID_FRAMES,
        floor: { config: FLOOR_CONFIG, p95Ms: floor.p95 },
        budgets: {
          p95FloorMultiple: P95_FLOOR_MULTIPLE,
          p95AbsoluteSlackMs: P95_ABSOLUTE_SLACK_MS,
          p95BudgetMs,
          droppedFrameMs: DROPPED_FRAME_MS,
          droppedFrameLimit: DROPPED_FRAME_LIMIT,
          slowFrameMs: SLOW_FRAME_MS,
        },
        baseline: {
          border: baseline.border.value,
          toggles: Object.fromEntries(
            TOGGLE_LABELS.map((label) => [
              label,
              baseline.toggles[label]?.checked ?? null,
            ]),
          ),
        },
        unavailableToggles: unavailable,
        configs: rows,
      },
      failures,
    };
  } finally {
    await restore(session, baseline);
  }
}

/**
 * Leaving the Demo view unmounts the viewport and returning mounts a different
 * element, so a session still drawing into the first one keeps decoding into a
 * canvas nobody can see. That failure reports nothing: no console error, no
 * stalled clock, no stopped frame counter, just an empty stage. Every other
 * scenario measures inside a single view, which is why the whole harness could
 * be green while the demo showed nothing.
 */
async function checkViewModeRoundTrip(session) {
  const opening = await session.readJson(READ_STAGE);

  if (!opening.hasShell) {
    throw new Invalid("the demo shell is not on the page");
  }

  const startingMode = opening.mode;

  try {
    if (startingMode !== "demo") {
      await selectViewMode(session, "demo");
    }

    const before = await waitForStage(session);

    if (!drawnCanvases(before).length || !before.rendererState) {
      throw new Invalid(
        "the Demo view had no drawn stage before the round trip, so leaving " +
          "and returning proves nothing about it",
      );
    }

    const away = await selectViewMode(session, "benchmarks");

    if (away.hasMount) {
      throw new Invalid(
        "the Benchmarks view left the renderer viewport mounted, so this " +
          "guard does not exercise a remount",
      );
    }

    await selectViewMode(session, "demo");

    const after = await waitForStage(session);
    const failures = [];

    if (after.canvases.length === 0) {
      failures.push(
        "layers: the viewport mount came back empty after a Benchmarks round " +
          "trip; the stage is blank while the session draws into the element " +
          "the previous mount left behind",
      );
    } else if (drawnCanvases(after).length === 0) {
      failures.push(
        `layers: the canvas came back sized ${describeCanvases(after)} after ` +
          "a Benchmarks round trip, which draws nothing",
      );
    }

    if (!after.rendererState) {
      failures.push(
        `layers: window.__demoRenderer stopped answering after a Benchmarks ` +
          `round trip (${after.rendererError})`,
      );
    }

    return {
      failures,
      observed: {
        startingMode,
        canvasesBefore: describeCanvases(before),
        canvasesAfter: describeCanvases(after),
        mountedWhileAway: away.hasMount,
        playbackState: after.rendererState?.playbackState ?? null,
        sourceStatus: after.rendererState?.sourceStatus ?? null,
      },
    };
  } finally {
    if (startingMode !== "demo") {
      await selectViewMode(session, startingMode).catch(() => {});
    }
  }
}

async function selectViewMode(session, mode) {
  const clicked = await session.readJson(clickViewMode(mode));

  if (!clicked.found) {
    throw new Invalid(`the demo is not showing a ${mode} view button`);
  }

  const deadline = Date.now() + VIEW_MODE_SETTLE_MS;
  let last = null;

  while (Date.now() < deadline) {
    last = await session.readJson(READ_STAGE);
    if (last.mode === mode) return last;
    await delay(VIEW_MODE_POLL_MS);
  }

  throw new Invalid(
    `the demo stayed in the ${last?.mode} view after the ${mode} button was clicked`,
  );
}

/* The picture returns on a React commit, not on the click that asks for it. */
async function waitForStage(session) {
  const deadline = Date.now() + VIEW_MODE_SETTLE_MS;
  let last = null;

  while (Date.now() < deadline) {
    last = await session.readJson(READ_STAGE);
    if (drawnCanvases(last).length > 0 && last.rendererState) return last;
    await delay(VIEW_MODE_POLL_MS);
  }

  return last;
}

function drawnCanvases(stage) {
  return stage.canvases.filter(
    (canvas) => canvas.width > 0 && canvas.height > 0,
  );
}

function describeCanvases(stage) {
  if (stage.canvases.length === 0) return "none";
  return stage.canvases
    .map((canvas) => `${canvas.width}x${canvas.height}`)
    .join(", ");
}

function assertControls(baseline) {
  const missing = TOGGLE_LABELS.filter((label) => !baseline.toggles[label]);
  if (missing.length > 0) {
    throw new Invalid(
      `the demo is not showing the layer toggles ${missing.join(", ")}; ` +
        "the render controls panel changed or never mounted",
    );
  }
  if (!baseline.border) {
    throw new Invalid("the demo is not showing the mask Border slider");
  }
}

async function runConfig(session, config, baseline, seekSeconds, attempts) {
  let lastReason = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const navMark = session.navigations;
    try {
      const applied = await apply(session, config, baseline);
      /* A tab another tool opens meanwhile takes the foreground, and a
       * background tab stops running requestAnimationFrame. */
      await session.send("Page.bringToFront");
      const sample = await session.readJson(sampler(seekSeconds), {
        timeoutMs: SAMPLE_TIMEOUT_MS,
      });
      if (session.navigations !== navMark) {
        lastReason = "the page reloaded during the measurement window";
        await waitForRenderer(session);
        continue;
      }
      return { name: config.name, ...applied, ...summarize(sample) };
    } catch (error) {
      if (session.navigations === navMark && !(error instanceof Invalid))
        throw error;
      lastReason = error.message;
      if (session.navigations !== navMark) await waitForRenderer(session);
    }
  }
  throw new Invalid(
    `${config.name}: ${lastReason} (after ${attempts} attempts)`,
  );
}

/* Every config states each layer, so a panel left mid-fiddle in this Chrome
 * profile cannot change what the matrix measures. Masks go on before the border
 * value because the slider is disabled while the mask layer is off. */
async function apply(session, config, baseline) {
  await session.evaluate(setToggle("Masks", true));
  const border =
    config.border === "max" ? baseline.border.max : baseline.border.value;
  const borderResult = await session.evaluate(setBorder(border));
  if (borderResult.disabled) {
    throw new Invalid("the Border slider was disabled when the sweep set it");
  }

  const skipped = [];
  for (const label of TOGGLE_LABELS) {
    const checked = config.toggles[label] ?? true;
    const result = await session.evaluate(setToggle(label, checked));
    if (result.checked !== checked) {
      if (!result.disabled) {
        throw new Invalid(`the ${label} toggle did not accept a click`);
      }
      skipped.push(label);
    }
  }
  await delay(CONTROL_SETTLE_MS);

  const observed = await session.readJson(READ_CONTROLS);
  return {
    border: observed.border.value,
    toggles: Object.fromEntries(
      TOGGLE_LABELS.map((label) => [label, observed.toggles[label].checked]),
    ),
    skippedToggles: skipped,
  };
}

function summarize(sample) {
  const { before, after } = sample;
  if (sample.visibility !== "visible") {
    throw new Invalid(
      `the demo tab was ${sample.visibility} during the window; ` +
        "a backgrounded tab does not run requestAnimationFrame",
    );
  }
  if (
    before.playbackState === "playing" &&
    after.playbackState === "playing" &&
    after.currentTime <= before.currentTime &&
    after.presentedFrames === before.presentedFrames
  ) {
    throw new Invalid(
      "decoder starvation: playback state stayed playing, the media clock " +
        "froze and no frames were presented. Another tab holding the " +
        "hardware decoder sessions produces exactly this signature; close it " +
        "and re-run.",
    );
  }

  const deltas = sample.deltas.slice(WARMUP_FRAMES);
  if (deltas.length < MIN_VALID_FRAMES) {
    throw new Invalid(
      `requestAnimationFrame delivered only ${deltas.length} frames ` +
        `in ${Math.round(SAMPLE_DEADLINE_MS / 1000)}s (needs ${MIN_VALID_FRAMES}); ` +
        "the tab is throttled or the machine is not running the compositor",
    );
  }

  const sorted = [...deltas].sort((a, b) => a - b);
  return {
    frames: sorted.length,
    windowMs: round(after.at - before.at, 1),
    mediaAdvancedSeconds: round(after.currentTime - before.currentTime, 3),
    mean: round(
      sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
      2,
    ),
    p50: percentile(sorted, 0.5, 2),
    p95: percentile(sorted, 0.95, 2),
    p99: percentile(sorted, 0.99, 2),
    max: round(sorted.at(-1), 2),
    over20ms: sorted.filter((value) => value > SLOW_FRAME_MS).length,
    over34ms: sorted.filter((value) => value > DROPPED_FRAME_MS).length,
  };
}

function judge(row, floorP95, p95BudgetMs) {
  const reasons = [];
  if (row.p95 > p95BudgetMs) {
    reasons.push(
      `p95 ${row.p95}ms exceeds the ${p95BudgetMs}ms budget ` +
        `(${P95_FLOOR_MULTIPLE}x the ${FLOOR_CONFIG} floor p95 ${floorP95}ms, ` +
        `minimum floor+${P95_ABSOLUTE_SLACK_MS}ms)`,
    );
  }
  if (row.over34ms > DROPPED_FRAME_LIMIT) {
    reasons.push(
      `dropped ${row.over34ms} of ${row.frames} frames over ${DROPPED_FRAME_MS}ms ` +
        `(limit ${DROPPED_FRAME_LIMIT})`,
    );
  }
  return {
    ...row,
    ratioToFloor: round(row.p95 / floorP95, 2),
    verdict: reasons.length === 0 ? "pass" : "fail",
    reasons,
  };
}

async function restore(session, baseline) {
  for (const label of TOGGLE_LABELS) {
    await session
      .evaluate(setToggle(label, baseline.toggles[label].checked))
      .catch(() => {});
  }
  await session.evaluate(setBorder(baseline.border.value)).catch(() => {});
  await session
    .evaluate(
      `(async () => {
        const renderer = window.__demoRenderer;
        renderer.pause();
        await renderer.seek(${baseline.currentTime});
        if (${JSON.stringify(baseline.playbackState)} === "playing") await renderer.play();
        return 1;
      })()`,
    )
    .catch(() => {});
}

async function waitForRenderer(session, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await session
      .evaluate(
        `(() => {
          const renderer = window.__demoRenderer;
          if (!renderer) return false;
          const state = renderer.getState();
          return state.source.status === "ready" && state.duration > 0;
        })()`,
      )
      .catch(() => false);
    if (ready) return;
    await delay(500);
  }
  throw new Invalid("the demo renderer never became ready after a page reload");
}

export function layersDetail(scenario, field) {
  const { budgets, floor, viewModeRoundTrip } = scenario;
  const lines = [
    ...(viewModeRoundTrip
      ? [
          field(
            "view-mode round trip",
            `Benchmarks and back: canvas ${viewModeRoundTrip.canvasesAfter}, ` +
              `renderer ${viewModeRoundTrip.playbackState ?? "gone"}`,
          ),
        ]
      : []),
    field(
      "config base",
      `every layer on except the ones a config names, ` +
        `border ${scenario.baseline.border}px`,
    ),
    field(
      "sample",
      `${scenario.sampleFrames} rAF frames at t=${scenario.seekSeconds}s, ` +
        `${scenario.settleMs}ms settle, first ${scenario.warmupFrames} dropped`,
    ),
    field("floor", `${floor.config}  p95 ${floor.p95Ms}ms`),
    field(
      "p95 budget",
      `${budgets.p95BudgetMs}ms  (${budgets.p95FloorMultiple}x floor p95, ` +
        `min floor+${budgets.p95AbsoluteSlackMs}ms)`,
    ),
    field(
      "dropped-frame budget",
      `${budgets.droppedFrameLimit} frames over ${budgets.droppedFrameMs}ms per config`,
    ),
    field("validity floor", `${scenario.minValidFrames} frames per window`),
    "",
    `  ${"config".padEnd(24)}${"mean".padStart(7)}${"p95".padStart(8)}` +
      `${"p99".padStart(8)}${">20".padStart(6)}${">34".padStart(6)}` +
      `${"xfloor".padStart(8)}  verdict`,
  ];

  for (const row of scenario.configs) {
    lines.push(
      `  ${row.name.padEnd(24)}${String(row.mean).padStart(7)}` +
        `${String(row.p95).padStart(8)}${String(row.p99).padStart(8)}` +
        `${String(row.over20ms).padStart(6)}${String(row.over34ms).padStart(6)}` +
        `${`${row.ratioToFloor}x`.padStart(8)}  ${row.verdict}` +
        `${row.remeasured ? " (remeasured)" : ""}`,
    );
  }

  if (scenario.unavailableToggles.length > 0) {
    lines.push(
      field("unavailable layers", scenario.unavailableToggles.join(", ")),
    );
  }
  return lines;
}
