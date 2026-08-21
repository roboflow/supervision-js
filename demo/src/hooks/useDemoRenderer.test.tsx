import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaRenderer, MediaSession } from "supervision";

/**
 * React's own commit order, reduced to what the stage depends on: a callback
 * ref attaches during commit and detaches by the function it returned, state
 * set from either place re-renders, and an effect re-runs only when a value in
 * its dependency list changes.
 */
const reactHarness = vi.hoisted(() => {
  interface EffectCell {
    cleanup: (() => void) | undefined;
    deps: readonly unknown[] | undefined;
    mounted: boolean;
  }

  interface PendingEffect {
    readonly cell: EffectCell;
    readonly create: () => (() => void) | void;
    readonly deps: readonly unknown[] | undefined;
  }

  let cells: unknown[] = [];
  let cursor = 0;
  let effectCells: EffectCell[] = [];
  let pending: PendingEffect[] = [];
  let renderTree: (() => void) | undefined;
  let dirty = false;

  function sameDeps(
    left: readonly unknown[] | undefined,
    right: readonly unknown[] | undefined,
  ) {
    return (
      left !== undefined &&
      right !== undefined &&
      left.length === right.length &&
      left.every((value, index) => Object.is(value, right[index]))
    );
  }

  function cell<TValue>(create: () => TValue): TValue {
    if (cells.length <= cursor) {
      cells.push(create());
    }

    const value = cells[cursor] as TValue;

    cursor += 1;

    return value;
  }

  function useState<TValue>(initial: TValue | (() => TValue)) {
    const box = cell(() => {
      const value =
        typeof initial === "function" ? (initial as () => TValue)() : initial;

      return {
        value,
        set(next: TValue | ((current: TValue) => TValue)) {
          const resolved =
            typeof next === "function"
              ? (next as (current: TValue) => TValue)(box.value)
              : next;

          if (Object.is(resolved, box.value)) {
            return;
          }

          box.value = resolved;
          dirty = true;
        },
      };
    });

    return [box.value, box.set] as const;
  }

  function useRef<TValue>(initial: TValue) {
    return cell(() => ({ current: initial }));
  }

  function useCallback<TCallback>(
    callback: TCallback,
    deps: readonly unknown[],
  ) {
    const box = cell(() => ({ callback, deps }));

    if (!sameDeps(box.deps, deps)) {
      box.callback = callback;
      box.deps = deps;
    }

    return box.callback;
  }

  function useEffect(
    create: () => (() => void) | void,
    deps?: readonly unknown[],
  ) {
    const effectCell = cell<EffectCell>(() => {
      const created: EffectCell = {
        cleanup: undefined,
        deps: undefined,
        mounted: false,
      };

      effectCells.push(created);

      return created;
    });

    pending.push({ cell: effectCell, create, deps });
  }

  function flushEffects() {
    const queue = pending;

    pending = [];

    for (const effect of queue) {
      if (effect.cell.mounted && sameDeps(effect.cell.deps, effect.deps)) {
        continue;
      }

      effect.cell.cleanup?.();
      effect.cell.mounted = true;
      effect.cell.deps = effect.deps;

      const cleanup = effect.create();

      effect.cell.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    }
  }

  function drain() {
    for (let pass = 0; dirty; pass += 1) {
      if (pass > 50) {
        throw new Error("the hook never stopped re-rendering");
      }

      dirty = false;
      renderTree?.();
      flushEffects();
    }
  }

  function mountHook<TState>(hook: () => TState) {
    cells = [];
    cursor = 0;
    effectCells = [];
    pending = [];
    dirty = false;

    let state: TState;

    renderTree = () => {
      cursor = 0;
      state = hook();
    };

    renderTree();

    return {
      /** Whatever the hook returned on its most recent render. */
      get state() {
        return state;
      },
      /**
       * React's layout phase, where refs attach: the first pass of effects
       * runs after it, with whatever it set already in hand.
       */
      commit(work: () => void) {
        work();
        flushEffects();
        drain();
      },
      /** Runs work the way React would, re-rendering whatever it dirtied. */
      act(work: () => void) {
        work();
        drain();
      },
      /** Lets the session bootstrap settle, then renders what it reported. */
      async settle() {
        await new Promise((resolve) => setTimeout(resolve, 0));
        drain();
      },
      unmount() {
        renderTree = undefined;
        for (const effectCell of [...effectCells].reverse()) {
          effectCell.cleanup?.();
          effectCell.cleanup = undefined;
        }
      },
    };
  }

  return {
    module: { useCallback, useEffect, useRef, useState },
    mountHook,
  };
});

