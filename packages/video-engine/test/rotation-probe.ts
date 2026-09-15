import { uvRotationMatrix, type Rotation } from "../src/rotation";

/**
 * Which quarter of a source frame ends up in a given quarter of the destination.
 * Named as the corners a person reading a screenshot would name, so a claim here
 * is checkable against a screenshot of the same clip.
 */
type Corner = "TL" | "TR" | "BL" | "BR";
type CornerMap = Record<Corner, Corner>;

/** Centre of each quarter, in the unit square. */
const CORNER_CENTRES: ReadonlyArray<readonly [Corner, number, number]> = [
  ["TL", 0.25, 0.25],
  ["TR", 0.75, 0.25],
  ["BL", 0.25, 0.75],
  ["BR", 0.75, 0.75],
];

function cornerAt(u: number, v: number): Corner {
  const left = u < 0.5;
  return v < 0.5 ? (left ? "TL" : "TR") : left ? "BL" : "BR";
}

/** Canvas transform: x' = a*x + c*y + e, y' = b*x + d*y + f. */
type Matrix = readonly [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function compose(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * A 2D context that keeps only the transform stack and the destination rect a
 * drawImage was issued into. Enough to say where each quarter of the source
 * landed, which is the whole question a rotation raises and the one a node test
 * cannot answer by reading pixels.
 */
export class TransformRecorder {
  private matrix: Matrix = IDENTITY;
  private readonly stack: Matrix[] = [];
  private placement: {
    matrix: Matrix;
    dx: number;
    dy: number;
    dWidth: number;
    dHeight: number;
  } | null = null;

  save(): void {
    this.stack.push(this.matrix);
  }

  restore(): void {
    this.matrix = this.stack.pop() ?? IDENTITY;
  }

  translate(tx: number, ty: number): void {
    this.matrix = compose(this.matrix, [1, 0, 0, 1, tx, ty]);
  }

  rotate(radians: number): void {
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    this.matrix = compose(this.matrix, [cos, sin, -sin, cos, 0, 0]);
  }

  scale(sx: number, sy: number): void {
    this.matrix = compose(this.matrix, [sx, 0, 0, sy, 0, 0]);
  }

  drawImage(
    _image: unknown,
    dx: number,
    dy: number,
    dWidth: number,
    dHeight: number,
  ): void {
    this.placement = { matrix: this.matrix, dx, dy, dWidth, dHeight };
  }

  /** Which quarter of the source landed in each quarter of the destination box.
   *  Throws when nothing was drawn, so a silent no-op cannot read as an
   *  unrotated pass. */
  cornersOver(
    width: number,
    height: number,
    originX = 0,
    originY = 0,
  ): CornerMap {
    const placed = this.placement;
    if (!placed) throw new Error("TransformRecorder: nothing was drawn");
    const map: Partial<CornerMap> = {};
    for (const [corner, u, v] of CORNER_CENTRES) {
      const [x, y] = apply(
        placed.matrix,
        placed.dx + u * placed.dWidth,
        placed.dy + v * placed.dHeight,
      );
      map[cornerAt((x - originX) / width, (y - originY) / height)] = corner;
    }
    return map as CornerMap;
  }

  asContext(): OffscreenCanvasRenderingContext2D {
    return this as unknown as OffscreenCanvasRenderingContext2D;
  }
}

/**
 * Ground truth, measured in Chrome off ffmpeg fixtures whose four quarters are
 * solid RED / GRN / BLU / WHT clockwise from the top left. Every entry is what
 * mediabunny's own VideoSampleSink and CanvasSink paint for a clip carrying
 * that rotation, so a runtime path disagreeing with one of these disagrees with
 * mediabunny on the same file.
 */
const MEDIABUNNY_PAINTED: Record<Rotation, string> = {
  0: "TL=RED TR=GRN BL=BLU BR=WHT",
  90: "TL=BLU TR=RED BL=WHT BR=GRN",
  180: "TL=WHT TR=BLU BL=GRN BR=RED",
  270: "TL=GRN TR=WHT BL=RED BR=BLU",
};

const SOURCE_QUADRANTS: Record<string, Corner> = {
  RED: "TL",
  GRN: "TR",
  BLU: "BL",
  WHT: "BR",
};

/** MEDIABUNNY_PAINTED read as a corner map. */
export function paintedCorners(rotation: Rotation): CornerMap {
  const map: Partial<CornerMap> = {};
  for (const pair of MEDIABUNNY_PAINTED[rotation].split(" ")) {
    const [destination, colour] = pair.split("=");
    map[destination as Corner] = SOURCE_QUADRANTS[colour];
  }
  return map as CornerMap;
}

/** The turned display size of the 640x360 landscape fixture. */
export function turnedSize(rotation: Rotation): [number, number] {
  return rotation % 180 === 0 ? [640, 360] : [360, 640];
}

export const QUARTER_TURNS: readonly Rotation[] = [0, 90, 180, 270];

/** The same question asked of the WebGPU shader: for each quarter of the
 *  destination, which quarter of the source its texture coordinates read. */
export function shaderCorners(rotation: Rotation): CornerMap {
  const [m00, m01, m10, m11] = uvRotationMatrix(rotation);
  const map: Partial<CornerMap> = {};
  for (const [corner, u, v] of CORNER_CENTRES) {
    const dx = u - 0.5;
    const dy = v - 0.5;
    map[corner] = cornerAt(
      m00 * dx + m01 * dy + 0.5,
      m10 * dx + m11 * dy + 0.5,
    );
  }
  return map as CornerMap;
}
