/* Slow-machine floor: steady playback under a fixed CPU throttle, judged
 * against the rates the player has to hold to still be worth watching. */

import { delay } from "./cdp.mjs";
import { Invalid, waitForRenderer } from "./renderer-ready.mjs";
import { percentile, round } from "./stats.mjs";

/* Chrome's throttle divides the CPU every thread of the renderer process gets.
 * A sweep of 1x/2x/4x/6x against the 70s horse fixture measured this page's own
 * main thread 15% busy at 1x, 30% at 2x, 54% at 4x and 82% at 6x, so 2x is the
 * hardest slowdown the demo currently survives whole and the one a floor can be
 * asserted at today. Raise it once the mask cook stops flooding the thread. */
const THROTTLE_RATE = 2;
const SEEK_SECONDS = 5;
const SETTLE_MS = 2500;
const SAMPLE_MS = 6000;
const SAMPLE_INTERVAL_MS = 50;
const MIN_SAMPLES = 60;
/* A playing window that advances less than this fraction of wall time is not a
 * measurement of playback, whatever the sampler collected. */
const MIN_ADVANCE_RATIO = 0.25;

/* Every floor comes from that sweep. At 2x the picture held 0.997 to 1.112 of
 * the source rate over five windows and every sampled frame carried a
 * detection; 4x dropped to 0.803. The longest main-thread task at 2x was 122ms
 * across those windows, against 179ms to 361ms at 4x and 6x. */
const PRESENTED_RATE_FLOOR = 0.9;
const COVERAGE_FLOOR = 0.97;
const TASK_CEILING_MS = 200;

const SAMPLER = `(async () => {
  const renderer = window.__demoRenderer;
  const samples = [];
  const longTasks = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push(Math.round(entry.duration));
  });
  observer.observe({ entryTypes: ["longtask"] });
  const read = () => {
    const state = renderer.getState();
    const prepared = renderer.getPreparedAnnotationWindow();
    let preparedAhead = 0;
    let backlog = 0;
    if (prepared) {
      const frames = prepared.frames;
      let index = 0;
      while (index < frames.length && frames[index].mediaTime < state.currentTime) index += 1;
      let running = true;
      for (let at = index; at < frames.length; at += 1) {
        if (frames[at].prepared && running) preparedAhead += 1;
        else { running = false; backlog += 1; }
      }
    }
    samples.push({
      at: performance.now(),
      currentTime: state.currentTime,
      playbackState: state.playbackState,
      detectionTime: state.activeDetectionFrameTime,
      renderCount: renderer.getRenderCount(),
      preparedAhead,
      backlog,
    });
  };
  read();
  const timer = setInterval(read, ${SAMPLE_INTERVAL_MS});
  await new Promise((resolve) => setTimeout(resolve, ${SAMPLE_MS}));
  clearInterval(timer);
  observer.disconnect();
  read();
  return { samples, longTasks, visibility: document.visibilityState };
})()`;

export async function runThrottle(session, info, attempts) {
  await session.send("Page.bringToFront");
  try {
    await session.send("Emulation.setCPUThrottlingRate", {
      rate: THROTTLE_RATE,
    });
    const measured = await measureStable(session, info, Math.max(1, attempts));
    const failures = judge(measured, info);
    return {
      scenario: {
        throttleRate: THROTTLE_RATE,
        sourceRate: info.frameRate,
        seekSeconds: SEEK_SECONDS,
        sampleMs: SAMPLE_MS,
        settleMs: SETTLE_MS,
        floors: {
          presentedRateFraction: PRESENTED_RATE_FLOOR,
          presentedRatePerSecond: round(
            info.frameRate * PRESENTED_RATE_FLOOR,
            2,
          ),
          coverage: COVERAGE_FLOOR,
          taskCeilingMs: TASK_CEILING_MS,
        },
        ...measured,
      },
      failures,
    };
  } finally {
    await session
      .send("Emulation.setCPUThrottlingRate", { rate: 1 })
      .catch(() => {});
    await session.evaluate("window.__demoRenderer.pause(); 1").catch(() => {});
  }
}

async function measureStable(session, info, attempts) {
  let lastReason = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const navMark = session.navigations;
    try {
      await session.evaluate(
        `(async () => {
          const renderer = window.__demoRenderer;
          await renderer.seek(${SEEK_SECONDS});
          await renderer.play();
          return 1;
        })()`,
        { timeoutMs: 180_000 },
      );
      await delay(SETTLE_MS);
      /* Another tool's tab takes the foreground between the settle and the
       * window, and a background tab neither presents nor runs its sampler. */
      await session.send("Page.bringToFront");
      const raw = await session.readJson(SAMPLER, { timeoutMs: 120_000 });
      if (session.navigations !== navMark) {
        lastReason = "the page reloaded during the measurement window";
        await waitForRenderer(session);
        continue;
      }
      return summarize(raw, info);
    } catch (error) {
      if (session.navigations === navMark && !(error instanceof Invalid)) {
        throw error;
      }
      lastReason = error.message;
      if (session.navigations !== navMark) await waitForRenderer(session);
    }
  }
  throw new Invalid(`${lastReason} (after ${attempts} attempts)`);
}

