import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createArrayDetectionFrameSource,
  createBufferedDetectionTimeline,
} from "supervision-js-core";

import type { MediaRendererSceneOptions } from "./media-renderer-scene";
import { MediaRendererFit } from "#types/media-renderer";

vi.mock("pixi.js", () => {
  class Container {
    children: unknown[] = [];
    position = { set: vi.fn() };
    scale = { set: vi.fn() };
    addChild(...children: unknown[]) {
      this.children.push(...children);
      return children[0];
    }
    removeChild() {
      return undefined;
    }
  }

  class Graphics extends Container {
    clear = vi.fn(() => this);
    fill = vi.fn(() => this);
    rect = vi.fn(() => this);
    roundRect = vi.fn(() => this);
    stroke = vi.fn(() => this);
  }

  class Application {
    canvas = new OwnedElement();
    cancelResize = vi.fn();
    destroy = vi.fn();
    init = vi.fn(async () => undefined);
    render = vi.fn();
    renderer = {
      background: { color: 0 },
      name: "webgl",
      resize: vi.fn(),
      resolution: 1,
    };
    screen = { height: 360, width: 640 };
    stage = new Container();
    ticker = { add: vi.fn(), remove: vi.fn() };
  }

  class Sprite extends Container {
    anchor = { set: vi.fn() };
    destroy = vi.fn();
    position = { set: vi.fn() };
  }

  class Texture {}

  return {
    AlphaMask: class {},
    Application,
    Assets: { load: vi.fn(), unload: vi.fn() },
    BlurFilter: class {},
    BufferImageSource: class {},
    CanvasSource: class {},
    ColorMatrixFilter: class {},
    Container,
    ExternalSource: class {},
    Filter: class {},
    Graphics,
    ImageSource: class {},
    Mesh: class {},
    MeshGeometry: class {},
    Rectangle: class {},
    Shader: class {},
    Sprite,
    Text: class {},
    Texture,
    UniformGroup: class {},
    defaultFilterVert: "vertex",
  };
});

vi.mock("pixi.js/gif", () => ({ GifSprite: class {} }));

class OwnedElement {
  readonly children: OwnedElement[] = [];
  readonly style: Record<string, string> = {};
  parentNode: OwnedElement | null = null;
  clientHeight = 360;
  clientWidth = 640;
  tabIndex = 0;

  appendChild(child: OwnedElement) {
    child.remove();
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  removeChild(child: OwnedElement) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  getContext = vi.fn(() => ({ drawImage: vi.fn() }));
}

const documentMock = {
  addEventListener: vi.fn(),
  createElement: () => new OwnedElement(),
  hidden: false,
  removeEventListener: vi.fn(),
};

beforeEach(() => {
  vi.stubGlobal("document", documentMock);
  vi.stubGlobal("window", { devicePixelRatio: 1 });
  vi.stubGlobal("ResizeObserver", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Pixi media scene lifecycle", () => {
  it("removes only its owned backdrop when destroyed, including recreation", async () => {
    const host = new OwnedElement();
    const sentinel = new OwnedElement();
    host.appendChild(sentinel);
    const { createPixiMediaScene } = await import("./pixi-media-scene");

    const first = await createPixiMediaScene(createOptions(host));
    const firstBackdrop = host.children.at(-1);
    expect(host.children).toEqual([sentinel, firstBackdrop]);

    first.destroy();
    expect(host.children).toEqual([sentinel]);
    expect(firstBackdrop?.parentNode).toBeNull();

    first.destroy();
    expect(host.children).toEqual([sentinel]);

    const second = await createPixiMediaScene(createOptions(host));
    expect(host.children).toEqual([sentinel, host.children.at(-1)]);
    second.destroy();
    expect(host.children).toEqual([sentinel]);
  });
});

function createOptions(container: HTMLElement): MediaRendererSceneOptions {
  return {
    annotationOverlayStyle: null,
    backgroundColor: undefined,
    boxCornerStyle: undefined,
    boxStyle: undefined,
    canInteract: () => false,
    container,
    detectionTimeline: createBufferedDetectionTimeline({
      source: createArrayDetectionFrameSource([]),
    }),
    diagnostics: undefined,
    editingEngine: undefined,
    ellipseStyle: undefined,
    fit: MediaRendererFit.Contain,
    focusStyle: null,
    interaction: undefined,
    interactionStyle: null,
    keypointStyle: null,
    labelStyle: null,
    markerStyle: undefined,
    maskBrush: undefined,
    maskHaloStyle: undefined,
    maskStyle: null,
    maxDevicePixelRatio: 1,
    polygonStyle: undefined,
    polylineStyle: null,
    presentedFrames: undefined,
    previewOverlay: undefined,
    regionRenderers: [],
    renderPreparation: undefined,
    shapeStyle: null,
    visibility: undefined,
  };
}
