import {
  annotationRenderers,
  BaseOrientedBoxStyle,
  createMediaSession,
  createStaticImageMediaSource,
  type Detection,
  type MediaSession,
  type OrientedBoxGeometry,
} from "supervision";
import {
  AnnotationGeometryKind,
  AnnotationHandleKind,
  AnnotationGestureStateKind,
  createAnnotationEditingEngine,
  createOrientedBoxGeometry,
  distanceToSegment,
  getOrientedRectangleGeometry,
  type PreviewOverlayData,
  type AnnotationPointerInput,
} from "supervision/editing";
import "./oriented-box.css";

const viewer = document.querySelector<HTMLDivElement>("#viewer")!;
const status = document.querySelector<HTMLOutputElement>("#status")!;
const angle = document.querySelector<HTMLInputElement>("#angle")!;
const heading = document.querySelector<HTMLInputElement>("#heading")!;
const rotateKeys = document.querySelector<HTMLButtonElement>("#rotate-keys")!;
const output = document.querySelector<HTMLPreElement>("#geometry")!;
let detections: readonly Detection[] = [
  {
    id: "rectangle-0",
    orientedBox: createOrientedBoxGeometry(
      { x: 390, y: 240, width: 180, height: 70 },
      Math.PI / 5,
    ),
  },
];
const history: (readonly Detection[])[] = [];
const future: (readonly Detection[])[] = [];
let nextId = 1;
let session: MediaSession;
let selectedId: string | number | undefined = "rectangle-0";
let hostPreview: Detection | null = null;
let keyboardCancelled = false;
let rotationKeyHeld = false;
type FrontPress = {
  readonly detection: Detection;
  readonly edge: number;
  readonly point: { x: number; y: number };
  readonly original: readonly Detection[];
  readonly pointerId: number | undefined;
  readonly drawing: boolean;
  moved: boolean;
};
let frontPress: FrontPress | null = null;
function frontEdge(point: { x: number; y: number }) {
  const detection = selected();
  if (
    !heading.checked ||
    detection?.locked ||
    !detection?.orientedBox ||
    !rectangle(detection)
  )
    return null;
  const scale = session.renderer.getViewportTransform().scale;
  const points = detection.orientedBox.points;
  if (
    points.some(
      (corner) =>
        Math.hypot(point.x - corner.x, point.y - corner.y) * scale < 10,
    )
  )
    return null;
  const distances = points.map(
    (from, index) =>
      distanceToSegment(point, from, points[(index + 1) % 4]!) * scale,
  );
  const edge = distances.indexOf(Math.min(...distances));
  return distances[edge]! <= 8 ? { detection, edge } : null;
}
function plainPrimary(
  input: Pick<
    AnnotationPointerInput,
    "button" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey"
  >,
) {
  return (
    !input.button &&
    !input.shiftKey &&
    !input.metaKey &&
    !input.ctrlKey &&
    !input.altKey
  );
}
function mediaPoint(event: MouseEvent) {
  const bounds = viewer.getBoundingClientRect();
  return session.renderer.screenToMedia({
    x: event.clientX - bounds.left - viewer.clientLeft,
    y: event.clientY - bounds.top - viewer.clientTop,
  });
}
let rendering = Promise.resolve();

const degrees = (radians: number) => (radians * 180) / Math.PI;
const radians = (value: number) => (value * Math.PI) / 180;
// This is host policy, shared by pointer and keyboard rotation.
const resolveAngle = (value: number, snap: boolean) =>
  snap ? Math.round(value / radians(15)) * radians(15) : value;
const selected = () => detections.find((item) => item.id === selectedId);
const rectangle = (detection: Detection | undefined | null) =>
  detection?.orientedBox
    ? getOrientedRectangleGeometry(detection.orientedBox)
    : null;
