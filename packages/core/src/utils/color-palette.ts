export interface DetectionClassColorStyle {
  readonly fill: number;
  readonly labelBackground: number;
  readonly labelText: number;
  readonly stroke: number;
}

export const SUPERVISION_ROBOFLOW_COLOR = 0xa351fb;

export const DEFAULT_DETECTION_COLOR_SEQUENCE = [
  createClassColorStyle(0x38bdf8, 0x164e63, 0xecfeff, 0x7dd3fc),
  createClassColorStyle(0x22c55e, 0x14532d, 0xf0fdf4, 0x86efac),
  createClassColorStyle(0xa78bfa, 0x4c1d95, 0xf5f3ff, 0xc4b5fd),
  createClassColorStyle(0xfacc15, 0x713f12, 0xfffbeb, 0xfde047),
  createClassColorStyle(0xf97316, 0x7c2d12, 0xfff7ed, 0xffa23a),
  createClassColorStyle(0xf472b6, 0x831843, 0xfdf2f8, 0xf9a8d4),
  createClassColorStyle(0x60a5fa, 0x1e3a8a, 0xeff6ff, 0x93c5fd),
  createClassColorStyle(0xfb7185, 0x881337, 0xfff1f2, 0xfda4af),
  createClassColorStyle(0x34d399, 0x064e3b, 0xecfdf5, 0x6ee7b7),
  createClassColorStyle(0xe879f9, 0x701a75, 0xfdf4ff, 0xf0abfc),
] as const satisfies readonly DetectionClassColorStyle[];

export const DEFAULT_DETECTION_CLASS_STYLES: Readonly<
  Record<string, DetectionClassColorStyle>
> = {
  basketball: DEFAULT_DETECTION_COLOR_SEQUENCE[4],
  bed: DEFAULT_DETECTION_COLOR_SEQUENCE[5],
  bottle: DEFAULT_DETECTION_COLOR_SEQUENCE[4],
  "cell phone": DEFAULT_DETECTION_COLOR_SEQUENCE[8],
  cow: DEFAULT_DETECTION_COLOR_SEQUENCE[2],
  cup: DEFAULT_DETECTION_COLOR_SEQUENCE[3],
  horse: DEFAULT_DETECTION_COLOR_SEQUENCE[0],
  keyboard: DEFAULT_DETECTION_COLOR_SEQUENCE[1],
  knife: DEFAULT_DETECTION_COLOR_SEQUENCE[7],
  laptop: DEFAULT_DETECTION_COLOR_SEQUENCE[6],
  person: DEFAULT_DETECTION_COLOR_SEQUENCE[1],
  "potted plant": DEFAULT_DETECTION_COLOR_SEQUENCE[8],
  "sports ball": DEFAULT_DETECTION_COLOR_SEQUENCE[4],
  tv: DEFAULT_DETECTION_COLOR_SEQUENCE[2],
  "white team player": createClassColorStyle(
    0xf8fafc,
    0x334155,
    0xffffff,
    0xffffff,
  ),
  "yellow team player": DEFAULT_DETECTION_COLOR_SEQUENCE[3],
};

export function resolveDetectionClassColorStyle(
  className: string | undefined,
): DetectionClassColorStyle {
  const normalizedClassName = normalizeDetectionClassName(className);
  const knownStyle = DEFAULT_DETECTION_CLASS_STYLES[normalizedClassName];

  if (knownStyle) {
    return knownStyle;
  }

  return DEFAULT_DETECTION_COLOR_SEQUENCE[
    hashClassName(normalizedClassName) % DEFAULT_DETECTION_COLOR_SEQUENCE.length
  ]!;
}

export function normalizeDetectionClassName(
  className: string | undefined,
): string {
  return (className ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]/g, " ")
    .replace(/\s+/g, " ");
}

function createClassColorStyle(
  fill: number,
  labelBackground: number,
  labelText: number,
  stroke: number,
): DetectionClassColorStyle {
  return {
    fill,
    labelBackground,
    labelText,
    stroke,
  };
}

function hashClassName(className: string) {
  let hash = 0;

  for (let index = 0; index < className.length; index += 1) {
    hash = (hash * 31 + className.charCodeAt(index)) >>> 0;
  }

  return hash;
}
