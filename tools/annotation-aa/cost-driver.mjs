import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { CdpSession, delay, listTargets } from "../demo-eval/cdp.mjs";
import { pinCostInputs } from "./cost-inputs.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = new Set(process.argv.slice(2));
const notes = process.env.AA_NOTES;
const anchorPath = process.env.CHROME_ANCHOR;
const output = process.env.AA_OUTPUT;
if (!notes || !anchorPath || !output)
  throw Error(
    "AA_NOTES, CHROME_ANCHOR and a new AA_OUTPUT directory are required",
  );
for (const key of ["PROFILE", "GPU_COVERAGE", "MASK_FRAME_COUNT"])
  if (process.env[key] && process.env[key] !== "0")
    throw Error(`extra instrumentation ${key} is forbidden in timed windows`);
const observerPath = resolve(
  notes,
  "hidpi-merged-bench-2026-10-06-resume/mask-observation-helper.mjs",
);
const gesturePath = resolve(
  notes,
  "human-gesture-capture-2026-10-06/human-gesture.json",
);
const corePath = resolve(
  notes,
  "human-gesture-capture-2026-10-06/gesture-core.mjs",
);
const replayPath = resolve(
  notes,
  "human-gesture-pr-videos-2026-10-06/replay-driver.mjs",
);
const { validateGesture } = await import(pathToFileURL(corePath));
const gesture = validateGesture(JSON.parse(readFileSync(gesturePath, "utf8")));
const inputs = pinCostInputs(
  root,
  process.env.AA_HEAD,
  [observerPath, gesturePath, corePath, replayPath],
  { allowDirty: !args.has("--run") },
);
const anchor = JSON.parse(readFileSync(anchorPath, "utf8"));
const targetId = process.env.BENCH_TARGET ?? anchor.targetId;
const url =
  process.env.AA_DEMO_URL ?? "http://127.0.0.1:5278/?mediaPath=engine";
const playSeconds = Number(process.env.AA_PLAY_SECONDS ?? 8);
if (
  !Number.isFinite(playSeconds) ||
  playSeconds < 3 ||
  playSeconds * 8 > gesture.context.duration * 0.95
)
  throw Error("playback window must stay within this Horse Trail clip at 8x");
const evidenceOnly = args.has("--mask-evidence");
const windows = [];
if (evidenceOnly) {
  for (const smooth of [false, true])
    windows.push({ pair: 1, workload: "scrub", cap: 1, smooth });
} else {
  for (const pair of [1, 2]) {
    const workloads =
      pair === 1 ? ["play1", "play8", "scrub"] : ["scrub", "play8", "play1"];
    for (const workload of workloads)
      for (const smooth of pair === 1 ? [false, true] : [true, false])
        windows.push({ pair, workload, cap: 1, smooth });
  }
  for (const smooth of [false, true])
    windows.push({ pair: 1, workload: "play8", cap: 2, smooth });
}
const plan = {
  at: new Date().toISOString(),
  root,
  url,
  anchorPath,
  anchor,
  targetId,
  output,
  evidenceOnly,
  windows,
  playSeconds,
  recordedGesture: {
    path: gesturePath,
    durationMs: gesture.durationMs,
    events: gesture.events.length,
  },
  inputs: inputs.snapshot,
  protocol: evidenceOnly
    ? "Separate detailed GPU mask/submission evidence. These instrumented windows are not CPU/RAM measurements. Counts include offscreen mask draws when the annotation filter captures the overlay."
    : "Headed real rendering, same committed/built bytes, two counterbalanced off/on pairs at output DPR1 for 1x,8x,human scrub, plus one DPR2 8x pair. CPU/RSS windows use only a small rAF state sampler. No tracing, screenshots, readback, profiler or GPU/worker hooks.",
};
if (!args.has("--run")) {
  console.log(
    JSON.stringify(
      {
        preparedOnly: true,
        output,
        windows,
        head: inputs.snapshot.head,
        dirty: inputs.snapshot.dirty,
        sourceFingerprint: inputs.snapshot.sourceFingerprint,
        compiledFingerprint: inputs.snapshot.compiledFingerprint,
        protocol: plan.protocol,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
inputs.validate();
mkdirSync(output, { recursive: false });
const save = (name, value) =>
  writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
  });
save("plan.json", plan);
const foreground = () =>
  execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim();
const version = await globalThis
  .fetch(`${anchor.debugUrl}/json/version`)
  .then((response) => response.json());
if (version.webSocketDebuggerUrl !== anchor.browserSocket)
  throw Error("owned browser generation changed");
const browser = await CdpSession.attach(anchor.browserSocket);
let page, sampler;
const processes = async () =>
  (await browser.send("SystemInfo.getProcessInfo")).processInfo;
const resident = async () => {
  const rows = await processes();
  const pids = rows.map((row) => Number(row.id)).filter((pid) => pid > 0);
  const raw = execFileSync("ps", ["-p", pids.join(","), "-o", "pid=,rss="], {
    encoding: "utf8",
  });
  const sizes = new Map(
    raw
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number)),
  );
  return rows.map((row) => ({
    ...row,
    rssMiB: (sizes.get(Number(row.id)) ?? 0) / 1024,
  }));
};
const identity = (rows) =>
  rows
    .filter((row) => Number(row.id) > 0)
    .map((row) => `${row.id}:${row.type}`)
    .sort();
