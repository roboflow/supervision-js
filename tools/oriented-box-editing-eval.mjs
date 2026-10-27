/** Real browser pointer coverage for the standalone public editing example.
 * Start the example on 5191 and an isolated Chrome with --remote-debugging-port=9336.
 * Run: node tools/oriented-box-editing-eval.mjs [example-url] [chrome-debug-url]
 */
import assert from "node:assert/strict";
import process from "node:process";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import {
  getAnnotationHandles,
  getOrientedRectangleGeometry,
} from "../packages/web/dist/editing.js";
import { CdpSession, openTarget, closeTarget } from "./demo-eval/cdp.mjs";

const url =
  process.argv[2] ?? "http://127.0.0.1:5191/examples/vanilla/oriented-box.html";
const chrome = process.argv[3] ?? "http://127.0.0.1:9336";
const target = await openTarget(chrome, url);
const cdp = await CdpSession.attach(target.webSocketDebuggerUrl);
const pause = () => new Promise((resolve) => setTimeout(resolve, 80));
const results = [];
try {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  for (let count = 0; count < 150; count++) {
    if (
      await cdp.evaluate(
        'document.querySelector("#geometry")?.textContent.length > 0 && document.querySelector("canvas") !== null',
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const read = () =>
    cdp.evaluate('JSON.parse(document.querySelector("#geometry").textContent)');
  const click = async (selector) => {
    await cdp.evaluate(
      `document.querySelector(${JSON.stringify(selector)}).click()`,
    );
    await pause();
  };
  const viewport = await cdp.evaluate(
    'document.querySelector("canvas").getBoundingClientRect().toJSON()',
  );
  const scale = Math.min(viewport.width / 800, viewport.height / 500);
  const screen = (p) => ({
    x: viewport.x + viewport.width / 2 + (p.x - 400) * scale,
    y: viewport.y + viewport.height / 2 + (p.y - 250) * scale,
  });
  async function mouse(type, p, buttons = 0) {
    await cdp.send("Input.dispatchMouseEvent", {
      type,
      ...p,
      button: type === "mouseMoved" ? "none" : "left",
      buttons,
      clickCount: type === "mouseMoved" ? 0 : 1,
    });
  }
  async function drag(from, to, cancel = false) {
    await mouse("mouseMoved", from);
    await mouse("mousePressed", from, 1);
    for (let i = 1; i <= 8; i++)
      await mouse(
        "mouseMoved",
        {
          x: from.x + ((to.x - from.x) * i) / 8,
          y: from.y + ((to.y - from.y) * i) / 8,
        },
        1,
      );
    if (cancel)
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
    await mouse("mouseReleased", to);
    await pause();
  }
  const initial = await read();
  assert.equal(initial.length, 1);
  // AABB corner is outside the actual rotated rectangle and must not move it.
  await drag(screen({ x: 300, y: 162 }), screen({ x: 315, y: 170 }));
  assert.deepEqual(await read(), initial);
  results.push("exact oriented footprint picking");
  // Select, rotate via the shared public handle geometry, and undo/redo.
  await mouse("mousePressed", screen({ x: 390, y: 240 }), 1);
  await mouse("mouseReleased", screen({ x: 390, y: 240 }));
  await pause();
  const rotate = getAnnotationHandles(initial[0], scale).find(
    (h) => h.id === "obb-rotate",
  );
  const from = rotate.point;
  const to = { x: 390 - (from.y - 240), y: 240 + from.x - 390 };
  await drag(screen(from), screen(to));
  const rotated = await read();
  const rotatedRect = getOrientedRectangleGeometry(rotated[0].orientedBox);
  assert.ok(
    Math.abs(rotatedRect.rotation - (Math.PI / 5 + Math.PI / 2)) < 0.025,
  );
  assert.equal(rotated[0].rect, undefined);
  await click("#undo");
  assert.deepEqual(await read(), initial);
  await click("#redo");
  assert.deepEqual(await read(), rotated);
  results.push("rotation control, ordered axes and one-step undo/redo");
  // Cancellation must leave committed data untouched.
  await mouse("mousePressed", screen({ x: 390, y: 240 }), 1);
  await mouse("mouseReleased", screen({ x: 390, y: 240 }));
  const activeRotate = getAnnotationHandles(rotated[0], scale).find(
    (h) => h.id === "obb-rotate",
  );
  await drag(screen(activeRotate.point), screen({ x: 480, y: 260 }), true);
  assert.deepEqual(await read(), rotated);
  results.push("Escape cancels a live rotation");
  // Touch drags a corner along its rotated local axes.
  const corner = getAnnotationHandles(rotated[0], scale).find(
    (h) => h.id === "obb-se",
  );
  const tuple = getOrientedRectangleGeometry(rotated[0].orientedBox);
  const movedCorner = {
    x: corner.point.x + 30 * Math.cos(tuple.rotation),
    y: corner.point.y + 30 * Math.sin(tuple.rotation),
  };
  const touch = async (type, p) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: p ? [{ ...screen(p), id: 1, radiusX: 2, radiusY: 2 }] : [],
    });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await touch("touchStart", corner.point);
  await touch("touchMove", movedCorner);
  await touch("touchEnd");
  await pause();
  const resized = await read();
  assert.ok(
    Math.abs(
      getOrientedRectangleGeometry(resized[0].orientedBox).width -
        tuple.width -
        30,
    ) < 1.5,
  );
  results.push("touch local-axis corner resize");
  // Fresh OBB-only drawing uses the same normal session route.
  await click("#draw");
  await drag(screen({ x: 620, y: 340 }), screen({ x: 740, y: 420 }));
  const created = await read();
  assert.equal(created.length, 2);
  assert.equal(created[1].rect, undefined);
  assert.ok(getOrientedRectangleGeometry(created[1].orientedBox).width > 100);
  await click("#undo");
  assert.equal((await read()).length, 1);
  results.push("native OBB-only creation and single-step creation undo");
  // The rendering route must remain functional under wheel zoom.
  const beforeZoom = await cdp.evaluate(
    'parseFloat(document.querySelector("#zoom").textContent)',
  );
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    ...screen({ x: 390, y: 240 }),
    deltaX: 0,
    deltaY: -350,
  });
  await pause();
  assert.deepEqual(await read(), resized);
  const afterZoom = await cdp.evaluate(
    'parseFloat(document.querySelector("#zoom").textContent)',
  );
  assert.ok(afterZoom > beforeZoom * 1.5);
  await mouse("mousePressed", screen({ x: 390, y: 240 }), 1);
  await mouse("mouseReleased", screen({ x: 390, y: 240 }));
  await pause();
  results.push(
    "wheel zoom changes the viewport and preserves committed geometry",
  );
  await mkdir("artifacts", { recursive: true });
  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
  });
  await writeFile(
    "artifacts/oriented-box-editing.png",
    Buffer.from(screenshot.data, "base64"),
  );
  await writeFile(
    "artifacts/oriented-box-editing-browser.json",
    JSON.stringify(
      { url, results, initial, rotated, resized, created },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: results.length, results }, null, 2));
} finally {
  cdp.close();
  await closeTarget(chrome, target.id);
}
