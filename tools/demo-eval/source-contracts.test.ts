import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/* Two defects here live inside React hooks, and this repo has no DOM test
 * environment to render one in. What is left is the shape of the source, so
 * these read it: not for style, only for the one relationship each defect was
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

  /* Moving the playhead by a layout property invalidates the whole control bar
   * once per presented frame, which measured as the entire main-thread paint
   * load during playback. */
  it("moves the playhead by transform and never by a layout property", () => {
    const write = blockAfter(
      file,
      "const writePlayhead = (readouts: LiveReadouts, visualDuration: number) => {",
    );
    expect(write).toContain("playhead.style.transform");
    expect(write).not.toMatch(/playhead\.style\.(left|right|width|marginLeft)/);
  });
});

describe("the player shortcuts", () => {
  const source = read("components/PlayerHotkeys.tsx");

  /* Clicking a layer checkbox leaves it holding focus. Treating every focused
   * input as a typing surface retired every shortcut the hint bar advertises
   * until the page was clicked somewhere else. */
  it("does not treat a clicked control as somewhere the user is typing", () => {
    const nonTyping = blockAfter(source, "new Set([");
    for (const type of ["button", "checkbox", "radio", "range"]) {
      expect(nonTyping).toContain(`"${type}"`);
    }
  });

  /* A player's keys have to answer while the pointer is somewhere else. */
  it("listens on the window rather than on a focused control", () => {
    expect(source).toContain('window.addEventListener("keydown", onKeyDown)');
    expect(source).toContain(
      'window.removeEventListener("keydown", onKeyDown)',
    );
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
