/**
 * A synthetic stereo scene, ray cast on the CPU: the disparity a stereo
 * matcher would report for a left camera at any resolution, for the depth
 * benchmark. It is never presented as model output.
 *
 * Camera: pinhole at the origin looking down +z with image y down. The focal
 * length is 1000 px at 1280 px wide and scales with width, so every resolution
 * sees the same field of view; the baseline is 0.12 m. Invalid pixels come
 * from what a real matcher loses: a left border band with no match in the
 * right image, occlusion shadows left of foreground objects, sky, a
 * textureless monitor and a few blob holes. Each frame also carries a handful
 * of "flying pixel" outliers. The animation loops every `SYNTHETIC_PERIOD_SECONDS`.
 *
 * Ported from the depth-map rendering research prototype.
 */

export const SYNTHETIC_PERIOD_SECONDS = 8;
export const SYNTHETIC_BASELINE_M = 0.12;

const BASE_WIDTH = 1280;
const BASE_FOCAL_PX = 1000;
const FLOOR_Y = 1.2;
const WALL_TOP = -1.4;
const BACK_Z = 8;
const LEFT_X = -2.6;
const RIGHT_X = 3.0;
const FAR_Z = 40;
const WINDOW = { x0: 0.6, x1: 2.2, y0: -1.0, y1: 0.1 };
const MONITOR = { x0: -1.6, x1: -0.4, y0: -0.6, y1: 0.1 };

type Vector3 = readonly [number, number, number];

interface Sphere {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly r: number;
}

interface Box {
  readonly min: Vector3;
  readonly max: Vector3;
}

interface Intrinsics {
  readonly fx: number;
  readonly fy: number;
  readonly cx: number;
  readonly cy: number;
  readonly fxB: number;
}

const Surface = {
  Sky: 0,
  Floor: 1,
  BackWall: 2,
  LeftWall: 3,
  RightWall: 4,
  Building: 5,
  Monitor: 6,
} as const;

type Surface = (typeof Surface)[keyof typeof Surface];

export interface SyntheticDisparity {
  readonly width: number;
  readonly height: number;
  /** Disparity times `scale`, 0 where the matcher found nothing. */
  readonly values: Uint16Array;
  readonly scale: number;
  readonly fxPx: number;
  readonly baselineM: number;
}

export function syntheticIntrinsics(width: number, height: number): Intrinsics {
  const fx = (BASE_FOCAL_PX * width) / BASE_WIDTH;

  return {
    cx: (width - 1) / 2,
    cy: (height - 1) / 2,
    fx,
    fxB: fx * SYNTHETIC_BASELINE_M,
    fy: fx,
  };
}

function sceneAt(timeSeconds: number) {
  const w = (2 * Math.PI) / SYNTHETIC_PERIOD_SECONDS;
  const t = timeSeconds;
  const pulse = Math.max(0, Math.cos(w * t - 1.0)) ** 8;
  const slidingX = 0.3 + 2.3 * Math.sin(w * t);
  const spheres: Sphere[] = [
    {
      cx: -1.0 + 0.8 * Math.sin(w * t),
      cy: FLOOR_Y - 0.35,
      cz: 3.5 + 2.3 * Math.cos(w * t),
      r: 0.35,
    },
    {
      cx: 1.0 * Math.cos(2 * w * t),
      cy: -0.3 + 0.25 * Math.sin(3 * w * t),
      cz: 2.4 + 0.8 * Math.sin(2 * w * t),
      r: 0.25,
    },
    {
      cx: -0.55,
      cy: 0.35,
      cz: 3.55 - 3.0 * pulse,
      r: 0.18,
    },
  ];
  const boxes: Box[] = [
    {
      max: [1.9, FLOOR_Y, 5.2],
      min: [0.7, 0.45, 4.2],
    },
    {
      max: [slidingX + 0.25, FLOOR_Y, 6.75],
      min: [slidingX - 0.25, -0.5, 6.4],
    },
  ];

  return { boxes, spheres };
}

function hash2(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);

  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function mulberry32(seed: number): () => number {
  let state = seed;

  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-resolution blob holes and per-pixel noise, fixed across frames. */
function staticTables(width: number, height: number) {
  const s = width / BASE_WIDTH;
  const holes = new Uint8Array(width * height);
  const noise = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      holes[i] = valueNoise(x / (40 * s), y / (40 * s)) > 0.9 ? 1 : 0;
      // Triangular in [-1, 1].
      noise[i] = hash2(x, y) + hash2(x + 7919, y + 104729) - 1;
    }
  }

  return { holes, noise };
}