vi.mock("react", () => reactHarness.module);

interface StubElement {
  readonly children: StubElement[];
  readonly name: string;
  readonly style: Record<string, string>;
  parent: StubElement | null;
  appendChild(child: StubElement): void;
  remove(): void;
  replaceChildren(): void;
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
    replaceChildren() {
      for (const child of [...element.children]) {
        detach(child);
      }
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

interface SessionSpy {
  readonly canvas: StubElement;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly renderer: MediaRenderer;
  readonly setPresentation: ReturnType<typeof vi.fn>;
}

interface SessionOptions {
  readonly abortSignal?: AbortSignal;
  readonly container: HTMLDivElement;
  readonly onUploadState?: (state: UploadProgress) => void;
}

interface UploadProgress {
  readonly completedFrames: number;
  readonly status: string;
  readonly statusLabel: string;
  readonly totalFrames: number;
}

const sessions = vi.hoisted(() => ({
  createFixtureSession: vi.fn(),
  createUploadSession: vi.fn(),
  abortSignals: [] as AbortSignal[],
  uploadStateReporters: [] as ((state: UploadProgress) => void)[],
  spies: [] as SessionSpy[],
}));

vi.mock("../session/fixture-session", () => ({
  createFixtureSession: sessions.createFixtureSession,
}));
vi.mock("../session/upload-session", () => ({
  createUploadSession: sessions.createUploadSession,
}));

const { useDemoRenderer, DemoSourceMode } = await import("./useDemoRenderer");

/** Stands in for a session that has opened media and drawn a canvas. */
function openSession(options: SessionOptions): Promise<MediaSession> {
  const container = options.container as unknown as StubElement;
  const canvas = stubElement("canvas");

  container.appendChild(canvas);

  const setPresentation = vi.fn();
  const destroy = vi.fn();
  const renderer = {
    getState: () => ({ playbackState: "playing", source: { status: "ready" } }),
    play: () => Promise.resolve(),
    setPresentation,
  } as unknown as MediaRenderer;

  if (options.abortSignal) {
    sessions.abortSignals.push(options.abortSignal);
  }

  if (options.onUploadState) {
    sessions.uploadStateReporters.push(options.onUploadState);
  }

  sessions.spies.push({
    canvas,
    destroy,
    renderer,
    setPresentation,
  });

  return Promise.resolve({
    destroy,
    renderer,
    setRenderQuality: vi.fn(),
  } as unknown as MediaSession);
}

function lastSpy() {
  const spy = sessions.spies.at(-1);

  if (!spy) {
    throw new Error("no session was ever opened");
  }

  return spy;
}

function isOnStage(canvas: StubElement, mount: StubElement) {
  for (let node = canvas.parent; node; node = node.parent) {
    if (node === mount) {
      return true;
    }
  }

  return false;
}

type StageRef = (element: HTMLDivElement | null) => (() => void) | void;

/**
 * React's callback-ref protocol: the call attaches, and the function it
 * returned detaches, falling back to a call with null when it returned none.
 */
function attachStage(containerRef: StageRef, mount: StubElement) {
  const cleanup = containerRef(asElement(mount));

  return typeof cleanup === "function" ? cleanup : () => containerRef(null);
}

function mountDemo() {
  const hook = reactHarness.mountHook(() => useDemoRenderer());
  let mount = stubElement("viewport-mount");
  let detachStage = () => {};

  hook.commit(() => {
    detachStage = attachStage(hook.state.containerRef, mount);
  });

  return {
    act: hook.act,
    settle: hook.settle,
    unmountDemo: hook.unmount,
    get mount() {
      return mount;
    },
    get state() {
      return hook.state;
    },
    /** What DemoShell does when the Benchmarks tab replaces the workspace. */
    leaveViewMode() {
      hook.act(() => detachStage());
    },
    /** And what it does on the way back: a brand-new mount point. */
    returnToViewMode() {
      mount = stubElement("viewport-mount-again");
      hook.act(() => {
        detachStage = attachStage(hook.state.containerRef, mount);
      });

      return mount;
    },
  };
}

async function startUploadRun(demo: ReturnType<typeof mountDemo>) {
  demo.act(() => {
    demo.state.onUploadFileChange({
      name: "horse-trail.mp4",
      type: "video/mp4",
    } as unknown as File);
    demo.state.setUploadApiKey("rf_test_key");
    demo.state.setUploadClassNames("horse");
  });
  demo.act(() => {
    demo.state.onStartUploadInference();
  });
  await demo.settle();
}

beforeEach(() => {
  sessions.createFixtureSession.mockImplementation(openSession);
  sessions.createUploadSession.mockImplementation(openSession);
  vi.stubGlobal("document", {
    createElement: (tagName: string) => asElement(stubElement(tagName)),
  });
  vi.stubGlobal("window", {
    clearTimeout: globalThis.clearTimeout,
    setTimeout: globalThis.setTimeout,
  });
});

afterEach(() => {
  sessions.abortSignals.length = 0;
  sessions.uploadStateReporters.length = 0;
  sessions.spies.length = 0;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("useDemoRenderer", () => {
  it("draws into the mount point a view-mode round trip left behind", async () => {
    const demo = mountDemo();

    await demo.settle();

    const { canvas } = lastSpy();

    expect(isOnStage(canvas, demo.mount)).toBe(true);

    demo.leaveViewMode();

    const nextMount = demo.returnToViewMode();

    await demo.settle();

    expect(isOnStage(canvas, nextMount)).toBe(true);
    expect(sessions.createFixtureSession).toHaveBeenCalledTimes(1);
  });

  it("takes the stage off the page while the viewport is gone", async () => {
    const demo = mountDemo();

    await demo.settle();
    demo.leaveViewMode();

    expect(demo.mount.children).toEqual([]);
    expect(isOnStage(lastSpy().canvas, demo.mount)).toBe(false);
  });

  it("repaints the stage when it puts it back on the page", async () => {
    const demo = mountDemo();

    await demo.settle();

    const { setPresentation } = lastSpy();

    setPresentation.mockClear();
    demo.leaveViewMode();
    demo.returnToViewMode();
    await demo.settle();

    expect(setPresentation).toHaveBeenCalled();
  });

  it("keeps the session and its warm decoder through a view-mode switch", async () => {
    const demo = mountDemo();

    await demo.settle();

    const { destroy } = lastSpy();

    demo.leaveViewMode();
    await demo.settle();

    expect(destroy).not.toHaveBeenCalled();
    expect(sessions.createFixtureSession).toHaveBeenCalledTimes(1);

    demo.returnToViewMode();
    await demo.settle();

    expect(destroy).not.toHaveBeenCalled();
    expect(sessions.createFixtureSession).toHaveBeenCalledTimes(1);
  });

  it("leaves an inference run the user already paid for running", async () => {
    const demo = mountDemo();

    await demo.settle();
    await startUploadRun(demo);

    expect(demo.state.sourceMode).toBe(DemoSourceMode.Upload);
    expect(sessions.createUploadSession).toHaveBeenCalledTimes(1);

    const { destroy } = lastSpy();
    const abortSignal = sessions.abortSignals.at(-1);
    const reportUploadState = sessions.uploadStateReporters.at(-1);

    demo.leaveViewMode();
    await demo.settle();

    expect(abortSignal?.aborted).toBe(false);
    expect(destroy).not.toHaveBeenCalled();

    demo.act(() =>
      reportUploadState?.({
        completedFrames: 42,
        status: "running",
        statusLabel: "inferring frames",
        totalFrames: 90,
      }),
    );

    expect(demo.state.uploadInferenceState.completedFrames).toBe(42);

    demo.returnToViewMode();
    await demo.settle();

    expect(sessions.createUploadSession).toHaveBeenCalledTimes(1);
    expect(abortSignal?.aborted).toBe(false);
  });

  it("still tears the session down when the demo itself goes away", async () => {
    const demo = mountDemo();

    await demo.settle();
    await startUploadRun(demo);

    const { destroy } = lastSpy();
    const abortSignal = sessions.abortSignals.at(-1);

    demo.unmountDemo();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(abortSignal?.aborted).toBe(true);
  });

  /**
   * Every "not torn down" assertion above is worth something only if this
   * harness can see a teardown at all.
   */
  it("tears the session down when the effect's inputs change", async () => {
    const demo = mountDemo();

    await demo.settle();

    const first = lastSpy();
    const otherFixture = demo.state.sampleFixtures.find(
      (fixture) => fixture.sampleName !== demo.state.sampleFixtureId,
    );

    if (!otherFixture) {
      throw new Error("the demo ships a single fixture");
    }

    demo.act(() => demo.state.setSampleFixtureId(otherFixture.sampleName));
    await demo.settle();

    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(sessions.createFixtureSession).toHaveBeenCalledTimes(2);
  });
});
