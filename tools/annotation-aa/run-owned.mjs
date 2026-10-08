import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { CdpSession, listTargets } from "../demo-eval/cdp.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = new Set(process.argv.slice(2));
const anchorPath = process.env.CHROME_ANCHOR;
if (!anchorPath)
  throw Error("CHROME_ANCHOR must name the existing owned window anchor");
const anchor = JSON.parse(readFileSync(anchorPath, "utf8"));
const targetId = process.env.BENCH_TARGET ?? anchor.targetId;
const requestedHead = process.env.AA_HEAD;
if (!/^[0-9a-f]{40}$/.test(requestedHead ?? ""))
  throw Error("AA_HEAD must pin a full reviewed head");
const head = () =>
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
if (head() !== requestedHead) throw Error("reviewed head changed");
const url = process.env.AA_HARNESS_URL ?? "http://127.0.0.1:5277/";
const output = resolve(
  process.env.AA_OUTPUT ??
    resolve(root, "tools/annotation-aa/artifacts", `owned-${Date.now()}`),
);
const foreground = () =>
  execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim();
const beforeForeground = foreground();
const version = await globalThis
  .fetch(`${anchor.debugUrl}/json/version`)
  .then((r) => r.json());
if (version.webSocketDebuggerUrl !== anchor.browserSocket)
  throw Error("owned Chrome generation changed");
const pages = (await listTargets(anchor.debugUrl)).filter(
  (target) => target.type === "page",
);
const target = pages.find((page) => page.id === targetId);
if (!target)
  throw Error(
    "explicit owned target no longer exists; owner must refresh the anchor",
  );
const additionalPages = pages.filter((page) => page.id !== targetId);
if (additionalPages.length) {
  const inert = additionalPages.every((page) =>
    ["about:blank", "chrome://newtab/", "chrome://new-tab-page/"].includes(
      page.url,
    ),
  );
  if (
    !(args.has("--allow-inert-tabs") && inert) &&
    !(args.has("--pixels-only") && args.has("--allow-extra-pages"))
  )
    throw Error(
      "additional pages block this comparison; driver never closes them",
    );
}
const browser = await CdpSession.attach(version.webSocketDebuggerUrl);
let page;
try {
  const window = await browser.send("Browser.getWindowForTarget", { targetId });
  if (window.windowId !== anchor.windowId)
    throw Error("target belongs to a different window");
  page = await CdpSession.attach(target.webSocketDebuggerUrl);
  const environment = await page.evaluate(
    "({width:innerWidth,height:innerHeight,screenWidth:screen.width,screenHeight:screen.height,dpr:devicePixelRatio,visibility:document.visibilityState})",
  );
  const plan = {
    head: requestedHead,
    anchorPath,
    targetId,
    windowId: window.windowId,
    browserSocket: anchor.browserSocket,
    environment,
    additionalPages: additionalPages.map(({ id, url: pageUrl }) => ({
      id,
      url: pageUrl,
    })),
    harness: url,
    output,
    timings: !args.has("--pixels-only"),
  };
  if (!args.has("--run")) {
    console.log(JSON.stringify({ preparedOnly: true, ...plan }, null, 2));
  } else {
    if (environment.dpr !== anchor.dpr)
      throw Error(
        "actual native display differs from the current owned anchor",
      );
    if (environment.visibility !== "visible" && !args.has("--pixels-only"))
      throw Error(
        "owned target is hidden; do not activate it to force a timing run",
      );
    mkdirSync(output, { recursive: false });
    writeFileSync(
      resolve(output, "plan.json"),
      JSON.stringify(plan, null, 2) + "\n",
    );
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.evaluate(
      "globalThis.__demoRenderer?.pause();globalThis.__demoRenderer?.destroy();1",
    );
    await page.send("Page.navigate", { url });
    await page.evaluate(
      "(async()=>{for(let i=0;i<120;i++){if(typeof globalThis.runAnnotationAaPixels==='function')return true;await new Promise(r=>setTimeout(r,250));}throw Error('annotation AA harness failed to load');})()",
      { timeoutMs: 35000 },
    );
    const navigationMark = page.navigations;
    const patchMark = page.devServerPatches;
    const snapshots = [];
    for (const backend of ["webgpu", "webgl"]) {
      const report = await page.readJson(
        `runAnnotationAaPixels(${JSON.stringify(backend)},{timings:${!args.has("--pixels-only")}})`,
        { timeoutMs: 90000 },
      );
      report.driver = {
        ...plan,
        observedHeadAfter: head(),
        osForegroundBefore: beforeForeground,
        osForegroundAfter: foreground(),
        foregroundUnchanged: foreground() === beforeForeground,
      };
      snapshots.push(report);
      writeFileSync(
        resolve(output, `${backend}.json`),
        JSON.stringify(report, null, 2) + "\n",
      );
      console.log(
        JSON.stringify({
          backend,
          status: report.status,
          nativeDpr: report.nativeDpr,
          output: report.output,
          errors: report.errors,
          artifacts: report.artifacts,
          timingWindows: report.timing.length,
        }),
      );
      if (report.status !== "complete")
        throw Error(`${backend} pixel validation failed`);
      if (
        page.navigations !== navigationMark ||
        page.devServerPatches !== patchMark
      )
        throw Error("navigation or server patch during comparison");
      const finalPages = (await listTargets(anchor.debugUrl)).filter(
        (item) => item.type === "page",
      );
      if (
        JSON.stringify(finalPages.map((item) => item.id).sort()) !==
        JSON.stringify(pages.map((item) => item.id).sort())
      )
        throw Error("owned profile pages changed");
    }
    writeFileSync(
      resolve(output, "complete.json"),
      JSON.stringify(
        {
          ...plan,
          status: "complete",
          reports: snapshots.map((report) => report.backend.requested),
          unchangedForeground: foreground() === beforeForeground,
        },
        null,
        2,
      ) + "\n",
    );
  }
} finally {
  page?.close();
  browser.close();
}