const verifyPages = async () => {
  const pages = (await listTargets(anchor.debugUrl)).filter(
    (target) => target.type === "page",
  );
  if (pages.length !== 1 || pages[0].id !== targetId)
    throw Error(
      "additional/changed profile pages block measurement; driver never closes them",
    );
  const window = await browser.send("Browser.getWindowForTarget", { targetId });
  if (window.windowId !== anchor.windowId)
    throw Error("owned target moved to another window");
  return pages[0];
};
const ev = (source) => page.evaluate(source, { timeoutMs: 40000 });
const verifyGeometry = async (expected) => {
  const actual = await ev(
    "({width:innerWidth,height:innerHeight,screenWidth:screen.width,screenHeight:screen.height,dpr:devicePixelRatio,visibility:document.visibilityState})",
  );
  for (const [key, value] of Object.entries(expected))
    if (actual[key] !== value)
      throw Error(`native display/visibility changed: ${key}`);
  return actual;
};
const spawnReplay = async (name, timeline) => {
  const configPath = resolve(output, `${name}-input-config.json`);
  const reportPath = resolve(output, `${name}-input.json`);
  save(`${name}-input-config.json`, {
    gesturePath,
    timeline,
    webSocketDebuggerUrl: pageSocket,
    reportPath,
  });
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, [replayPath, configPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let error = "";
    child.stderr.on("data", (bytes) => {
      error += bytes.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? done()
        : reject(Error(`human replay failed (${code}): ${error}`)),
    );
  });
  return JSON.parse(readFileSync(reportPath, "utf8"));
};
let pageSocket;
const results = [];
try {
  const target = await verifyPages();
  pageSocket = target.webSocketDebuggerUrl;
  page = await CdpSession.attach(pageSocket);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Network.enable");
  await page.send("Performance.enable");
  await page.send("Network.setCacheDisabled", { cacheDisabled: true });
  const geometry = await verifyGeometry({
    width: anchor.width,
    height: anchor.height,
    dpr: anchor.dpr,
    visibility: "visible",
  });
  if (geometry.dpr !== 2)
    throw Error("this compact plan requires the current verified native DPR2");
  if (evidenceOnly) {
    const { maskObservationSource } = await import(pathToFileURL(observerPath));
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: maskObservationSource({ recordLimit: 20000 }),
    });
  }
  for (const window of windows) {
    const name = `${window.workload}-cap${window.cap}-pair${window.pair}-${window.smooth ? "on" : "off"}`;
    console.error(
      `[annotation-aa] ${name}${evidenceOnly ? " mask-evidence" : ""}`,
    );
    inputs.validate();
    await verifyPages();
    await ev(
      "globalThis.__demoRenderer?.pause();globalThis.__demoRenderer?.destroy();1",
    );
    const token = `${Date.now()}-${name}`;
    await ev(`globalThis.__aaNavigationToken=${JSON.stringify(token)};1`);
    await page.send("Page.navigate", { url });
    await ev(
      `(async()=>{for(let i=0;i<160;i++){const r=globalThis.__demoRenderer;if(globalThis.__aaNavigationToken!==${JSON.stringify(token)}&&location.href===${JSON.stringify(url)}&&r?.getState().duration>0&&r.getState().playbackState==='playing'){await r.pause();return true;}await new Promise(r=>setTimeout(r,150));}throw Error('fresh renderer did not finish its opening autoplay');})()`,
    );
    const setup = await ev(
      `(${configure.toString()})(${JSON.stringify(window)})`,
    );
    await delay(1200);
    const environment = await ev(`(${readEnvironment.toString()})()`);
    await verifyGeometry(geometry);
    const parked = environment.initialState;
    if (
      parked.playbackState !== "paused" ||
      parked.seeking ||
      parked.scrubbing ||
      parked.maskHeldStale ||
      parked.presentedTime == null ||
      Math.abs(parked.presentedTime) > 0.034 ||
      Math.abs(parked.currentTime) > 0.05 ||
      parked.activeDetectionFrameTime == null ||
      parked.drawnMaskFrameTime == null ||
      Math.abs(parked.activeDetectionFrameTime - parked.presentedTime) >
        0.034 ||
      Math.abs(parked.drawnMaskFrameTime - parked.activeDetectionFrameTime) >
        0.0005
    )
      throw Error(
        `clean paused start frame/mask alignment did not settle: ${JSON.stringify(parked)}`,
      );
    if (
      environment.fixture !== "horse_trail" ||
      environment.mediaPath !== "engine" ||
      environment.backend !== "webgpu"
    )
      throw Error(
        `unexpected clip/path/backend: ${JSON.stringify(environment)}`,
      );
    const effectiveDpr = Math.min(geometry.dpr, window.cap);
    const mediaCanvas = environment.canvases.filter(
      (canvas) => canvas.cssWidth > 100 && canvas.cssHeight > 100,
    );
    if (mediaCanvas.length !== 1)
      throw Error("expected one visible Pixi media canvas");
    const canvas = mediaCanvas[0];
    if (
      Math.abs(canvas.width - canvas.cssWidth * effectiveDpr) > 3 ||
      Math.abs(canvas.height - canvas.cssHeight * effectiveDpr) > 3
    )
      throw Error("canvas backing pixels differ from the requested output DPR");
    if (
      !environment.packageScripts.some(
        (path) =>
          path === `/@fs${root.replace(/\/$/, "")}/packages/web/dist/index.js`,
      )
    )
      throw Error("demo did not load the pinned worktree's built web package");
    const beforeForeground = foreground();
    const nav = page.navigations,
      patch = page.devServerPatches;
    const memorySamples = [];
    let pendingSample = Promise.resolve(),
      sampling = false,
      sampleError;
    const metricsBefore = (await page.send("Performance.getMetrics")).metrics;
    const memoryBefore = evidenceOnly ? null : await resident();
    if (!evidenceOnly)
      sampler = setInterval(() => {
        if (sampling) return;
        sampling = true;
        pendingSample = resident()
          .then((rows) =>
            memorySamples.push({
              atHostMs: performance.now(),
              rssMiB: rows.reduce((sum, row) => sum + row.rssMiB, 0),
              processes: rows,
            }),
          )
          .catch((error) => {
            sampleError ??= error;
          })
          .finally(() => {
            sampling = false;
          });
      }, 500);
    await ev(
      `(${installStateSampler.toString()})(${JSON.stringify(geometry)})`,
    );
    if (evidenceOnly)
      await ev(
        "__maskObservation.begin('human-scrub',{maskPaintEnabled:true});1",
      );
    const processBefore = evidenceOnly ? null : await processes();
    const started = performance.now();
    let input;
    if (window.workload === "scrub")
      input = await spawnReplay(name, environment.timeline);
    else
      await ev(
        `(async()=>{await __demoRenderer.play();await new Promise(r=>setTimeout(r,${playSeconds * 1000}));return true;})()`,
      );
    const elapsedMs = performance.now() - started;
    const processAfter = evidenceOnly ? null : await processes();
    clearInterval(sampler);
    sampler = undefined;
    await pendingSample;
    if (sampleError) throw sampleError;
    const behavior = await page.readJson("__aaCostSampler.end()", {
      timeoutMs: 15000,
    });
    const maskEvidence = evidenceOnly
      ? await page.readJson("__maskObservation.end()", { timeoutMs: 15000 })
      : null;
    await ev("__demoRenderer.pause();1");
    const memoryAfter = evidenceOnly ? null : await resident();
    const metricsAfter = (await page.send("Performance.getMetrics")).metrics;
    const afterForeground = foreground();
    if (beforeForeground !== afterForeground)
      throw Error("OS foreground changed; this window cannot be compared");
    if (behavior.hiddenSamples || behavior.nativeDisplayChangedSamples)
      throw Error("real rendering became hidden or native display changed");
    behavior.lowRafCadence = behavior.rows.length < (elapsedMs / 1000) * 20;
    if (page.navigations !== nav || page.devServerPatches !== patch)
      throw Error("navigation/development patch during measurement");
    await verifyPages();
    await verifyGeometry(geometry);
    inputs.validate();
    let cpu = null;
    if (!evidenceOnly) {
      if (
        JSON.stringify(identity(processBefore)) !==
        JSON.stringify(identity(processAfter))
      )
        throw Error("Chrome process set changed during CPU timing");
      const initial = new Map(processBefore.map((row) => [row.id, row]));
      cpu = processAfter.map((row) => ({
        pid: row.id,
        type: row.type,
        cpuSeconds: row.cpuTime - initial.get(row.id).cpuTime,
        percentCore:
          ((row.cpuTime - initial.get(row.id).cpuTime) * 100000) / elapsedMs,
      }));
    } else if (
      !maskEvidence.gpuAvailable ||
      maskEvidence.oracleFrames === 0 ||
      maskEvidence.droppedRecords
    )
      throw Error("GPU mask evidence/oracle incomplete");
    const result = {
      status: "complete",
      ...window,
      name,
      elapsedMs,
      effectiveDpr,
      nativeDpr: geometry.dpr,
      setup,
      environment,
      behavior,
      input,
      maskEvidence,
      cpu,
      cpuTotal: cpu?.reduce((sum, row) => sum + row.percentCore, 0) ?? null,
      memoryBefore,
      memoryAfter,
      memorySamples,
      peakResidentMiB: evidenceOnly
        ? null
        : Math.max(
            ...[memoryBefore, memoryAfter].map((rows) =>
              rows.reduce((sum, row) => sum + row.rssMiB, 0),
            ),
            ...memorySamples.map((sample) => sample.rssMiB),
          ),
      residentDefinition:
        "Sum of OS resident memory (RSS) for this isolated Chrome process set. It includes Chrome/GPU-process overhead and may count shared pages more than once; it is not exact VRAM or total system memory.",
      metricsBefore,
      metricsAfter,
      foregroundUnchanged: true,
      presentationDefinition:
        "Cheap samples of the renderer's committed media clock, render counter and drawn-mask timestamp. Distinct source-clock changes are reported separately from mask presence. This is not optical display-frame capture.",
    };
    save(`${name}.json`, result);
    results.push(result);
    console.log(
      JSON.stringify({
        name,
        cpuTotal: result.cpuTotal,
        peakResidentMiB: result.peakResidentMiB,
        sourceHz: behavior.summary.distinctSourceHz,
        observedMasks: behavior.summary.alignedMaskSourceSamples,
        maskProof: maskEvidence?.summary ?? null,
      }),
    );
  }
  save("complete.json", {
    status: "complete",
    head: inputs.snapshot.head,
    results: results.map((result) => result.name),
    inputsUnchanged: true,
  });
} catch (error) {
  save("failed.json", {
    status: "failed",
    error: String(error),
    completed: results.map((result) => result.name),
  });
  throw error;
} finally {
  clearInterval(sampler);
  if (page) {
    await ev(
      "globalThis.__demoRenderer?.pause();globalThis.__demoRenderer?.destroy();1",
    ).catch(() => {});
    await page.send("Page.navigate", { url: "about:blank" }).catch(() => {});
    page.close();
  }
  browser.close();
}

