import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { DemoShell } from "./DemoShell";
import { DemoViewMode } from "../session/demo-view-mode";

type ShellProps = Parameters<typeof DemoShell>[0];

const slots = [
  "benchmarksPanel",
  "controlBar",
  "performanceStrip",
  "pipelinePanel",
  "presentationDiagnostics",
  "qualityControls",
  "renderControls",
  "selectionPanel",
  "sessionOptionsPanel",
  "sourceControls",
  "statusPanel",
  "viewport",
] as const;

type DemoShellSlot = (typeof slots)[number];

function shellWith(mode: DemoViewMode) {
  const props = Object.fromEntries(
    slots.map((slot) => [slot, <b key={slot}>{slot}</b>]),
  ) as unknown as ShellProps;

  return DemoShell({
    ...props,
    docsUrl: "https://example.invalid",
    mode,
    onModeChange: () => {},
  });
}

function shown(mode: DemoViewMode) {
  const rendered = new Set(collect(shellWith(mode)));

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

const debugOnly: readonly DemoShellSlot[] = [
  "performanceStrip",
  "pipelinePanel",
  "presentationDiagnostics",
  "sessionOptionsPanel",
  "statusPanel",
];

describe("DemoShell", () => {
  it("shows the session options alongside the other Debug diagnostics", () => {
    const inDebug = shown(DemoViewMode.Debug);

    expect(debugOnly.filter((slot) => !inDebug.includes(slot))).toEqual([]);
    expect(inDebug).toContain("sourceControls");
  });

  it("leaves them out of the two views that are not Debug", () => {
    expect(
      shown(DemoViewMode.Demo).filter((slot) => debugOnly.includes(slot)),
    ).toEqual([]);
    expect(shown(DemoViewMode.Benchmarks)).toEqual(["benchmarksPanel"]);
  });
});
