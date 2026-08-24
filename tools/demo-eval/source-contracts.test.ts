import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/* The defect here lives inside a React hook, and this repo has no DOM test
 * environment to render one in. What is left is the shape of the source, so
 * these read it: not for style, only for the one relationship the defect was
 * a violation of. If a refactor moves the mechanism, prove the invariant still
 * holds by other means before rewriting the assertion around it. */

const demoDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../demo/src",
);

const read = (file: string) => readFileSync(path.join(demoDir, file), "utf8");

/** The body of the block that opens at `opener`, brace-matched. */
function blockAfter(source: string, opener: string) {
  const start = source.indexOf(opener);
  expect(
    start,
    `expected to find ${JSON.stringify(opener)} in the source`,
  ).toBeGreaterThan(-1);
  let depth = 0;
  for (let at = start + opener.length - 1; at < source.length; at += 1) {
    if (source[at] === "{") depth += 1;
    if (source[at] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, at + 1);
    }
  }
  throw new Error(`block opened by ${opener} never closed`);
}

describe("the timeline drag release", () => {
  const file = read("components/TimelineView.tsx");
  const source = blockAfter(file, "}: TimelineSeekGestureOptions) {");

  /* The drag that never let go: release was keyed on the scrub position, and
   * the settle writer clears that position the moment the player reaches the
   * drag target, which during a drag is while the pointer is still down. The
   * release then early-returned, the producer was never told the gesture ended
   * and the engine stayed mechanically paused while the chip read Playing. */
  it("keys the release on the gesture, not on the scrub position", () => {
    const release = blockAfter(source, "const releaseSeek = () => {");
    expect(release).toContain("gestureActiveRef.current");
    expect(release).toContain("gestureActiveRef.current = false");
  });

  it("keeps the settle writer away from the gesture flag", () => {
    const settle = blockAfter(source, "useLiveReadoutWriter((readouts) => {");
    expect(settle).toContain("scrubTimeRef.current = null");
    expect(settle).not.toContain("gestureActiveRef");
  });

  it("raises the gesture flag when the drag starts", () => {
    const start = blockAfter(source, "onScrubStart(nextTime: number) {");
    expect(start).toContain("gestureActiveRef.current = true");
  });
});

/* The harness reaches the demo's controls through `data-eval` ids rather than
 * through class names and button text, because it once reached through those
 * and an upstream redesign moved them: three scenarios stopped measuring and
 * reported invalid-environment, which no gate treats as a failure. A run
 * resolves every id against the live page before it measures anything, so that
 * drift now goes red. These two check the halves agree without a browser. */
describe("the eval hook catalogue", () => {
  it("declares the same ids in the demo and in the harness", async () => {
    const demo = await import("../../demo/src/eval-hooks");
    const harness = await import("./hooks.mjs");

    expect([...harness.HOOKS].sort()).toEqual([...demo.DEMO_EVAL_HOOKS].sort());
  });

  it("stamps every declared id somewhere in the demo", async () => {
    const { DemoEvalHook } = await import("../../demo/src/eval-hooks");
    const components = path.join(demoDir, "components");
    const source = readdirSync(components)
      .filter((file) => file.endsWith(".tsx"))
      .map((file) => readFileSync(path.join(components, file), "utf8"))
      .join("\n");

    for (const name of Object.keys(DemoEvalHook)) {
      expect(source, `${name} is declared but nothing renders it`).toContain(
        `DemoEvalHook.${name}`,
      );
    }
  });
});

/* The harness drives the view the demo remembers by writing the demo's own
 * localStorage key before it measures anything. A renamed key leaves the
 * harness writing one nobody reads, and the run stays green while every number
 * comes from whichever view the last person left the tab in. */
describe("the demo view mode", () => {
  it("writes the key and the modes the demo reads", async () => {
    const demo = await import("../../demo/src/session/demo-view-mode");
    const harness = await import("./scenarios.mjs");

    expect(harness.VIEW_MODE_STORAGE_KEY).toEqual(
      demo.DEMO_VIEW_MODE_STORAGE_KEY,
    );
    expect([...harness.VIEW_MODES].sort()).toEqual(
      Object.values(demo.DemoViewMode).sort(),
    );
  });
});