async function configure(window) {
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  const click = (selector) => {
    const control = document.querySelector(selector);
    if (!control || control.disabled)
      throw Error(`missing/disabled control ${selector}`);
    control.click();
  };
  const byText = (text) => {
    const button = [...document.querySelectorAll("button")].find(
      (item) => item.textContent.trim() === text,
    );
    if (!button) throw Error(`missing button ${text}`);
    button.click();
  };
  click('[data-eval="view-mode:demo"]');
  click('[data-eval="inspector-tab:style"]');
  await wait(100);
  byText("Global");
  await wait(80);
  const layers = document.querySelector('[data-eval="section:layers"]');
  if (!layers) throw Error("global Layers section missing");
  if (layers.getAttribute("aria-expanded") === "false") layers.click();
  await wait(80);
  const smoothing = document.querySelector(
    '[aria-label="Smooth annotation edges"]',
  );
  if (!smoothing || smoothing.disabled)
    throw Error("shared annotation edge control missing");
  if (smoothing.tagName === "SELECT") {
    const value = window.smooth ? "fxaa-2" : "off";
    if (smoothing.value !== value) {
      const setter = Object.getOwnPropertyDescriptor(
        globalThis.HTMLSelectElement.prototype,
        "value",
      ).set;
      setter.call(smoothing, value);
      smoothing.dispatchEvent(
        new globalThis.Event("change", { bubbles: true }),
      );
    }
  } else if (smoothing.checked !== window.smooth) smoothing.click();
  await wait(100);
  if (
    (smoothing.tagName === "SELECT"
      ? smoothing.value !== "off"
      : smoothing.checked) !== window.smooth
  )
    throw Error("shared annotation edge toggle rejected value");
  const quality = document.querySelector(".quality-controls");
  const unlimited = quality?.querySelector('input[type="checkbox"]');
  if (!unlimited) throw Error("quality ceiling control missing");
  if (unlimited.checked) unlimited.click();
  await wait(80);
  const cap = quality.querySelector('input[type="number"]');
  if (!cap || cap.disabled) throw Error("quality cap unavailable");
  Object.getOwnPropertyDescriptor(
    globalThis.HTMLInputElement.prototype,
    "value",
  ).set.call(cap, String(window.cap));
  cap.dispatchEvent(new globalThis.Event("input", { bubbles: true }));
  await wait(100);
  if (Number(cap.value) !== window.cap)
    throw Error("quality cap rejected value");
  click('[data-eval="view-mode:debug"]');
  click('[data-eval="inspector-tab:diagnostics"]');
  await wait(100);
  const old = globalThis.__demoRenderer;
  byText("Reopen the clip");
  for (let attempt = 0; attempt < 160; attempt++) {
    await wait(150);
    if (
      globalThis.__demoRenderer !== old &&
      globalThis.__demoRenderer?.getState().duration > 0 &&
      globalThis.__demoRenderer.getState().playbackState === "playing"
    )
      break;
    if (attempt === 159)
      throw Error("reopened renderer did not finish its opening autoplay");
  }
  const renderer = globalThis.__demoRenderer;
  const opened = renderer.getState();
  await renderer.pause();
  renderer.setPlaybackRate(window.workload === "play8" ? 8 : 1);
  await renderer.seek(0);
  click('[data-eval="view-mode:demo"]');
  click('[data-eval="inspector-tab:clip"]');
  return {
    smooth: window.smooth,
    cap: window.cap,
    reopened: true,
    openingPlaybackState: opened.playbackState,
    openingPresentedTime: opened.presentedTime,
    startTime: renderer.getState().currentTime,
    rate: renderer.getState().playbackRate,
  };
}