function displayedDetections() {
  const preview = hostPreview;
  return preview
    ? detections.map((item) => (item.id === preview.id ? preview : item))
    : detections;
}
function updateControls(force = false) {
  const geometry = rectangle(
    hostPreview ?? engine.getState().preview ?? selected(),
  );
  angle.disabled = rotateKeys.disabled = !geometry;
  for (const id of ["next-front", "reverse-front"])
    document.querySelector<HTMLButtonElement>(`#${id}`)!.disabled =
      !geometry || !heading.checked;
  if (force || document.activeElement !== angle)
    angle.value = geometry
      ? String(Number(degrees(geometry.rotation).toFixed(3)))
      : "";
}
function commit(detection: Detection, previous: Detection | null) {
  hostPreview = null;
  if (previous && JSON.stringify(previous) === JSON.stringify(detection))
    return;
  history.push(detections);
  future.length = 0;
  detections = previous
    ? detections.map((item) => (item.id === previous.id ? detection : item))
    : [...detections, detection];
  if (!previous) {
    nextId += 1;
    engine.setCreationTool(null);
  }
  void render(detection.id);
}
function finishHostPreview(cancel = false) {
  if (!hostPreview) return;
  const preview = hostPreview;
  hostPreview = null;
  if (cancel) void render();
  else commit(preview, selected() ?? null);
  status.textContent = engine.getState().kind;
  updateControls(true);
}
function previewAngle(value: number) {
  const detection = selected();
  const geometry = rectangle(detection);
  if (!detection || !geometry || !Number.isFinite(value)) return;
  engine.cancel();
  hostPreview = {
    ...detection,
    orientedBox: createOrientedBoxGeometry(geometry, value),
  };
  status.textContent = "Angle preview";
  void render();
}
// Front is local +x (edge 1) in this host. Reindexing preserves every vertex.
function chooseFront(edge: number) {
  finishHostPreview();
  const detection = selected();
  if (!heading.checked || !detection?.orientedBox || !rectangle(detection))
    return;
  const points = detection.orientedBox.points;
  const first = (edge + 3) % 4;
  commit(
    {
      ...detection,
      orientedBox: {
        points: [
          points[first]!,
          points[(first + 1) % 4]!,
          points[(first + 2) % 4]!,
          points[(first + 3) % 4]!,
        ],
      },
    },
    detection,
  );
}
function headingOverlay(): PreviewOverlayData | null {
  if (!heading.checked) return null;
  const preview = engine.getState().preview;
  const scale = session?.renderer.getViewportTransform().scale ?? 1;
  const triangles = displayedDetections().flatMap((item) => {
    const detection = preview?.id === item.id ? preview : item;
    const geometry = rectangle(detection);
    if (!geometry) return [];
    const cos = Math.cos(geometry.rotation);
    const sin = Math.sin(geometry.rotation);
    const size = Math.min(7 / scale, geometry.width / 5, geometry.height / 4);
    const tip = {
      x: geometry.x + cos * (geometry.width / 2 - size),
      y: geometry.y + sin * (geometry.width / 2 - size),
    };
    return [
      [
        tip,
        {
          x: tip.x - cos * size - (sin * size) / 2,
          y: tip.y - sin * size + (cos * size) / 2,
        },
        {
          x: tip.x - cos * size + (sin * size) / 2,
          y: tip.y - sin * size - (cos * size) / 2,
        },
      ],
    ];
  });
  return { draftPolygons: triangles };
}
const engine = createAnnotationEditingEngine({
  viewportScale: () => session?.renderer.getViewportTransform().scale ?? 1,
  rotationHandle: { edgeIndex: 0, offset: 32 },
  resolveRotation: (value, { input }) =>
    resolveAngle(value, Boolean(input.shiftKey)),
  onCommit: commit,
  onStateChange(state) {
    status.textContent = state.kind;
    updateControls();
  },
});

