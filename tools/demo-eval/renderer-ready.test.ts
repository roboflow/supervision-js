import { describe, expect, it } from "vitest";

/* A readiness rule that is too loose does not fail: the scenario measures a
 * page that is still loading its media and reports numbers nobody can tell
 * apart from real ones. So the rule itself is checked here, along with the two
 * things the scenarios need from the wait around it: a read that fails while
 * the page navigates is not a verdict, and a wait that runs out says what the
 * page last answered. */

import { Invalid, waitForRenderer } from "./renderer-ready.mjs";

type RendererStub = {
  getState: () => {
    source: { status: string; estimatedFrameRate?: number };
    duration: number;
    rendererBackend?: string;
    mediaWidth?: number;
    mediaHeight?: number;
  };
} | null;

const READY: RendererStub = {
  getState: () => ({
    source: { status: "ready", estimatedFrameRate: 30 },
    duration: 12.5,
    rendererBackend: "webgpu",
    mediaWidth: 1280,
    mediaHeight: 720,
  }),
};

/* The readiness rule lives in an expression the page evaluates, so checking it
 * means running it. Each answer is either a renderer the stub page is holding
 * or the error a read against a navigating page rejects with. */
function sessionAnswering(...answers: (RendererStub | Error)[]) {
  let call = 0;
  return {
    readJson: async (expression: string) => {
      const answer = answers[Math.min(call, answers.length - 1)];
      call += 1;
      if (answer instanceof Error) throw answer;
      const probe = new Function("window", `return ${expression};`);
      return JSON.parse(JSON.stringify(probe({ __demoRenderer: answer })));
    },
  };
}

/* Long enough for one read, short enough that the poll after it lands past the
 * deadline. */
const ONE_READ_MS = 400;

describe("waiting for the demo renderer", () => {
  it("hands back the media facts the run reports", async () => {
    await expect(waitForRenderer(sessionAnswering(READY))).resolves.toEqual({
      ready: true,
      duration: 12.5,
      frameRate: 30,
      backend: "webgpu",
      mediaWidth: 1280,
      mediaHeight: 720,
    });
  });

  it("waits for a renderer the page has not mounted yet", async () => {
    await expect(
      waitForRenderer(sessionAnswering(null, READY)),
    ).resolves.toMatchObject({ ready: true });
  });

  it("does not call a ready source with no duration ready", async () => {
    const stalled: RendererStub = {
      getState: () => ({ source: { status: "ready" }, duration: 0 }),
    };

    const error = await waitForRenderer(
      sessionAnswering(stalled),
      ONE_READ_MS,
    ).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(Invalid);
    expect(error.message).toContain("media source status ready");
  });

  it("waits through a read that fails while the page navigates", async () => {
    const session = sessionAnswering(
      new Error("target navigated or closed (Runtime.evaluate)"),
      READY,
    );

    await expect(waitForRenderer(session)).resolves.toMatchObject({
      ready: true,
    });
  });

  it("says what the last read answered when it gives up", async () => {
    const session = sessionAnswering(
      new Error("Media renderer has been destroyed"),
    );

    const error = await waitForRenderer(session, ONE_READ_MS).catch(
      (thrown) => thrown,
    );

    expect(error).toBeInstanceOf(Invalid);
    expect(error.message).toContain("Media renderer has been destroyed");
  });
});