function rayBox(u: number, v: number, box: Box): number {
  const iu = 1 / u;
  const iv = 1 / v;
  let t1 = box.min[0] * iu;
  let t2 = box.max[0] * iu;
  let near = Math.min(t1, t2);
  let far = Math.max(t1, t2);

  t1 = box.min[1] * iv;
  t2 = box.max[1] * iv;
  near = Math.max(near, Math.min(t1, t2));
  far = Math.min(far, Math.max(t1, t2));
  near = Math.max(near, box.min[2]);
  far = Math.min(far, box.max[2]);

  return near <= far && near > 0 ? near : Infinity;
}

function raySphere(u: number, v: number, sphere: Sphere): number {
  const a = u * u + v * v + 1;
  const b = u * sphere.cx + v * sphere.cy + sphere.cz;
  const c =
    sphere.cx * sphere.cx +
    sphere.cy * sphere.cy +
    sphere.cz * sphere.cz -
    sphere.r * sphere.r;
  const discriminant = b * b - a * c;

  if (discriminant < 0) return Infinity;
  const t = (b - Math.sqrt(discriminant)) / a;
  return t > 0 ? t : Infinity;
}

/** Room planes and the far building: z (Infinity for sky) and the surface hit. */
function castRoom(u: number, v: number): { z: number; surface: Surface } {
  let z = Infinity;
  let surface: Surface = Surface.Sky;

  if (v > 0) {
    z = FLOOR_Y / v;
    surface = Surface.Floor;
  }

  const yb = v * BACK_Z;
  const xb = u * BACK_Z;
  const throughWindow =
    xb > WINDOW.x0 && xb < WINDOW.x1 && yb > WINDOW.y0 && yb < WINDOW.y1;

  if (BACK_Z < z && yb >= WALL_TOP && !throughWindow) {
    z = BACK_Z;
    surface =
      xb > MONITOR.x0 && xb < MONITOR.x1 && yb > MONITOR.y0 && yb < MONITOR.y1
        ? Surface.Monitor
        : Surface.BackWall;
  }
  if (u < 0) {
    const zl = LEFT_X / u;
    if (zl < z && zl <= BACK_Z && v * zl >= WALL_TOP) {
      z = zl;
      surface = Surface.LeftWall;
    }
  }
  if (u > 0) {
    const zr = RIGHT_X / u;
    if (zr < z && zr <= BACK_Z && v * zr >= WALL_TOP) {
      z = zr;
      surface = Surface.RightWall;
    }
  }
  if (z === Infinity || z > FAR_Z) {
    const yf = v * FAR_Z;
    const xf = u * FAR_Z;
    if (yf > -11 && xf > -14 && xf < 22) {
      z = FAR_Z;
      surface = Surface.Building;
    } else {
      z = Infinity;
      surface = Surface.Sky;
    }
  }

  return { surface, z };
}

function projectBounds(
  width: number,
  height: number,
  k: Intrinsics,
  points: readonly Vector3[],
): [number, number, number, number] {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;

  for (const [X, Y, Z] of points) {
    const px = k.cx + (k.fx * X) / Z;
    const py = k.cy + (k.fy * Y) / Z;
    x0 = Math.min(x0, px);
    x1 = Math.max(x1, px);
    y0 = Math.min(y0, py);
    y1 = Math.max(y1, py);
  }

  return [
    Math.max(0, Math.floor(x0) - 2),
    Math.min(width - 1, Math.ceil(x1) + 2),
    Math.max(0, Math.floor(y0) - 2),
    Math.min(height - 1, Math.ceil(y1) + 2),
  ];
}

function sphereBounds(width: number, height: number, k: Intrinsics, s: Sphere) {
  const r = s.r * 1.05;
  const nearZ = Math.max(0.05, s.cz - r);
  const points: Vector3[] = [];

  for (const dx of [-r, r]) {
    for (const dy of [-r, r]) {
      for (const z of [nearZ, s.cz + r]) points.push([s.cx + dx, s.cy + dy, z]);
    }
  }

  return projectBounds(width, height, k, points);
}

