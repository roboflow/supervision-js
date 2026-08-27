import { isValidElement, type ReactElement, type ReactNode } from "react";
import {
  MediaErrorKind,
  MediaSessionActivityKind,
  MediaSessionActivityStatus,
  MediaSessionStatus,
  type MediaSessionState,
} from "supervision";
import { describe, expect, it, vi } from "vitest";

import { createDemoStage } from "../hooks/useDemoRenderer";
import { RendererViewport } from "./RendererViewport";
import { createViewportOverlay } from "./viewport-overlay";

type ViewportRef = (element: HTMLDivElement | null) => (() => void) | void;

interface ViewportNodeProps {
  readonly children?: ReactNode;
  readonly className?: string;
  readonly ref?: ViewportRef;
}

interface StubElement {
  readonly children: StubElement[];
  readonly name: string;
  readonly style: Record<string, string>;
  parent: StubElement | null;
  appendChild(child: StubElement): void;
  remove(): void;
}

function stubElement(name: string): StubElement {
  const element: StubElement = {
    children: [],
    name,
    parent: null,
    style: {},
    appendChild(child) {
      detach(child);
      child.parent = element;
      element.children.push(child);
    },
    remove() {
      detach(element);
    },
  };

  return element;
}

function detach(element: StubElement) {
  const parent = element.parent;

  if (!parent) {
    return;
  }

  parent.children.splice(parent.children.indexOf(element), 1);
  element.parent = null;
}

function asElement(element: StubElement) {
  return element as unknown as HTMLDivElement;
}

function renderViewport(
  containerRef: ViewportRef,
  status = "opening 70s horse trail",
  sessionState: MediaSessionState | null = null,
) {
  return RendererViewport.type({
    containerRef,
    explained: true,
    overlay: createViewportOverlay(sessionState, null, {
      errorMessage: null,
      status,
    }),
  });
}

function erroredSession(
  errorMessage: string,
  errorKind: MediaErrorKind | null = null,
): MediaSessionState {
  return {
    activities: [
      {
        blockingPlayback: true,
        blockingPresentation: true,
        errorKind,
        errorMessage,
        kind: MediaSessionActivityKind.Error,
        label: "Renderer error",
        status: MediaSessionActivityStatus.Error,
      },
    ],
    errorMessage,
    media: { inputMetadata: null, normalizedMedia: null, objectUrl: null },
    normalization: null,
    playbackBlocked: true,
    presentationBlocked: true,
    renderPreparation: null,
    renderer: null,
    status: MediaSessionStatus.Error,
  };
}

function collectRefs(
  node: ReactNode,
  found: ReactElement<ViewportNodeProps>[],
) {
  if (Array.isArray(node)) {
    for (const child of node) {
      collectRefs(child, found);
    }
    return found;
  }

  if (!isValidElement<ViewportNodeProps>(node)) {
    return found;
  }

  if (node.props.ref) {
    found.push(node);
  }

  return collectRefs(node.props.children, found);
}

function findMountRef(tree: ReactNode) {
  const refs = collectRefs(tree, []);

  expect(refs).toHaveLength(1);
  expect(refs[0].props.className).toBe("renderer-viewport__mount");

  const ref = refs[0].props.ref;

  if (!ref) {
    throw new Error("the viewport rendered no mount point");
  }

  return ref;
}

function findOverlay(node: ReactNode): ReactElement<ViewportNodeProps> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const overlay = findOverlay(child);
      if (overlay) {
        return overlay;
      }
    }
    return null;
  }

  if (!isValidElement<ViewportNodeProps>(node)) {
    return null;
  }

  if (node.props.className?.startsWith("renderer-viewport__overlay ")) {
    return node;
  }

  return findOverlay(node.props.children);
}

function overlayText(node: ReactNode): string[] {
  if (Array.isArray(node)) {
    return node.flatMap(overlayText);
  }

  if (typeof node === "string") {
    return [node];
  }

  if (!isValidElement<ViewportNodeProps>(node)) {
    return [];
  }

  return overlayText(node.props.children);
}

// React attaches a callback ref by calling it with the element and detaches by
// calling the function that call returned, so leaving a view mode and coming
// back is attach, cleanup, then attach against a second element.
function mountInto(tree: ReactNode, mount: StubElement) {
  const cleanup = findMountRef(tree)(asElement(mount));

  return typeof cleanup === "function" ? cleanup : () => {};
}

describe("RendererViewport", () => {
  it("draws the stage again when a view-mode switch mounts it back", () => {
    const host = stubElement("stage-host");
    const canvas = stubElement("canvas");
    const stage = createDemoStage(asElement(host), () => {});
    const firstMount = stubElement("first-mount");
    const secondMount = stubElement("second-mount");

    const unmount = mountInto(renderViewport(stage.attach), firstMount);

    host.appendChild(canvas);
    unmount();

    expect(firstMount.children).toEqual([]);

    mountInto(renderViewport(stage.attach), secondMount);

    expect(secondMount.children).toEqual([host]);
    expect(host.children).toEqual([canvas]);
  });

  it("keeps a mount point under the overlay that covers the stage", () => {
    const attach = vi.fn();
    const tree = renderViewport(attach);

    expect(findOverlay(tree)).not.toBeNull();
    expect(findMountRef(tree)).toBe(attach);
  });

  it("names the reason a source refused to open", () => {
    const message = "openInput: browser cannot decode this video track's codec";
    const overlay = findOverlay(
      renderViewport(
        vi.fn(),
        "opening 70s horse trail",
        erroredSession(message),
      ),
    );

    expect(overlayText(overlay)).toContain(message);
  });

  it("leads a classified failure with copy a viewer can act on", () => {
    const message =
      "openInput: browser cannot decode this video track's codec hev1.2.4.L150.B0";
    const overlay = findOverlay(
      renderViewport(
        vi.fn(),
        "opening 70s horse trail",
        erroredSession(message, MediaErrorKind.UnsupportedFormat),
      ),
    );

    expect(overlayText(overlay)).toContain(
      "This browser cannot decode this video",
    );
    expect(overlayText(overlay)).toContain(message);
  });

  it("hands React the same ref while the overlay changes", () => {
    const attach = vi.fn();

    expect(
      findMountRef(renderViewport(attach, "opening 70s horse trail")),
    ).toBe(attach);
    expect(findMountRef(renderViewport(attach, "reading detections"))).toBe(
      attach,
    );
  });
});
