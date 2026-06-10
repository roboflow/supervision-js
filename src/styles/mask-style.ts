import { resolveStyleValue } from "#styles/style-value";
import type { Detection } from "#types/detections";
import type {
  MaskDrawInstruction,
  MaskStrokeStyle,
  MaskStrokeStyleOptions,
  MaskStyle,
  MaskStyleContext,
} from "#types/mask-style";
import type {
  DetectionStylePredicate,
  DetectionStyleValue,
} from "#types/style";

export interface BaseMaskStyleOptions {
  /**
   * Mask fill color. Pass a resolver for per-class mask colors.
   */
  readonly color?: DetectionStyleValue<number, MaskStyleContext>;
  /**
   * Global mask-layer opacity. This stays outside the prepared artifact so it
   * can be updated cheaply at render time.
   */
  readonly opacity?: number;
  /**
   * Compatibility alias for `opacity`.
   *
   * Prefer `opacity` for new code. Mask draw instructions still use `alpha`
   * internally because renderer backends operate on RGBA-like primitives.
   */
  readonly alpha?: number;
  /**
   * Optional mask outline. Pass a resolver for per-detection outlines.
   */
  readonly stroke?: DetectionStyleValue<
    MaskStrokeStyleOptions | null | undefined,
    MaskStyleContext
  >;
  /**
   * Return false to skip rendering a detection in this mask style.
   */
  readonly shouldRender?: DetectionStylePredicate<MaskStyleContext>;
}

/**
 * Default compressed-RLE mask style.
 *
 * Static color/stroke options can reuse prepared mask artifacts by key. Dynamic
 * color or stroke resolvers intentionally do not expose an artifact key, so new
 * style objects rebuild prepared palettes instead of reusing stale ones.
 */
export class BaseMaskStyle implements MaskStyle {
  readonly artifactKey: string | undefined;
  readonly opacity: number;

  private readonly options: BaseMaskStyleOptions;

  constructor(options: BaseMaskStyleOptions = {}) {
    this.options = options;
    this.opacity = clampOpacity(options.opacity ?? options.alpha ?? 0.35);
    this.artifactKey = createArtifactKey(options);
  }

  resolve(
    detection: Detection,
    context: MaskStyleContext,
  ): MaskDrawInstruction | undefined {
    if (
      !detection.mask ||
      this.options.shouldRender?.(detection, context) === false
    ) {
      return undefined;
    }

    const color =
      resolveStyleValue(this.options.color, detection, context) ??
      DEFAULT_MASK_COLOR;

    return {
      alpha: 1,
      color,
      mask: detection.mask,
      stroke: normalizeStroke(
        resolveStyleValue(this.options.stroke, detection, context),
        color,
      ),
    };
  }
}

const DEFAULT_MASK_COLOR = 0x00ff66;
const DEFAULT_MASK_STROKE_ALPHA = 1;
const DEFAULT_MASK_STROKE_WIDTH = 1;

function clampOpacity(opacity: number) {
  return Number.isFinite(opacity) ? Math.max(0, Math.min(opacity, 1)) : 1;
}

function serializeStroke(stroke: MaskStrokeStyle | undefined) {
  if (!stroke) {
    return "none";
  }

  return `${stroke.color}:${stroke.alpha}:${stroke.width}`;
}

function normalizeStroke(
  stroke: MaskStrokeStyleOptions | null | undefined,
  fallbackColor: number,
): MaskStrokeStyle | undefined {
  if (!stroke) {
    return undefined;
  }

  return {
    alpha: stroke.alpha ?? DEFAULT_MASK_STROKE_ALPHA,
    color: stroke.color ?? fallbackColor,
    width: stroke.width ?? DEFAULT_MASK_STROKE_WIDTH,
  };
}

function createArtifactKey(options: BaseMaskStyleOptions) {
  if (
    typeof options.color === "function" ||
    typeof options.stroke === "function"
  ) {
    return undefined;
  }

  const color = options.color ?? DEFAULT_MASK_COLOR;

  return `base:${color}:${serializeStroke(normalizeStroke(options.stroke, color))}`;
}
