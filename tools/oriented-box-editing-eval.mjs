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
const artifactDirectory = process.argv[4] ?? "artifacts";
const target = await openTarget(chrome, "about:blank");
const cdp = await CdpSession.attach(target.webSocketDebuggerUrl);
const pause = () => new Promise((resolve) => setTimeout(resolve, 80));
const results = [];
const handles = (detection, scale) =>
  getAnnotationHandles(detection, scale, {
    rotationHandle: { edgeIndex: 1, offset: 32, stemOffset: 20 },
  });
try {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // Install touch capability before the renderer chooses its native event route.
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await cdp.send("Page.navigate", { url });
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
  async function mouse(type, p, buttons = 0, clickCount = 1, modifiers = 0) {
    await cdp.send("Input.dispatchMouseEvent", {
      type,
      ...p,
      button: type === "mouseMoved" ? "none" : "left",
      buttons,
      clickCount: type === "mouseMoved" ? 0 : clickCount,
      modifiers,
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
  // Exercise the configured geometry before enabling the host heading convention.
  await click("#heading");
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
  const rotate = handles(initial[0], scale).find((h) => h.id === "obb-rotate");
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
  const activeRotate = handles(rotated[0], scale).find(
    (h) => h.id === "obb-rotate",
  );
  await drag(screen(activeRotate.point), screen({ x: 480, y: 260 }), true);
  assert.deepEqual(await read(), rotated);
  results.push("Escape cancels a live rotation");
  // Touch drags a corner along its rotated local axes.
  const corner = handles(rotated[0], scale).find((h) => h.id === "obb-se");
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
    `Touch resize width ${getOrientedRectangleGeometry(resized[0].orientedBox).width}; expected ${tuple.width + 30}; before ${JSON.stringify(tuple)}; corner ${JSON.stringify(corner.point)}; target ${JSON.stringify(movedCorner)}`,
  );
  results.push("touch local-axis corner resize");
  for (const id of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
    const grabbed = handles(resized[0], scale).find(
      (handle) => handle.id === `obb-${id}`,
    );
    const original = getOrientedRectangleGeometry(resized[0].orientedBox);
    const sx = id.includes("w") ? -1 : id.includes("e") ? 1 : 0;
    const sy = id.includes("n") ? -1 : id.includes("s") ? 1 : 0;
    const local = {
      x: -sx * original.width * 1.5,
      y: -sy * original.height * 1.5,
    };
    const end = {
      x:
        original.x +
        local.x * Math.cos(original.rotation) -
        local.y * Math.sin(original.rotation),
      y:
        original.y +
        local.x * Math.sin(original.rotation) +
        local.y * Math.cos(original.rotation),
    };
    await drag(screen(grabbed.point), screen(end));
    const crossed = getOrientedRectangleGeometry((await read())[0].orientedBox);
    assert.ok(
      Math.abs(crossed.rotation - original.rotation) < 1e-8,
      `${id} crossing preserves ordered axes`,
    );
    assert.ok(
      Math.abs(crossed.width - original.width) < 0.1 &&
        Math.abs(crossed.height - original.height) < 0.1,
    );
    const expected = {
      x:
        original.x -
        sx * original.width * Math.cos(original.rotation) +
        sy * original.height * Math.sin(original.rotation),
      y:
        original.y -
        sx * original.width * Math.sin(original.rotation) -
        sy * original.height * Math.cos(original.rotation),
    };
    assert.ok(
      Math.hypot(crossed.x - expected.x, crossed.y - expected.y) < 0.1,
      `${id} crosses its original fixed anchor`,
    );
    await click("#undo");
    assert.deepEqual(await read(), resized);
    if (id === "se") {
      await drag(screen(grabbed.point), screen(end), true);
      assert.deepEqual(await read(), resized);
    }
  }
  results.push(
    "all eight rotated resize handles cross their opposite anchor, preserve axes, undo once and cancel cleanly",
  );
  for (const [delta, expectedAngle] of [
    [{ x: 100, y: 40 }, 0],
    [{ x: -100, y: 40 }, Math.PI],
    [{ x: 100, y: -40 }, 0],
    [{ x: -100, y: -40 }, Math.PI],
    [{ x: 40, y: 100 }, Math.PI / 2],
    [{ x: -40, y: 100 }, Math.PI / 2],
    [{ x: 40, y: -100 }, -Math.PI / 2],
    [{ x: -40, y: -100 }, -Math.PI / 2],
  ]) {
    await click("#draw");
    await drag(
      screen({ x: 620, y: 250 }),
      screen({ x: 620 + delta.x, y: 250 + delta.y }),
    );
    const drawn = await read();
    assert.equal(drawn.length, 2);
    const ordered = getOrientedRectangleGeometry(drawn[1].orientedBox);
    assert.ok(
      Math.abs(Math.cos(ordered.rotation) - Math.cos(expectedAngle)) < 1e-8,
    );
    assert.ok(
      Math.abs(Math.sin(ordered.rotation) - Math.sin(expectedAngle)) < 1e-8,
    );
    assert.ok(
      Math.abs(ordered.width - 100) < 0.1 &&
        Math.abs(ordered.height - 40) < 0.1,
    );
    await click("#undo");
    assert.deepEqual(await read(), resized);
  }
  results.push(
    "four-quadrant creation follows both dominant axes with one-step undo",
  );
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
  // Create an edge-touching rectangle through ordinary pointer input. The
  // outward front control initially lies outside the host. Zooming out must
  // expose it without moving the geometry.
  await click("#draw");
  await drag(screen({ x: 720, y: 40 }), screen({ x: 804, y: 80 }));
  const edgeCreated = await read();
  assert.equal(edgeCreated.length, 2);
  const edge = edgeCreated[1];
  const edgeRect = getOrientedRectangleGeometry(edge.orientedBox);
  assert.ok(Math.abs(edgeRect.x + edgeRect.width / 2 - 800) < 0.01);
  const host = await cdp.evaluate(`(() => {
    const viewer = document.querySelector("#viewer");
    const rect = viewer.getBoundingClientRect();
    return { x: rect.x + viewer.clientLeft, y: rect.y + viewer.clientTop,
      width: viewer.clientWidth, height: viewer.clientHeight };
  })()`);
  assert.ok(Math.abs(viewport.y - host.y) < 1);
  const initialEdgeRotate = handles(edge, scale).find(
    (handle) => handle.id === "obb-rotate",
  );
  assert.ok(screen(initialEdgeRotate.point).x > host.x + host.width);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: host.x + host.width / 2,
    y: host.y + host.height / 2,
    deltaX: 0,
    deltaY: 350,
  });
  await pause();
  assert.deepEqual(await read(), edgeCreated);
  const edgeScale = await cdp.evaluate(
    'parseFloat(document.querySelector("#zoom").textContent)',
  );
  const edgeScreen = (point) => ({
    x: host.x + host.width / 2 + (point.x - 400) * edgeScale,
    y: host.y + host.height / 2 + (point.y - 250) * edgeScale,
  });
  const edgeRotate = handles(edge, edgeScale).find(
    (handle) => handle.id === "obb-rotate",
  );
  const edgeTarget = edgeScreen(edgeRotate.point);
  assert.ok(
    edgeTarget.x + (edgeRotate.hitSize * edgeScale) / 2 < host.x + host.width,
  );
  assert.ok(edgeTarget.x > host.x && edgeTarget.x < host.x + host.width);
  const canvasAtTarget = await cdp.evaluate(`(() => {
    const target = ${JSON.stringify(edgeTarget)};
    const canvas = document.querySelector("canvas");
    const rect = canvas.getBoundingClientRect();
    return target.x >= rect.left && target.x <= rect.right &&
      target.y >= rect.top && target.y <= rect.bottom &&
      document.elementFromPoint(target.x, target.y) === canvas;
  })()`);
  assert.ok(
    canvasAtTarget,
    "the exposed public rotation target is inside the real canvas hit area",
  );
  await mkdir(artifactDirectory, { recursive: true });
  const edgeScreenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
  });
  await writeFile(
    `${artifactDirectory}/oriented-box-edge-control.png`,
    Buffer.from(edgeScreenshot.data, "base64"),
  );
  const edgeVector = {
    x: edgeRotate.point.x - edgeRect.x,
    y: edgeRotate.point.y - edgeRect.y,
  };
  await drag(
    edgeTarget,
    edgeScreen({
      x:
        edgeRect.x +
        edgeVector.x * Math.cos(0.3) -
        edgeVector.y * Math.sin(0.3),
      y:
        edgeRect.y +
        edgeVector.x * Math.sin(0.3) +
        edgeVector.y * Math.cos(0.3),
    }),
  );
  const edgeRotated = await read();
  const edgeRotatedRect = getOrientedRectangleGeometry(
    edgeRotated[1].orientedBox,
  );
  assert.ok(
    Math.abs(edgeRotatedRect.rotation) > 0.1,
    "actual pointer drag rotates the edge-touching rectangle",
  );
  results.push(
    "edge-touching rotation control is reachable after viewport zoom-out with unchanged geometry",
  );
  await click("#undo");
  assert.deepEqual(await read(), edgeCreated);
  await click("#undo");
  assert.deepEqual(await read(), resized);
  await click("#reset");
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
  // Host policy is enabled explicitly; every interaction still uses built
  // supervision/editing geometry and the real session pointer route.
  await click("#reset");
  await click("#heading");
  const hostBaseline = await read();
  const hostRectangle = getOrientedRectangleGeometry(
    hostBaseline[0].orientedBox,
  );
  const center = { x: hostRectangle.x, y: hostRectangle.y };
  await mouse("mousePressed", screen(center), 1);
  await mouse("mouseReleased", screen(center));
  await pause();
  const frontHandles = (detection) => handles(detection, scale);
  const frontRotate = frontHandles(hostBaseline[0]).find(
    (handle) => handle.id === "obb-rotate",
  );
  assert.ok(Math.abs(frontRotate.radius * scale - 4) < 1e-8);
  const expectedFront = {
    x:
      (hostBaseline[0].orientedBox.points[1].x +
        hostBaseline[0].orientedBox.points[2].x) /
      2,
    y:
      (hostBaseline[0].orientedBox.points[1].y +
        hostBaseline[0].orientedBox.points[2].y) /
      2,
  };
  assert.ok(
    Math.hypot(
      frontRotate.stemFrom.x -
        expectedFront.x -
        (20 * Math.cos(hostRectangle.rotation)) / scale,
      frontRotate.stemFrom.y -
        expectedFront.y -
        (20 * Math.sin(hostRectangle.rotation)) / scale,
    ) < 1e-8,
  );
  const delta = 0.21;
  const vector = {
    x: frontRotate.point.x - center.x,
    y: frontRotate.point.y - center.y,
  };
  const rawTarget = {
    x: center.x + vector.x * Math.cos(delta) - vector.y * Math.sin(delta),
    y: center.y + vector.x * Math.sin(delta) + vector.y * Math.cos(delta),
  };
  const key = (type, name, modifiers = 0, autoRepeat = false) =>
    cdp.send("Input.dispatchKeyEvent", {
      type,
      key: name,
      code: name,
      modifiers,
      autoRepeat,
      windowsVirtualKeyCode: {
        Shift: 16,
        Escape: 27,
        Enter: 13,
        ArrowRight: 39,
      }[name],
    });
  const angleReadout = () =>
    cdp.evaluate('Number(document.querySelector("#angle").value)');
  await mouse("mouseMoved", screen(frontRotate.point));
  await mouse("mousePressed", screen(frontRotate.point), 1);
  await mouse("mouseMoved", screen(rawTarget), 1);
  await pause();
  const rawAngle = await angleReadout();
  const snappedAngle = Math.round(rawAngle / 15) * 15;
  assert.ok(Math.abs(rawAngle - snappedAngle) > 1);
  await key("keyDown", "Shift", 8);
  await pause();
  assert.ok(Math.abs((await angleReadout()) - snappedAngle) < 0.01);
  assert.deepEqual(await read(), hostBaseline);
  await key("keyUp", "Shift");
  await pause();
  assert.ok(Math.abs((await angleReadout()) - rawAngle) < 0.01);
  await key("keyDown", "Shift", 8);
  await mouse("mouseReleased", screen(rawTarget), 0, 1, 8);
  await key("keyUp", "Shift");
  await pause();
  const snapped = await read();
  assert.ok(
    Math.abs(
      (getOrientedRectangleGeometry(snapped[0].orientedBox).rotation * 180) /
        Math.PI -
        snappedAngle,
    ) < 0.01,
  );
  await click("#undo");
  assert.deepEqual(await read(), hostBaseline);
  results.push(
    "configured compact front-edge rotation handle with a clear stem gap and stationary Shift press/release snapping with single undo",
  );

  const footprint = (points) =>
    [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const originalPoints = hostBaseline[0].orientedBox.points;
  const topMidpoint = {
    x: (originalPoints[0].x + originalPoints[1].x) / 2,
    y: (originalPoints[0].y + originalPoints[1].y) / 2,
  };
  // One completed midpoint click chooses front; normal drags keep resize ownership.
  await mouse("mousePressed", screen(topMidpoint), 1);
  await mouse("mouseReleased", screen(topMidpoint));
  await pause();
  const midpointFront = await read();
  assert.notDeepEqual(midpointFront, hostBaseline);
  assert.deepEqual(
    footprint(midpointFront[0].orientedBox.points),
    footprint(originalPoints),
  );
  await click("#undo");
  assert.deepEqual(await read(), hostBaseline);
  await drag(
    screen(topMidpoint),
    screen({
      x: topMidpoint.x + Math.sin(hostRectangle.rotation) * 20,
      y: topMidpoint.y - Math.cos(hostRectangle.rotation) * 20,
    }),
  );
  const midpointResize = getOrientedRectangleGeometry(
    (await read())[0].orientedBox,
  );
  assert.ok(Math.abs(midpointResize.height - hostRectangle.height - 20) < 0.1);
  assert.ok(Math.abs(midpointResize.rotation - hostRectangle.rotation) < 1e-8);
  await click("#undo");
  assert.deepEqual(await read(), hostBaseline);
  // A corner keeps its ordinary handle ownership on a click.
  await mouse("mousePressed", screen(originalPoints[0]), 1);
  await mouse("mouseReleased", screen(originalPoints[0]));
  await pause();
  assert.deepEqual(await read(), hostBaseline);
  const topEdgePoint = {
    x:
      originalPoints[0].x * 0.7 +
      originalPoints[1].x * 0.3 +
      Math.sin(hostRectangle.rotation) / scale,
    y:
      originalPoints[0].y * 0.7 +
      originalPoints[1].y * 0.3 -
      Math.cos(hostRectangle.rotation) / scale,
  };
  await mouse("mousePressed", screen(topEdgePoint), 1);
  await mouse("mouseReleased", screen(topEdgePoint));
  assert.equal(
    await cdp.evaluate('document.querySelector("#angle").disabled'),
    false,
    "the edge miss band must preserve selection",
  );
  await pause();
  const refronted = await read();
  assert.notDeepEqual(refronted, hostBaseline);
  assert.deepEqual(
    footprint(refronted[0].orientedBox.points),
    footprint(originalPoints),
  );
  const controlPoints = (detection) =>
    footprint(
      frontHandles(detection)
        .filter((handle) => handle.id !== "obb-rotate")
        .map((handle) => handle.point),
    );
  const beforeHandlePoints = controlPoints(hostBaseline[0]);
  controlPoints(refronted[0]).forEach((point, index) => {
    assert.ok(
      Math.hypot(
        point.x - beforeHandlePoints[index].x,
        point.y - beforeHandlePoints[index].y,
      ) < 1e-8,
    );
  });
  const refrontRotate = frontHandles(refronted[0]).find(
    (handle) => handle.id === "obb-rotate",
  );
  const refrontRectangle = getOrientedRectangleGeometry(
    refronted[0].orientedBox,
  );
  const refrontMidpoint = {
    x:
      (refronted[0].orientedBox.points[1].x +
        refronted[0].orientedBox.points[2].x) /
      2,
    y:
      (refronted[0].orientedBox.points[1].y +
        refronted[0].orientedBox.points[2].y) /
      2,
  };
  assert.ok(
    Math.hypot(
      refrontRotate.stemFrom.x -
        refrontMidpoint.x -
        (20 * Math.cos(refrontRectangle.rotation)) / scale,
      refrontRotate.stemFrom.y -
        refrontMidpoint.y -
        (20 * Math.sin(refrontRectangle.rotation)) / scale,
    ) < 1e-8,
  );
  await click("#undo");
  assert.deepEqual(await read(), hostBaseline);
  await click("#reverse-front");
  const reversed = await read();
  assert.deepEqual(
    footprint(reversed[0].orientedBox.points),
    footprint(originalPoints),
  );
  await click("#undo");
  assert.deepEqual(await read(), hostBaseline);
  results.push(
    "single-click midpoint chooses front once; same handle drag resizes; corners retain ownership; edge miss band and front/reverse preserve selection/footprint with single undo",
  );

  for (const tool of ["#select", "#draw"]) {
    await click(tool);
    // Two screen pixels of jitter remain a click and produce one front action.
    await mouse("mousePressed", screen(topMidpoint), 1);
    await mouse(
      "mouseMoved",
      { x: screen(topMidpoint).x + 2, y: screen(topMidpoint).y },
      1,
    );
    await mouse("mouseReleased", screen(topMidpoint));
    await pause();
    const chosen = await read();
    assert.notDeepEqual(
      chosen,
      hostBaseline,
      `${tool} midpoint click sets front`,
    );
    assert.equal(chosen.length, 1, "front click must not create a rectangle");
    assert.deepEqual(
      footprint(chosen[0].orientedBox.points),
      footprint(originalPoints),
    );
    await mouse("mousePressed", screen(topMidpoint), 1);
    await mouse("mouseReleased", screen(topMidpoint));
    await pause();
    assert.deepEqual(
      await read(),
      chosen,
      "clicking the existing front adds no history action",
    );
    await click("#undo");
    assert.deepEqual(await read(), hostBaseline);
    await click(tool);
    await mouse("mousePressed", screen(topEdgePoint), 1);
    await mouse("mouseReleased", screen(topEdgePoint));
    await pause();
    assert.notDeepEqual(
      await read(),
      hostBaseline,
      `${tool} edge click sets front`,
    );
    await click("#undo");
    assert.deepEqual(await read(), hostBaseline);
    await click(tool);
    await drag(
      screen(topMidpoint),
      screen({
        x: topMidpoint.x + Math.sin(hostRectangle.rotation) * 20,
        y: topMidpoint.y - Math.cos(hostRectangle.rotation) * 20,
      }),
    );
    const grown = await read();
    const grownGeometry = getOrientedRectangleGeometry(grown[0].orientedBox);
    assert.equal(
      grown.length,
      1,
      `${tool} midpoint drag must resize the existing box`,
    );
    assert.ok(Math.abs(grownGeometry.height - hostRectangle.height - 20) < 0.1);
    assert.ok(Math.abs(grownGeometry.rotation - hostRectangle.rotation) < 1e-8);
    await click("#undo");
    assert.deepEqual(await read(), hostBaseline);
    await click(tool);
    await mouse("mousePressed", screen(topMidpoint), 1);
    await key("keyDown", "Escape");
    await key("keyUp", "Escape");
    await mouse("mouseReleased", screen(topMidpoint));
    await pause();
    assert.deepEqual(
      await read(),
      hostBaseline,
      `${tool} Escape cancels a front press`,
    );
    // An out-and-back excursion must not be mistaken for a completed click.
    await mouse("mousePressed", screen(topMidpoint), 1);
    await mouse(
      "mouseMoved",
      { x: screen(topMidpoint).x + 6, y: screen(topMidpoint).y },
      1,
    );
    await mouse("mouseMoved", screen(topMidpoint), 1);
    await mouse("mouseReleased", screen(topMidpoint));
    await pause();
    const returned = await read();
    const returnedGeometry = getOrientedRectangleGeometry(
      returned[0].orientedBox,
    );
    assert.ok(
      Math.abs(returnedGeometry.rotation - hostRectangle.rotation) < 1e-8,
      "returning SDK resize must not change front",
    );
    assert.ok(Math.abs(returnedGeometry.width - hostRectangle.width) < 0.001);
    assert.ok(Math.abs(returnedGeometry.height - hostRectangle.height) < 0.001);
    // Browser pointer coordinates can leave a subpixel resize after returning.
    if (JSON.stringify(returned) !== JSON.stringify(hostBaseline)) {
      await click("#undo");
      assert.deepEqual(await read(), hostBaseline);
    }
  }
  results.push(
    "single-click edge and midpoint front choices work in Select and Draw; jitter/cancel preserve gesture ownership",
  );
  await click("#draw");
  await drag(
    screen(topEdgePoint),
    screen({ x: topEdgePoint.x + 80, y: topEdgePoint.y - 80 }),
  );
  assert.deepEqual(
    await read(),
    hostBaseline,
    "selected edge drag must not start OBB creation or choose front",
  );
  await drag(screen(center), screen({ x: center.x + 100, y: center.y + 40 }));
  assert.equal(
    (await read()).length,
    2,
    "selected body retains OBB drawing ownership",
  );
  await click("#undo");
  assert.deepEqual(await read(), hostBaseline);
  await click("#select");
  await click("#heading");
  assert.deepEqual(
    await read(),
    hostBaseline,
    "heading toggle must not change geometry",
  );
  assert.equal(
    await cdp.evaluate('document.querySelector("#next-front").disabled'),
    true,
  );
  await mouse("mousePressed", screen(topMidpoint), 1);
  await mouse("mouseReleased", screen(topMidpoint));
  await pause();
  assert.deepEqual(
    await read(),
    hostBaseline,
    "heading-disabled class has no semantic front click",
  );
  // The same actual pointer target rotates with heading disabled; no placement jump.
  await drag(screen(frontRotate.point), screen(rawTarget));
  assert.notDeepEqual(await read(), hostBaseline);
  await click("#undo");
  assert.deepEqual(await read(), hostBaseline);
  await click("#heading");
  assert.deepEqual(await read(), hostBaseline);
  results.push(
    "OBB body draws; heading-disabled classes retain geometry, rotation target and resize controls without front actions",
  );

  const enterAngle = async (value) => {
    await cdp.evaluate(
      'document.querySelector("#angle").focus(); document.querySelector("#angle").select()',
    );
    await cdp.send("Input.insertText", { text: String(value) });
    await pause();
  };
  await enterAngle(12.5);
  assert.deepEqual(await read(), hostBaseline);
  assert.equal(await angleReadout(), 12.5);
  await key("keyDown", "Escape");
  await key("keyUp", "Escape");
  await pause();
  assert.equal(
    await cdp.evaluate('document.querySelector("#status").textContent'),
    "idle",
    "cancelled numeric preview must clear its preview status",
  );
  assert.deepEqual(await read(), hostBaseline);
  assert.ok(
    Math.abs(
      (await angleReadout()) - (hostRectangle.rotation * 180) / Math.PI,
    ) < 0.01,
  );
  await enterAngle(12.5);
  await key("keyDown", "Enter");
  await key("keyUp", "Enter");
  await pause();
  const numeric = await read();
  assert.equal(
    await cdp.evaluate('document.querySelector("#status").textContent'),
    "idle",
    "committed numeric angle must clear the preview status",
  );
  assert.ok(
    Math.abs(
      (getOrientedRectangleGeometry(numeric[0].orientedBox).rotation * 180) /
        Math.PI -
        12.5,
    ) < 0.001,
  );
  await click("#undo");
  assert.deepEqual(await read(), hostBaseline);
  results.push(
    "numeric angle preview, Escape cancellation, precise Enter commit and single undo",
  );

  await cdp.evaluate('document.querySelector("#rotate-keys").focus()');
  await key("keyDown", "Escape");
  await key("keyUp", "Escape");
  await key("keyDown", "ArrowRight");
  await key("keyUp", "ArrowRight");
  await pause();
  assert.ok(
    Math.abs(
      getOrientedRectangleGeometry((await read())[0].orientedBox).rotation -
        hostRectangle.rotation -
        Math.PI / 180,
    ) < 1e-8,
    "idle Escape must not consume the next fresh arrow press",
  );
  await click("#undo");
  assert.deepEqual(await read(), hostBaseline);
  await cdp.evaluate('document.querySelector("#rotate-keys").focus()');
  await key("keyDown", "ArrowRight");
  await key("keyDown", "ArrowRight");
  await pause();
  assert.deepEqual(await read(), hostBaseline);
  await key("keyUp", "ArrowRight");
  await pause();
  const keyboard = await read();
  assert.equal(
    await cdp.evaluate('document.querySelector("#status").textContent'),
    "idle",
    "committed keyboard angle must clear the preview status",
  );
  assert.ok(
    Math.abs(
      getOrientedRectangleGeometry(keyboard[0].orientedBox).rotation -
        hostRectangle.rotation -
        (2 * Math.PI) / 180,
    ) < 1e-8,
  );
  await click("#undo");
  assert.deepEqual(await read(), hostBaseline);
  await cdp.evaluate('document.querySelector("#rotate-keys").focus()');
  await key("keyDown", "ArrowRight", 8);
  await key("keyUp", "ArrowRight", 8);
  await pause();
  assert.ok(
    Math.abs(
      getOrientedRectangleGeometry((await read())[0].orientedBox).rotation -
        hostRectangle.rotation -
        (15 * Math.PI) / 180,
    ) < 1e-8,
  );
  await click("#undo");
  await cdp.evaluate('document.querySelector("#rotate-keys").focus()');
  await key("keyDown", "ArrowRight");
  await key("keyDown", "Escape");
  await key("keyUp", "Escape");
  await key("keyDown", "ArrowRight", 0, true);
  await pause();
  assert.deepEqual(await read(), hostBaseline);
  assert.ok(
    Math.abs(
      (await angleReadout()) - (hostRectangle.rotation * 180) / Math.PI,
    ) < 0.01,
    "a held repeat must not restart a cancelled preview before keyup",
  );
  await key("keyUp", "ArrowRight");
  await pause();
  assert.deepEqual(await read(), hostBaseline);
  await key("keyDown", "ArrowRight");
  await key("keyUp", "ArrowRight");
  await pause();
  assert.ok(
    Math.abs(
      getOrientedRectangleGeometry((await read())[0].orientedBox).rotation -
        hostRectangle.rotation -
        Math.PI / 180,
    ) < 1e-8,
  );
  await click("#undo");
  assert.deepEqual(await read(), hostBaseline);
  results.push(
    "focused keyboard rotation: idle Escape preserves fresh arrow, held-repeat Escape stays cancelled until release, 1/15-degree edits undo once",
  );
  await mkdir(artifactDirectory, { recursive: true });
  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
  });
  await writeFile(
    `${artifactDirectory}/oriented-box-editing.png`,
    Buffer.from(screenshot.data, "base64"),
  );
  await writeFile(
    `${artifactDirectory}/oriented-box-editing-browser.json`,
    JSON.stringify(
      {
        url,
        results,
        initial,
        rotated,
        resized,
        created,
        edgeCreated,
        edgeRotated,
        edgeTarget,
        host,
        edgeScale,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: results.length, results }, null, 2));
} finally {
  cdp.close();
  await closeTarget(chrome, target.id);
}
