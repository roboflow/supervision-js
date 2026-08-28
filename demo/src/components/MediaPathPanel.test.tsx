import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { MediaPathPanel } from "./MediaPathPanel";
import { demoMediaPathCopy, demoMediaPathOrder } from "./media-path-copy";
import { DEMO_DEFAULT_MEDIA_PATH } from "../session/workbench-defaults";
import {
  DemoMediaPath,
  describeMissingSupport,
  optionSupported,
  type DemoOptionSupport,
} from "../session/session-options";

const NO_CHOICE_ON_AN_UPLOAD =
  "SAM3 reads its frames back out of the engine, so an upload always opens there.";

function render(support: DemoOptionSupport = optionSupported) {
  return MediaPathPanel.type({
    onChange: () => {},
    path: DemoMediaPath.Mediabunny,
    support,
  });
}

function buttons(node: ReactNode, found: ReactNode[] = []): ReactNode[] {
  if (Array.isArray(node)) {
    for (const child of node) {
      buttons(child, found);
    }
    return found;
  }

  if (!isValidElement<{ readonly children?: ReactNode }>(node)) {
    return found;
  }

  if (node.type === "button") {
    found.push(node);
    return found;
  }

  if (typeof node.type === "function") {
    return buttons(
      (node.type as (props: unknown) => ReactNode)(node.props as unknown),
      found,
    );
  }

  return buttons(node.props.children, found);
}

function prose(node: ReactNode): string {
  if (typeof node === "string") {
    return node;
  }

  if (Array.isArray(node)) {
    return node.map((child) => prose(child)).join(" ");
  }

  if (!isValidElement<{ readonly children?: ReactNode }>(node)) {
    return "";
  }

  if (typeof node.type === "function") {
    return prose(
      (node.type as (props: unknown) => ReactNode)(node.props as unknown),
    );
  }

  return prose(node.props.children);
}

describe("MediaPathPanel", () => {
  it("offers both readers without making the visitor switch to read the other", () => {
    const text = prose(render());

    for (const path of demoMediaPathOrder) {
      const copy = demoMediaPathCopy[path];

      expect(text).toContain(copy.label);
      expect(text).toContain(copy.summary);
      expect(text).toContain(copy.goodAt);
      expect(text).toContain(copy.costs);
      expect(text).toContain(copy.pickWhen);
    }
  });

  it("says which import reaches each one, because both come from one package", () => {
    const text = prose(render());

    for (const path of demoMediaPathOrder) {
      expect(text).toContain(demoMediaPathCopy[path].imports);
    }

    expect(text).toContain("supervision/web-video-engine");
  });

  it("marks the one a clip opens on", () => {
    expect(prose(render())).toContain("opens here");
    expect(demoMediaPathCopy[DEMO_DEFAULT_MEDIA_PATH].label).toBe("Mediabunny");
  });

  /* A choice that cannot be made stays on the page: a reader who cannot see
   * the option cannot learn why this session is on the path it is on. */
  it("keeps a blocked choice visible and says why it is blocked", () => {
    const blocked = render(describeMissingSupport(NO_CHOICE_ON_AN_UPLOAD));

    expect(buttons(blocked)).toHaveLength(demoMediaPathOrder.length);
    expect(prose(blocked)).toContain(NO_CHOICE_ON_AN_UPLOAD);
  });

  it("names the package rather than calling it the video engine", () => {
    const text = prose(render());

    expect(text).toContain("Web video engine");
    expect(
      /\bvideo engine\b/.test(text.replace(/web video engine/gi, "")),
    ).toBe(false);
  });
});