function boxBounds(width: number, height: number, k: Intrinsics, b: Box) {
  const points: Vector3[] = [];

  for (const X of [b.min[0], b.max[0]]) {
    for (const Y of [b.min[1], b.max[1]]) {
      for (const Z of [b.min[2], b.max[2]]) points.push([X, Y, Z]);
    }
  }

  return projectBounds(width, height, k, points);
}

/** Metric z-depth in metres for every pixel, 0 where stereo finds nothing. */
export function renderSyntheticDepth(
  width: number,
  height: number,
  timeSeconds: number,
): Float32Array {
  const k = syntheticIntrinsics(width, height);
  const scene = sceneAt(timeSeconds);
  const { holes, noise } = staticTables(width, height);
  const out = new Float32Array(width * height);
  const us = new Float32Array(width);

  for (let x = 0; x < width; x += 1) us[x] = (x - k.cx) / k.fx;

  // Room. A negative value is invalid but still occludes what is behind it.
  for (let y = 0; y < height; y += 1) {
    const v = (y - k.cy) / k.fy;
    const row = y * width;

    for (let x = 0; x < width; x += 1) {
      const { surface, z } = castRoom(us[x], v);
      out[row + x] =
        surface === Surface.Monitor || z === Infinity ? -z || -1 : z;
    }
  }

  // Objects, only inside their projected bounds.
  for (const sphere of scene.spheres) {
    const [x0, x1, y0, y1] = sphereBounds(width, height, k, sphere);
    for (let y = y0; y <= y1; y += 1) {
      const v = (y - k.cy) / k.fy;
      const row = y * width;
      for (let x = x0; x <= x1; x += 1) {
        const z = raySphere(us[x], v, sphere);
        if (z < Math.abs(out[row + x])) out[row + x] = z;
      }
    }
  }
  for (const box of scene.boxes) {
    const [x0, x1, y0, y1] = boxBounds(width, height, k, box);
    for (let y = y0; y <= y1; y += 1) {
      const v = (y - k.cy) / k.fy;
      const row = y * width;
      for (let x = x0; x <= x1; x += 1) {
        const z = rayBox(us[x], v, box);
        if (z < Math.abs(out[row + x])) out[row + x] = z;
      }
    }
  }

  // Stereo occlusion and the left border, noise and holes, right to left.
  const noiseScale = 0.003;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let minRight = Infinity;

    for (let x = width - 1; x >= 0; x -= 1) {
      const i = row + x;
      const raw = out[i];
      const z = Math.abs(raw);

      if (!Number.isFinite(z)) {
        out[i] = 0;
        continue;
      }

      // Where this point lands in the right image.
      const xRight = x - k.fxB / z;
      const occluded = xRight < 0 || xRight > minRight + 0.5;
      if (xRight < minRight) minRight = xRight;
      if (raw <= 0 || occluded || holes[i]) {
        out[i] = 0;
        continue;
      }
      out[i] = z + noise[i] * noiseScale * z * z;
    }
  }

  // Flying-pixel outliers, fresh every frame.
  const random = mulberry32(Math.round(timeSeconds * 997) + 12345);
  const count = Math.max(8, Math.round(width * height * 2e-5));
  for (let n = 0; n < count; n += 1) {
    const i = Math.floor(random() * width * height);
    out[i] = 0.25 * Math.exp(random() * Math.log(60 / 0.25));
  }

  return out;
}

/**
 * The scene's disparity as a stereo producer stores it: `round(d * scale)` in
 * a Uint16Array, clamped to the largest code, 0 where there is no depth.
 */
export function renderSyntheticDisparity(
  width: number,
  height: number,
  timeSeconds: number,
  scale = 256,
): SyntheticDisparity {
  const depth = renderSyntheticDepth(width, height, timeSeconds);
  const k = syntheticIntrinsics(width, height);
  const values = new Uint16Array(width * height);

  for (let i = 0; i < depth.length; i += 1) {
    const z = depth[i];
    values[i] =
      z > 0 ? Math.min(65535, Math.max(1, Math.round((k.fxB / z) * scale))) : 0;
  }

  return {
    baselineM: SYNTHETIC_BASELINE_M,
    fxPx: k.fx,
    height,
    scale,
    values,
    width,
  };
}
