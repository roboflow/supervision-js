import {
  StrokeAlignment,
  type Point,
  type StrokeStyle,
} from "supervision-js-core";
import type { Graphics as PixiGraphics } from "pixi.js";

export function resolveScreenLength(value: number, viewportScale: number) {
  return value / Math.max(viewportScale, Number.EPSILON);
}

export function drawPixiPath(
  graphics: PixiGraphics,
  points: readonly Point[],
  closed: boolean,
  stroke: StrokeStyle,
  viewportScale: number,
) {
  if (points.length < 2) {
    return;
  }

  if (stroke.dash?.length) {
    appendDashedPath(graphics, points, closed, stroke.dash, viewportScale);
  } else {
    graphics.moveTo(points[0]!.x, points[0]!.y);

    for (let index = 1; index < points.length; index += 1) {
      graphics.lineTo(points[index]!.x, points[index]!.y);
    }

    if (closed) {
      graphics.closePath();
    }
  }

  graphics.stroke(resolvePixiStroke(stroke, viewportScale));
}

export function resolvePixiStroke(stroke: StrokeStyle, viewportScale: number) {
  const pixiStroke = {
    alpha: stroke.alpha,
    color: stroke.color,
    width: resolveScreenLength(stroke.width, viewportScale),
  };

  if (stroke.alignment === undefined) return pixiStroke;

  return {
    ...pixiStroke,
    alignment:
      stroke.alignment === StrokeAlignment.Inside
        ? 1
        : stroke.alignment === StrokeAlignment.Outside
          ? 0
          : 0.5,
  };
}

function appendDashedPath(
  graphics: PixiGraphics,
  points: readonly Point[],
  closed: boolean,
  dashPattern: readonly number[],
  viewportScale: number,
) {
  const pattern = dashPattern
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => resolveScreenLength(value, viewportScale));

  if (pattern.length === 0) {
    return;
  }

  if (pattern.length % 2 === 1) {
    pattern.push(...pattern);
  }

  let patternIndex = 0;
  let patternRemaining = pattern[0]!;
  let drawing = true;
  const segmentCount = closed ? points.length : points.length - 1;

  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    const start = points[segmentIndex]!;
    const end = points[(segmentIndex + 1) % points.length]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);

    if (length <= Number.EPSILON) {
      continue;
    }

    let offset = 0;

    while (offset < length) {
      const step = Math.min(patternRemaining, length - offset);
      const startRatio = offset / length;
      const endRatio = (offset + step) / length;
      const x1 = start.x + dx * startRatio;
      const y1 = start.y + dy * startRatio;
      const x2 = start.x + dx * endRatio;
      const y2 = start.y + dy * endRatio;

      if (drawing) {
        graphics.moveTo(x1, y1);
        graphics.lineTo(x2, y2);
      }

      offset += step;
      patternRemaining -= step;

      if (patternRemaining <= Number.EPSILON) {
        patternIndex = (patternIndex + 1) % pattern.length;
        patternRemaining = pattern[patternIndex]!;
        drawing = !drawing;
      }
    }
  }
}
