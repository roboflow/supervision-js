import { resolveStyleValue } from "#styles/style-value";
import type { Detection } from "#types/detections";
import type {
  MaskDrawInstruction,
  MaskStrokeStyle,
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
  readonly alpha?: number;
  /**
   * Optional mask outline. Pass a resolver for per-detection outlines.
   */
  readonly stroke?: DetectionStyleValue<
    MaskStrokeStyle | undefined,
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
    this.opacity = clampOpacity(options.alpha ?? 0.35);
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

    return {
      alpha: 1,
      color:
        resolveStyleValue(this.options.color, detection, context) ?? 0x00ff66,
      mask: detection.mask,
      stroke: resolveStyleValue(this.options.stroke, detection, context),
    };
  }
}

function clampOpacity(opacity: number) {
  return Number.isFinite(opacity) ? Math.max(0, Math.min(opacity, 1)) : 1;
}

function serializeStroke(stroke: MaskStrokeStyle | undefined) {
  if (!stroke) {
    return "none";
  }

  return `${stroke.color}:${stroke.alpha}:${stroke.width}`;
}

function createArtifactKey(options: BaseMaskStyleOptions) {
  if (
    typeof options.color === "function" ||
    typeof options.stroke === "function"
  ) {
    return undefined;
  }

  return `base:${options.color ?? 0x00ff66}:${serializeStroke(options.stroke)}`;
}
