import type { Graphics } from "pixi.js";
import type { MaskStrokeStyle } from "supervision-js-core";
import type {
  PreparedIdMaskFrame,
  PreparedMaskFrame,
  PreparedMaskScreenStroke,
} from "#render-preparation/mask-frame-artifact";
import { PreparedMaskFrameKind } from "#render-preparation/mask-frame-artifact";
import { traceMaskOutlinePaths } from "#render-preparation/mask-outline-paths";
import { resolvePixiStroke } from "#renderers/pixi-path";

export function createPixiMaskScreenStrokeRenderer(options: {
  readonly Graphics: new () => Graphics;
  readonly mediaWidth: number;
  readonly mediaHeight: number;
}) {
  const display = new options.Graphics();
  display.visible = false;
  let lastFrame: PreparedMaskFrame | undefined;
  let lastSignature = "";
  const interactionPaths = new WeakMap<
    PreparedIdMaskFrame,
    Map<number, Float32Array<ArrayBuffer>[]>
  >();

  function hide() {
    display.visible = false;
    if (lastFrame) display.clear();
    lastFrame = undefined;
    lastSignature = "";
  }

  return {
    display,
    hide,

    destroy() {
      display.destroy();
    },
    render(
      frame: PreparedMaskFrame,
      viewportScale: number,
      overrides?: readonly {
        readonly detectionIndex: number;
        readonly stroke?: MaskStrokeStyle;
      }[],
    ) {
      let strokes = frame.screenStrokes ?? [];
      if (overrides) {
        strokes = overrides.flatMap(
          ({ detectionIndex, stroke }): PreparedMaskScreenStroke[] => {
            if (
              stroke?.widthUnit !== "screen" ||
              stroke.width <= 0 ||
              stroke.alpha <= 0
            )
              return [];
            let paths = frame.screenStrokes?.find(
              (entry) => entry.detectionIndex === detectionIndex,
            )?.paths;
            if (!paths && frame.kind === PreparedMaskFrameKind.IdMask) {
              let cached = interactionPaths.get(frame);
              if (!cached) {
                const ids = new Set(frame.raster);
                ids.delete(0);
                cached = traceMaskOutlinePaths(
                  frame.raster,
                  frame.width,
                  frame.height,
                  ids,
                );
                interactionPaths.set(frame, cached);
              }
              paths = cached.get(detectionIndex + 1);
            }
            return paths ? [{ ...stroke, detectionIndex, paths }] : [];
          },
        );
      }
      if (strokes.length === 0) {
        hide();
        return;
      }
      const signature = `${viewportScale}:${strokes.map(({ detectionIndex, width, color, alpha }) => `${detectionIndex}:${width}:${color}:${alpha}`).join(";")}`;
      if (lastFrame !== frame || lastSignature !== signature) {
        display.clear();
        const scaleX = options.mediaWidth / frame.width;
        const scaleY = options.mediaHeight / frame.height;
        for (const stroke of strokes) {
          for (const path of stroke.paths) {
            if (path.length < 6) continue;
            display.moveTo(path[0]! * scaleX, path[1]! * scaleY);
            for (let index = 2; index < path.length; index += 2)
              display.lineTo(path[index]! * scaleX, path[index + 1]! * scaleY);
            display.closePath();
          }
          display.stroke(
            resolvePixiStroke({ ...stroke, join: "round" }, viewportScale),
          );
        }
        lastFrame = frame;
        lastSignature = signature;
      }
      display.visible = true;
    },
  };
}