// A deterministic still image makes this example self-contained and usable offline.
const image = document.createElement("canvas");
image.width = 800;
image.height = 500;
const context = image.getContext("2d")!;
context.fillStyle = "#152332";
context.fillRect(0, 0, 800, 500);
context.strokeStyle = "#243b50";
for (let x = 0; x <= 800; x += 50) {
  context.beginPath();
  context.moveTo(x, 0);
  context.lineTo(x, 500);
  context.stroke();
}
for (let y = 0; y <= 500; y += 50) {
  context.beginPath();
  context.moveTo(0, y);
  context.lineTo(800, y);
  context.stroke();
}
context.save();
context.translate(390, 240);
context.rotate(Math.PI / 5);
context.fillStyle = "#627b8f";
context.fillRect(-90, -35, 180, 70);
context.fillStyle = "#a5bac8";
context.fillRect(-65, -22, 35, 44);
context.fillRect(30, -22, 35, 44);
context.restore();

function render(id = selectedId) {
  selectedId = id;
  output.textContent = JSON.stringify(detections, null, 2);
  updateControls();
  if (!session) return Promise.resolve();
  rendering = rendering.then(async () => {
    await session.replaceDetectionFrames([
      { mediaTime: 0, detections: displayedDetections() },
    ]);
    await session.refresh();
    session.renderer.setSelectedDetection(
      selectedId === undefined
        ? { detectionIds: [] }
        : { detectionId: selectedId },
    );
  });
  return rendering;
}

