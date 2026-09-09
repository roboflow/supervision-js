import { describe, expect, it, vi } from "vitest";
import { createDemoStage } from "./useDemoRenderer";

interface StubElement {
  readonly children: StubElement[];
  readonly name: string;
  readonly style: Record<string, string>;
  parent: StubElement | null;
  appendChild(child: StubElement): void;
  remove(): void;
}

function stubElement(name: string, log: string[]): StubElement {
  const element: StubElement = {
    children: [],
    name,
    parent: null,
    style: {},
    appendChild(child) {
      log.push(`${name}.appendChild(${child.name})`);
      detachStubElement(child);
      child.parent = element;
      element.children.push(child);
    },
    remove() {
      log.push(`${name}.remove()`);
      detachStubElement(element);
    },
  };

  return element;
}

function detachStubElement(element: StubElement) {
  const parent = element.parent;

  if (!parent) {
    return;
  }

  parent.children.splice(parent.children.indexOf(element), 1);
  element.parent = null;
}

function childNames(element: StubElement) {
  return element.children.map((child) => child.name);
}

function asElement(element: StubElement) {
  return element as unknown as HTMLDivElement;
}

// React attaches a callback ref by calling it with the element and detaches by
// calling the function that call returned, so a remount is attach, cleanup,
// then attach against a second element.
describe("createDemoStage", () => {
  it("puts the drawn stage back when the viewport mounts again", () => {
    const log: string[] = [];
    const host = stubElement("host", log);
    const stage = createDemoStage(asElement(host), () => {});
    const firstMount = stubElement("first-mount", log);
    const canvas = stubElement("canvas", log);

    const detach = stage.attach(asElement(firstMount));

    host.appendChild(canvas);

    expect(childNames(firstMount)).toEqual(["host"]);

    detach();

    const secondMount = stubElement("second-mount", log);

    stage.attach(asElement(secondMount));

    expect(secondMount.children[0]).toBe(host);
    expect(host.children[0]).toBe(canvas);
  });

  it("only takes the stage off the page when the viewport unmounts", () => {
    const log: string[] = [];
    const host = stubElement("host", log);
    const onAttached = vi.fn();
    const stage = createDemoStage(asElement(host), onAttached);
    const mount = stubElement("mount", log);
    const canvas = stubElement("canvas", log);

    const detach = stage.attach(asElement(mount));

    host.appendChild(canvas);
    log.length = 0;

    detach();

    expect(log).toEqual(["host.remove()"]);
    expect(onAttached).toHaveBeenCalledTimes(1);
    expect(childNames(host)).toEqual(["canvas"]);
    expect(stage.host).toBe(asElement(host));

    stage.attach(asElement(stubElement("second-mount", log)));

    expect(onAttached).toHaveBeenCalledTimes(2);
  });
});
