import { describe, expect, it } from "vitest";

/* The harness reaches the demo's controls through `data-eval` ids rather than
 * through class names and button text, because it once reached through those
 * and an upstream redesign moved them: three scenarios stopped measuring and
 * reported invalid-environment, which no gate treats as a failure. A run
 * resolves every id against the live page before it measures anything, so that
 * drift now goes red. This checks the halves agree without a browser. */
describe("the eval hook catalogue", () => {
  it("declares the same ids in the demo and in the harness", async () => {
    const demo = await import("../../demo/src/eval-hooks");
    const harness = await import("./hooks.mjs");

    expect([...harness.HOOKS].sort()).toEqual([...demo.DEMO_EVAL_HOOKS].sort());
  });
});

/* The inspector column shows one tab at a time, so a control in another tab is
 * not in the DOM at all. The harness visits every tab before it decides a hook
 * has gone missing, and picks the one that owns the layer toggles before it
 * drives them. A tab this list does not name is a tab the harness never opens,
 * and every hook inside it reads as missing. */
describe("the inspector tabs", () => {
  it("names the same tabs the demo renders", async () => {
    const demo = await import("../../demo/src/session/inspector-tabs");
    const harness = await import("./hooks.mjs");

    expect([...harness.INSPECTOR_TABS].sort()).toEqual(
      Object.values(demo.DemoInspectorTab).sort(),
    );
    expect([...harness.INSPECTOR_TABS]).toContain(harness.CONTROLS_TAB);
    expect([...harness.INSPECTOR_TABS]).toContain(harness.SOURCE_TAB);
  });
});

/* Which clip a run measured, and which reader opened it, are the two facts a
 * later comparison cannot recover and cannot see in a millisecond. The demo
 * states both on the shell, which is mounted in every view and every tab; the
 * buttons that set them are each mounted in one tab only. */
describe("what the shell says the run is", () => {
  it("reads the attributes the demo stamps", async () => {
    const demo = await import("../../demo/src/eval-hooks");
    const harness = await import("./hooks.mjs");

    expect(harness.RUN_ATTRIBUTE).toEqual({ ...demo.DemoEvalRunAttribute });
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