async function start() {
  session = await createMediaSession({
    container: viewer,
    media: createStaticImageMediaSource(image),
    detections: { appendable: { datasetId: "oriented-box-example" } },
    presentation: {
      renderers: [
        annotationRenderers.orientedBox({
          style: new BaseOrientedBoxStyle({
            fill: { alpha: 0.12 },
            stroke: { color: 0x71e3bb, width: 2 },
          }),
        }),
      ],
    },
    renderer: {
      autoPlay: false,
      editingEngine: engine,
      previewOverlay: headingOverlay,
      interaction: {
        onPointerPress({ input, pick, selectedHandle }) {
          frontPress = null;
          if (!plainPrimary(input)) return "continue";
          const edge = frontEdge(input.point);
          if (!edge || (pick && pick.detection.id !== edge.detection.id))
            return "continue";
          if (selectedHandle) {
            const points = edge.detection.orientedBox!.points;
            const from = points[edge.edge]!;
            const to = points[(edge.edge + 1) % 4]!;
            const handle = selectedHandle.handle;
            if (
              handle.kind !== AnnotationHandleKind.Resize ||
              selectedHandle.pick.detection.id !== edge.detection.id ||
              Math.hypot(
                handle.point.x - (from.x + to.x) / 2,
                handle.point.y - (from.y + to.y) / 2,
              ) > 1e-6
            )
              return "continue";
          }
          frontPress = {
            ...edge,
            point: input.point,
            original: detections,
            pointerId: input.pointerId,
            drawing: engine.hasCreationTool(),
            moved: false,
          };
          // Preserve the selected outline when the press falls just outside it.
          return selectedHandle || (pick && !engine.hasCreationTool())
            ? "continue"
            : "handled";
        },
        onSelect(pick) {
          selectedId = pick?.detection.id;
          updateControls();
        },
      },
    },
  });
  await render("rectangle-0");
  updateZoom();
  status.textContent = "Select a rectangle or draw another";
}
function updateZoom() {
  document.querySelector<HTMLOutputElement>("#zoom")!.textContent =
    `${session.renderer.getViewportTransform().scale.toFixed(4)}x`;
}
viewer.addEventListener(
  "wheel",
  (event) => {
    if (!session) return;
    event.preventDefault();
    const bounds = viewer.getBoundingClientRect();
    session.renderer.zoomViewportFromWheel(
      { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      event.deltaY,
    );
    updateZoom();
  },
  { passive: false },
);

// A front choice is a completed click, never a replacement drag engine.
viewer.addEventListener("pointermove", (event) => {
  if (!frontPress || event.pointerId !== frontPress.pointerId) return;
  const point = mediaPoint(event);
  if (
    Math.hypot(point.x - frontPress.point.x, point.y - frontPress.point.y) *
      session.renderer.getViewportTransform().scale >
    4
  )
    frontPress.moved = true;
});
viewer.addEventListener("pointerup", (event) => {
  const press = frontPress;
  frontPress = null;
  if (
    !press ||
    event.pointerId !== press.pointerId ||
    !plainPrimary(event) ||
    press.moved ||
    press.original !== detections ||
    press.drawing !== engine.hasCreationTool() ||
    engine.getState().preview
  )
    return;
  const point = mediaPoint(event);
  if (
    Math.hypot(point.x - press.point.x, point.y - press.point.y) *
      session.renderer.getViewportTransform().scale >
    4
  )
    return;
  const edge = frontEdge(point);
  if (
    !edge ||
    edge.detection.id !== press.detection.id ||
    edge.edge !== press.edge
  )
    return;
  // Let the renderer finish the unchanged midpoint press before committing front.
  queueMicrotask(() => {
    if (
      press.original !== detections ||
      press.drawing !== engine.hasCreationTool()
    )
      return;
    chooseFront(edge.edge);
  });
});
viewer.addEventListener("pointercancel", () => {
  frontPress = null;
});
window.addEventListener("blur", () => {
  frontPress = null;
});

function button(id: string, action: () => void) {
  document
    .querySelector<HTMLButtonElement>(`#${id}`)!
    .addEventListener("click", () => {
      frontPress = null;
      finishHostPreview();
      action();
    });
}
button("select", () => {
  engine.setCreationTool(null);
  status.textContent = "Select";
});
button("draw", () => {
  engine.setCreationTool({
    geometry: AnnotationGeometryKind.OrientedBox,
    createDetection: (points) => ({
      id: `rectangle-${nextId}`,
      orientedBox: { points: points as OrientedBoxGeometry["points"] },
    }),
  });
  status.textContent = "Draw rectangle";
});
function restore(from: (readonly Detection[])[], to: (readonly Detection[])[]) {
  if (engine.getState().kind !== AnnotationGestureStateKind.Idle) {
    engine.cancel();
    return;
  }
  const snapshot = from.pop();
  if (!snapshot) return;
  to.push(detections);
  detections = snapshot;
  if (!detections.some((item) => item.id === selectedId))
    selectedId = detections.at(-1)?.id;
  void render();
}
button("undo", () => restore(history, future));
button("redo", () => restore(future, history));
button("reset", () => {
  const scale = Math.min(viewer.clientWidth / 800, viewer.clientHeight / 500);
  session.renderer.setViewportTransform({
    scale,
    x: (viewer.clientWidth - 800 * scale) / 2,
    y: (viewer.clientHeight - 500 * scale) / 2,
  });
  updateZoom();
});
button("next-front", () => chooseFront(2));
button("reverse-front", () => chooseFront(3));
heading.addEventListener("change", () => {
  frontPress = null;
  finishHostPreview();
  updateControls();
  void session.refresh();
});
angle.addEventListener("input", () => {
  if (angle.value !== "") previewAngle(radians(angle.valueAsNumber));
});
angle.addEventListener("change", () => finishHostPreview());
angle.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    finishHostPreview();
  }
});
rotateKeys.addEventListener("focus", () => {
  rotationKeyHeld = false;
  keyboardCancelled = false;
});
rotateKeys.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  rotationKeyHeld = true;
  if (keyboardCancelled) return;
  const geometry = rectangle(hostPreview ?? selected());
  if (!geometry) return;
  const step = event.shiftKey ? 15 : 1;
  previewAngle(
    geometry.rotation + radians(event.key === "ArrowRight" ? step : -step),
  );
});
rotateKeys.addEventListener("keyup", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  rotationKeyHeld = false;
  keyboardCancelled = false;
  finishHostPreview();
});
rotateKeys.addEventListener("blur", () => {
  rotationKeyHeld = false;
  keyboardCancelled = false;
  finishHostPreview();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    keyboardCancelled = rotationKeyHeld;
    frontPress = null;
    finishHostPreview(true);
    engine.cancel();
    updateControls(true);
  }
});
void start().catch((error: unknown) => {
  status.textContent = String(error);
});
window.addEventListener("pagehide", () => session?.destroy());