function summarize(raw, info) {
  if (raw.visibility !== "visible") {
    throw new Invalid(
      `the demo tab was ${raw.visibility} during the window; a backgrounded ` +
        "tab presents no frames and runs no sampler",
    );
  }
  const { samples } = raw;
  if (samples.length < MIN_SAMPLES) {
    throw new Invalid(
      `the sampler collected ${samples.length} of the ${MIN_SAMPLES} readings ` +
        `a ${SAMPLE_MS}ms window owes; the page was starved of the main thread`,
    );
  }
  const first = samples[0];
  const last = samples.at(-1);
  const wallSeconds = (last.at - first.at) / 1000;
  const mediaSeconds = last.currentTime - first.currentTime;
  const renderCountDelta = last.renderCount - first.renderCount;
  if (
    first.playbackState === "playing" &&
    last.playbackState === "playing" &&
    mediaSeconds < wallSeconds * MIN_ADVANCE_RATIO &&
    renderCountDelta === 0
  ) {
    throw new Invalid(
      "decoder starvation: playback state stayed playing, the media clock " +
        "froze and nothing was rendered. Another tab holding the hardware " +
        "decoder sessions produces exactly this signature; close it and re-run.",
    );
  }

  const presentedRate = renderCountDelta / wallSeconds;
  const covered = samples.filter(
    (sample) => sample.detectionTime !== null,
  ).length;
  return {
    samples: samples.length,
    wallSeconds: round(wallSeconds, 2),
    mediaSeconds: round(mediaSeconds, 2),
    mediaRatio: round(mediaSeconds / wallSeconds, 3),
    playbackState: last.playbackState,
    presentedRate: round(presentedRate, 2),
    presentedRateFraction: round(presentedRate / info.frameRate, 3),
    coverage: round(covered / samples.length, 3),
    preparedAheadMedian: percentile(
      samples.map((sample) => sample.preparedAhead),
      0.5,
    ),
    preparedAheadMin: Math.min(
      ...samples.map((sample) => sample.preparedAhead),
    ),
    backlogMedian: percentile(
      samples.map((sample) => sample.backlog),
      0.5,
    ),
    backlogMax: Math.max(...samples.map((sample) => sample.backlog)),
    longTaskCount: raw.longTasks.length,
    longTaskMaxMs: raw.longTasks.length === 0 ? 0 : Math.max(...raw.longTasks),
    longTasksOverCeiling: raw.longTasks.filter(
      (duration) => duration > TASK_CEILING_MS,
    ).length,
  };
}

function judge(measured, info) {
  const failures = [];
  if (measured.presentedRateFraction < PRESENTED_RATE_FLOOR) {
    failures.push(
      `throttle: at ${THROTTLE_RATE}x the picture ran at ${measured.presentedRate}/s, ` +
        `${measured.presentedRateFraction} of the ${info.frameRate}fps source, ` +
        `under the ${PRESENTED_RATE_FLOOR} floor`,
    );
  }
  if (measured.coverage < COVERAGE_FLOOR) {
    failures.push(
      `throttle: at ${THROTTLE_RATE}x only ${measured.coverage} of sampled frames ` +
        `carried a detection, under the ${COVERAGE_FLOOR} floor`,
    );
  }
  if (measured.longTasksOverCeiling > 0) {
    failures.push(
      `throttle: at ${THROTTLE_RATE}x ${measured.longTasksOverCeiling} main-thread ` +
        `task(s) ran past ${TASK_CEILING_MS}ms, the longest ${measured.longTaskMaxMs}ms`,
    );
  }
  return failures;
}

export function throttleDetail(scenario, field) {
  const { floors } = scenario;
  return [
    field("throttle", `${scenario.throttleRate}x CPU slowdown`),
    field(
      "window",
      `${scenario.sampleMs}ms at t=${scenario.seekSeconds}s, ` +
        `${scenario.settleMs}ms settle, ${scenario.samples} readings`,
    ),
    field(
      "presented rate",
      `${scenario.presentedRate}/s of ${scenario.sourceRate}fps source ` +
        `(${scenario.presentedRateFraction}, floor ${floors.presentedRateFraction})`,
    ),
    field(
      "media advanced",
      `${scenario.mediaSeconds}s over ${scenario.wallSeconds}s ` +
        `(${scenario.mediaRatio})`,
    ),
    field(
      "annotation coverage",
      `${scenario.coverage}  (floor ${floors.coverage})`,
    ),
    field(
      "prepared ahead",
      `${scenario.preparedAheadMedian} frames median, ` +
        `${scenario.preparedAheadMin} min`,
    ),
    field(
      "cook backlog",
      `${scenario.backlogMedian} frames median, ${scenario.backlogMax} max`,
    ),
    field(
      "main-thread long tasks",
      `${scenario.longTaskCount} over 50ms, longest ${scenario.longTaskMaxMs}ms ` +
        `(ceiling ${floors.taskCeilingMs}ms)`,
    ),
  ];
}