function readEnvironment() {
  const timeline = document
    .querySelector('[data-eval="timeline-input"]')
    ?.getBoundingClientRect();
  if (!timeline) throw Error("timeline geometry unavailable");
  const state = globalThis.__demoRenderer.getState();
  return {
    fixture: document.querySelector("[data-eval-fixture]")?.dataset.evalFixture,
    mediaPath: document.querySelector("[data-eval-media-path]")?.dataset
      .evalMediaPath,
    backend: state.rendererBackend,
    canvases: [...document.querySelectorAll("canvas")].map((canvas) => ({
      width: canvas.width,
      height: canvas.height,
      cssWidth: canvas.clientWidth,
      cssHeight: canvas.clientHeight,
    })),
    timeline: {
      x: timeline.x,
      y: timeline.y,
      width: timeline.width,
      height: timeline.height,
    },
    packageScripts: performance
      .getEntriesByType("resource")
      .map((entry) =>
        decodeURIComponent(new globalThis.URL(entry.name).pathname),
      )
      .filter((path) => path.includes("/packages/") && path.includes("/dist/")),
    maskCache: globalThis.__demoRenderPrep,
    initialState: state,
  };
}

function installStateSampler(geometry) {
  const rows = [],
    caches = [],
    warnings = [];
  let active = true,
    frame,
    lastCacheAt = -Infinity,
    hiddenSamples = 0,
    nativeDisplayChangedSamples = 0;
  const startedAt = performance.now();
  const before = globalThis.__demoRenderer.getState();
  const initialRenderCount = globalThis.__demoRenderer.getRenderCount();
  const warn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
    warn(...args);
  };
  const tick = () => {
    if (!active) return;
    const at = performance.now();
    const renderer = globalThis.__demoRenderer;
    const state = renderer.getState();
    hiddenSamples += document.visibilityState !== "visible" ? 1 : 0;
    nativeDisplayChangedSamples +=
      globalThis.devicePixelRatio !== geometry.dpr ||
      globalThis.innerWidth !== geometry.width ||
      globalThis.innerHeight !== geometry.height ||
      globalThis.screen.width !== geometry.screenWidth ||
      globalThis.screen.height !== geometry.screenHeight
        ? 1
        : 0;
    rows.push({
      at,
      time: state.presentedTime,
      frames: state.presentedFrames,
      renderCount: renderer.getRenderCount(),
      detectionTime: state.activeDetectionFrameTime,
      maskTime: state.drawnMaskFrameTime,
      maskHeldStale: state.maskHeldStale,
      playbackState: state.playbackState,
    });
    if (at - lastCacheAt >= 500) {
      lastCacheAt = at;
      caches.push({
        at,
        artifacts: globalThis.__demoRenderPrep?.artifacts.map(
          ({
            kind,
            preparedCount,
            preparedBytes,
            maxPreparedBytes,
            maxPreparedCount,
            coarseCount,
            pendingCount,
            prefetchCount,
            window,
          }) => ({
            kind,
            preparedCount,
            preparedBytes,
            maxPreparedBytes,
            maxPreparedCount,
            coarseCount,
            pendingCount,
            prefetchCount,
            window,
          }),
        ),
      });
    }
    frame = globalThis.requestAnimationFrame(tick);
  };
  frame = globalThis.requestAnimationFrame(tick);
  globalThis.__aaCostSampler = {
    end() {
      active = false;
      globalThis.cancelAnimationFrame(frame);
      console.warn = warn;
      const endedAt = performance.now(),
        final = globalThis.__demoRenderer.getState();
      const distinct = [];
      let previous;
      for (const row of rows)
        if (row.time != null && row.time !== previous) {
          distinct.push(row);
          previous = row.time;
        }
      const gaps = distinct
        .slice(1)
        .map((row, index) => row.at - distinct[index].at)
        .sort((a, b) => a - b);
      const aligned = distinct.filter(
        (row) =>
          row.maskTime != null &&
          row.detectionTime != null &&
          Math.abs(row.maskTime - row.detectionTime) < 0.0005,
      );
      return {
        startedAt,
        endedAt,
        rows,
        caches,
        warnings,
        hiddenSamples,
        nativeDisplayChangedSamples,
        initial: before,
        final,
        summary: {
          elapsedMs: endedAt - startedAt,
          samples: rows.length,
          distinctSourceTimes: distinct.length,
          distinctSourceHz: (distinct.length * 1000) / (endedAt - startedAt),
          sourceGapP95Ms: gaps.length
            ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95))]
            : null,
          sourceGapMaxMs: gaps.length ? gaps.at(-1) : null,
          renderSubmissions:
            globalThis.__demoRenderer.getRenderCount() - initialRenderCount,
          committedMediaFrames: final.presentedFrames - before.presentedFrames,
          alignedMaskSourceSamples: aligned.length,
          sourceSamplesWithoutMaskStamp: distinct.filter(
            (row) => row.maskTime == null,
          ).length,
          maskHeldStaleSourceSamples: distinct.filter(
            (row) => row.maskHeldStale,
          ).length,
        },
      };
    },
  };
  return true;
}
