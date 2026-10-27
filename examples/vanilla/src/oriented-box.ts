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
  AnnotationGestureStateKind,
  createAnnotationEditingEngine,
  createOrientedBoxGeometry,
} from "supervision/editing";
import "./oriented-box.css";

const viewer = document.querySelector<HTMLDivElement>("#viewer")!;
const status = document.querySelector<HTMLOutputElement>("#status")!;
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
const engine = createAnnotationEditingEngine({
  viewportScale: () => session?.renderer.getViewportTransform().scale ?? 1,
  onCommit(detection, previous) {
    history.push(detections);
    future.length = 0;
    detections = previous
      ? detections.map((item) => (item.id === previous.id ? detection : item))
      : [...detections, detection];
    nextId += 1;
    engine.setCreationTool(null);
    void render(detection.id);
  },
  onStateChange(state) {
    status.textContent = state.kind;
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

async function render(selectedId?: string | number) {
  output.textContent = JSON.stringify(detections, null, 2);
  if (!session) return;
  await session.replaceDetectionFrames([{ mediaTime: 0, detections }]);
  await session.refresh();
  session.renderer.setSelectedDetection(
    selectedId === undefined
      ? { detectionIds: [] }
      : { detectionId: selectedId },
  );
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
    renderer: { autoPlay: false, editingEngine: engine },
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

function button(id: string, action: () => void) {
  document
    .querySelector<HTMLButtonElement>(`#${id}`)!
    .addEventListener("click", action);
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
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") engine.cancel();
});
void start().catch((error: unknown) => {
  status.textContent = String(error);
});
window.addEventListener("pagehide", () => session?.destroy());
