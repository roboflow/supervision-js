/* The handles tools/demo-eval steers this demo by.
 *
 * That harness drives a real browser, so a control it cannot find is a
 * measurement it cannot take, and a scenario that cannot measure abstains
 * rather than fails. It reached for controls by class name and by button text
 * until a redesign moved both and three of its gates went quiet.
 *
 * tools/demo-eval/hooks.mjs declares the same ids, its
 * source-contracts.test.ts fails when the two lists disagree, and every run
 * resolves all of them against the live page before it measures anything.
 */

export const DemoEvalHook = {
  Shell: "shell",
  ViewportMount: "viewport-mount",
  TimelineInput: "timeline-input",
  TimelinePlayhead: "timeline-playhead",
  BenchmarksView: "view-mode:benchmarks",
  DemoView: "view-mode:demo",
  DebugView: "view-mode:debug",
  LayersSection: "section:layers",
  SegmentationSection: "section:segmentation",
  BoxesToggle: "toggle:boxes",
  MasksToggle: "toggle:masks",
  PolygonsToggle: "toggle:polygons",
  PolylinesToggle: "toggle:polylines",
  KeypointsToggle: "toggle:keypoints",
  LabelsToggle: "toggle:labels",
  FocusToggle: "toggle:focus",
  MaskBorderSlider: "slider:mask-border",
} as const;

export const DEMO_EVAL_HOOKS: readonly string[] = Object.values(DemoEvalHook);

/** Sources are demo data, so each one is named after the sample it loads. */
export function fixtureEvalHook(sampleName: string): string {
  return `fixture:${sampleName}`;
}

/**
 * The inspector column shows one tab at a time, so a control in another tab is
 * not in the DOM at all. The harness picks the tab that owns the control it is
 * about to drive.
 */
export function inspectorTabEvalHook(tab: string): string {
  return `inspector-tab:${tab}`;
}

/**
 * What the open session is running, stamped on the shell. The buttons that set
 * these live one to an inspector tab, and only the open tab is in the DOM.
 */
export const DemoEvalRunAttribute = {
  Fixture: "data-eval-fixture",
  FixtureLabel: "data-eval-fixture-label",
  MediaPath: "data-eval-media-path",
} as const;
