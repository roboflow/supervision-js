import { createMediaSession } from "supervision";
import { durationFixtures } from "../../test/fixtures/video-duration/data";

const result = document.querySelector<HTMLPreElement>("#result")!;
const button = document.querySelector<HTMLButtonElement>("#run")!;
button.onclick = async () => {
  button.disabled = true;
  const rows: unknown[] = [];
  try {
    for (const [name, header] of [
      ["finite-vfr", 0.113333],
      ["finite-vfr", 102],
      ["finite-vfr", null],
      ["offset-vfr", null],
    ] as const) {
      const data = Uint8Array.from(atob(durationFixtures[name]!), (c) =>
        c.charCodeAt(0),
      );
      if (header !== null) {
        const type = data.findIndex(
          (_, i) => String.fromCharCode(...data.subarray(i, i + 4)) === "mdhd",
        );
        const view = new DataView(data.buffer);
        view.setUint32(
          type + 20,
          Math.round(header * view.getUint32(type + 16)),
        );
      }
      const url = URL.createObjectURL(new Blob([data], { type: "video/mp4" }));
      const sourceStart = name === "offset-vfr" ? 2 : 0;
      const session = await createMediaSession({
        detections: {
          frames: [
            {
              mediaTime: sourceStart,
              endTime: sourceStart + 0.2,
              detections: [
                { id: "early", rect: { x: 0, y: 0, width: 8, height: 8 } },
              ],
            },
            {
              mediaTime: sourceStart + 3.2,
              endTime: sourceStart + 3.4,
              detections: [
                { id: "late", rect: { x: 8, y: 8, width: 8, height: 8 } },
              ],
            },
          ],
        },
        container: document.querySelector<HTMLDivElement>("#video")!,
        media: url,
        renderer: { autoPlay: false },
      });
      try {
        const state = session.getState().renderer!;
        const start = state.source?.firstTimestamp ?? 0;
        await session.seek(start + state.duration!);
        const frame = await session.captureFrame();
        const expectedLast = start + 3.2;
        const activeDetectionTime =
          session.getState().renderer?.activeDetectionFrameTime;
        const row = {
          name,
          header,
          duration: state.duration,
          firstTimestamp: start,
          lastFrame: frame.mediaTime,
          expectedLast,
          activeDetectionTime,
          passed:
            Math.abs(state.duration! - 3.4) < 0.00001 &&
            Math.abs(frame.mediaTime - expectedLast) < 0.00001 &&
            activeDetectionTime != null &&
            Math.abs(activeDetectionTime - expectedLast) < 0.00001,
        };
        rows.push(row);
        result.textContent = JSON.stringify(rows, null, 2);
        if (!row.passed) throw new Error("Duration or last-frame regression");
      } finally {
        session.destroy();
        URL.revokeObjectURL(url);
      }
    }
    result.textContent =
      "PASS: all four real-decoder cases\n" + JSON.stringify(rows, null, 2);
  } catch (error) {
    result.textContent =
      "FAIL: " + String(error) + "\n" + JSON.stringify(rows, null, 2);
  } finally {
    button.disabled = false;
  }
};
