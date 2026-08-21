/* The handles this harness steers the demo by, stamped as `data-eval`
 * attributes by demo/src/eval-hooks.ts.
 *
 * Reaching for controls by class name and by button text left three scenarios
 * abstaining with invalid-environment once a redesign moved both, and an
 * abstention is not a failure, so nothing said a gate had stopped running.
 * source-contracts.test.ts fails when these ids and the demo's disagree, and a
 * run resolves every one of them against the live page before it measures
 * anything, so the same drift arrives with a name on it.
 */

export const Hook = {
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
};

export const HOOKS = Object.values(Hook);

/** The report and the baseline key layers by the name the demo shows. */
export const LAYER_TOGGLE_HOOKS = {
  Boxes: Hook.BoxesToggle,
  Masks: Hook.MasksToggle,
  Polygons: Hook.PolygonsToggle,
  Polylines: Hook.PolylinesToggle,
  Keypoints: Hook.KeypointsToggle,
  Labels: Hook.LabelsToggle,
  Focus: Hook.FocusToggle,
};

export const VIEW_MODE_HOOKS = {
  benchmarks: Hook.BenchmarksView,
  debug: Hook.DebugView,
  demo: Hook.DemoView,
};

/**
 * Sections whose body is unmounted while they are collapsed, which is where
 * the layer toggles and the mask border slider live.
 */
export const COLLAPSIBLE_SECTIONS = [
  Hook.LayersSection,
  Hook.SegmentationSection,
];

export const FIXTURE_PREFIX = "fixture:";
export const VIEW_MODE_PREFIX = "view-mode:";

/** A CSS selector for one hook, ready to drop into a page-side snippet. */
export function at(hook) {
  return JSON.stringify(`[data-eval=${JSON.stringify(hook)}]`);
}

/** A CSS selector matching every hook sharing a prefix. */
export function startingAt(prefix) {
  return JSON.stringify(`[data-eval^=${JSON.stringify(prefix)}]`);
}

export function layerToggleSelector(label) {
  const hook = LAYER_TOGGLE_HOOKS[label];
  if (!hook) throw new Error(`no layer toggle hook is declared for "${label}"`);
  return at(hook);
}

export function viewModeSelector(mode) {
  const hook = VIEW_MODE_HOOKS[mode];
  if (!hook) throw new Error(`no view mode hook is declared for "${mode}"`);
  return at(hook);
}

export function fixtureHook(sampleName) {
  return `${FIXTURE_PREFIX}${sampleName}`;
}

const MISSING_HOOKS = `${JSON.stringify(HOOKS)}
  .filter((hook) => !document.querySelector('[data-eval="' + hook + '"]'))`;

const OPEN_SECTIONS = `(() => {
  const opened = [];
  for (const hook of ${JSON.stringify(COLLAPSIBLE_SECTIONS)}) {
    const button = document.querySelector('[data-eval="' + hook + '"]');
    if (button && button.getAttribute("aria-expanded") !== "true") {
      button.click();
      opened.push(hook);
    }
  }
  return opened;
})()`;

/**
 * A collapsed section renders no body, so its controls are absent rather than
 * hidden. They are left open for the whole run: collapsing them again between
 * reads would re-render the panel immediately before a sample. Returning to
 * the Demo view mounts a fresh panel, so scenarios that change view call this
 * again afterwards.
 */
export function openControlSections(session) {
  return session.readJson(OPEN_SECTIONS);
}

/** The hooks the demo is no longer stamping, in the order this file names them. */
export function missingHooks(session) {
  return session.readJson(`(() => ${MISSING_HOOKS})()`);
}
