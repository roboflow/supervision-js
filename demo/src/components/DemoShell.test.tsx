import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { DemoShell } from "./DemoShell";
import { DemoEvalRunAttribute } from "../eval-hooks";
import { DemoInspectorTab } from "../session/inspector-tabs";
import { DemoViewMode } from "../session/demo-view-mode";

type ShellProps = Parameters<typeof DemoShell>[0];

const slots = [
  "benchmarksPanel",
  "controlBar",
  "libraryDeparturesPanel",
  "mediaPathPanel",
  "performanceStrip",
  "pipelinePanel",
  "presentationDiagnostics",
  "qualityControls",
  "renderControls",
  "selectionPanel",
  "sessionOptionsPanel",
  "slowWorkPanel",
  "sourceControls",
  "statusPanel",
  "viewport",
] as const;

type DemoShellSlot = (typeof slots)[number];

function shellWith(
  mode: DemoViewMode,
  tab: DemoInspectorTab,
  running: Pick<ShellProps, "clip"> = { clip: null },
) {
  const props = Object.fromEntries(
    slots.map((slot) => [slot, <b key={slot}>{slot}</b>]),
  ) as unknown as ShellProps;

  return DemoShell({
    ...props,
    ...running,
    departureCount: 3,
    docsUrl: "https://example.invalid",
    mode,
    onModeChange: () => {},
    onTabChange: () => {},
    tab,
  });
}

function shown(mode: DemoViewMode, tab: DemoInspectorTab) {
  const rendered = new Set(collect(shellWith(mode, tab)));

  return slots.filter((slot) => rendered.has(slot));
}

function collect(node: ReactNode, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) {
      collect(child, found);
    }
    return found;
  }

  if (!isValidElement<{ readonly children?: ReactNode }>(node)) {
    return found;
  }

  if (node.type === "b" && typeof node.props.children === "string") {
    found.push(node.props.children);
    return found;
  }

  return collect(node.props.children, found);
}

const diagnostics: readonly DemoShellSlot[] = [
  "performanceStrip",
  "pipelinePanel",
  "presentationDiagnostics",
  "slowWorkPanel",
  "statusPanel",
];

describe("DemoShell", () => {
  it("puts the session options in a tab of their own rather than behind Debug", () => {
    const inDemo = shown(DemoViewMode.Demo, DemoInspectorTab.Session);

    expect(inDemo).toContain("sessionOptionsPanel");
    expect(inDemo).toContain("mediaPathPanel");
    expect(inDemo).toContain("libraryDeparturesPanel");
  });

  it("shows one group at a time", () => {
    expect(shown(DemoViewMode.Demo, DemoInspectorTab.Clip)).toEqual([
      "controlBar",
      "selectionPanel",
      "sourceControls",
      "viewport",
    ]);
    expect(shown(DemoViewMode.Demo, DemoInspectorTab.Style)).toEqual([
      "controlBar",
      "qualityControls",
      "renderControls",
      "viewport",
    ]);
  });

  it("keeps the readings that cost main-thread work behind the Debug switch", () => {
    const off = shown(DemoViewMode.Demo, DemoInspectorTab.Diagnostics);
    const on = shown(DemoViewMode.Debug, DemoInspectorTab.Diagnostics);

    expect(diagnostics.filter((slot) => off.includes(slot))).toEqual([]);
    expect(diagnostics.filter((slot) => !on.includes(slot))).toEqual([]);
  });

  it("says what the switched-off diagnostics are and what turning them on costs", () => {
    const prose = flatten(
      shellWith(DemoViewMode.Demo, DemoInspectorTab.Diagnostics),
    );

    expect(prose).toContain("Diagnostics are off");
    expect(prose).toContain("ten points of");
  });

  it("leaves the inspector out of the benchmarks view", () => {
    expect(shown(DemoViewMode.Benchmarks, DemoInspectorTab.Clip)).toEqual([
      "benchmarksPanel",
    ]);
  });
});

function flatten(node: ReactNode): string {
  if (typeof node === "string") {
    return node;
  }

  if (Array.isArray(node)) {
    return node.map((child) => flatten(child)).join(" ");
  }

  if (!isValidElement<{ readonly children?: ReactNode }>(node)) {
    return "";
  }

  if (typeof node.type === "function") {
    return flatten(
      (node.type as (props: unknown) => ReactNode)(node.props as unknown),
    );
  }

  return flatten(node.props.children);
}

/* The eval harness reads the clip off the shell. The buttons that set it live
 * in one inspector tab, and only the open tab is in the DOM, so a run that read
 * the controls would record whichever tab it left showing. */
describe("what the shell says the session is running", () => {
  const running = { clip: { id: "horse_trail", label: "70s horse trail" } };

  it("names the clip in every view and every tab", () => {
    for (const mode of Object.values(DemoViewMode)) {
      for (const tab of Object.values(DemoInspectorTab)) {
        expect(shellWith(mode, tab, running).props).toMatchObject({
          [DemoEvalRunAttribute.Fixture]: "horse_trail",
          [DemoEvalRunAttribute.FixtureLabel]: "70s horse trail",
        });
      }
    }
  });

  it("names nothing when the session is not running a sample", () => {
    const shell = shellWith(DemoViewMode.Demo, DemoInspectorTab.Clip);

    expect(shell.props[DemoEvalRunAttribute.Fixture]).toBeUndefined();
  });
});
