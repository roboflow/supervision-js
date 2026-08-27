import { BaseBoxStyle } from "#styles/box-style";
import type {
  BoxCornerDrawInstruction,
  BoxCornerStyle,
  BoxCornerStyleContext,
} from "#types/box-corner-style";
import { BaseLabelStyle } from "#styles/label-style";
import { BaseMaskStyle } from "#styles/mask-style";
import { BaseMarkerStyle } from "#styles/marker-style";
import { BasePercentageBarStyle } from "#styles/percentage-bar-style";
import { BaseKeypointStyle } from "#styles/keypoint-style";
import { BasePolygonStyle } from "#styles/polygon-style";
import { BasePolylineStyle } from "#styles/polyline-style";
import { createDefaultMaskHaloStyle } from "#styles/default-annotation-presentation";
import {
  resolveAnnotationRendererStyleFields,
  type AnnotationRendererStyleField,
} from "#styles/annotation-renderer-registry";
import type { AnnotationRendererKind } from "#types/annotation-renderer";
import type {
  BoxDrawInstruction,
  BoxStyle,
  BoxStyleContext,
} from "#types/box-style";
import type { Detection } from "#types/detections";
import type {
  EllipseDrawInstruction,
  EllipseStyle,
  EllipseStyleContext,
} from "#types/ellipse-style";
import type {
  LabelDrawInstruction,
  LabelStyle,
  LabelStyleContext,
} from "#types/label-style";
import type {
  MaskDrawInstruction,
  MaskStyle,
  MaskStyleContext,
} from "#types/mask-style";
import type {
  MaskHaloDrawInstruction,
  MaskHaloStyle,
  MaskHaloStyleContext,
} from "#types/mask-halo-style";
import type {
  MarkerDrawInstruction,
  MarkerStyle,
  MarkerStyleContext,
} from "#types/marker-style";
import type {
  PercentageBarDrawInstruction,
  PercentageBarStyle,
  PercentageBarStyleContext,
} from "#types/percentage-bar-style";
import type {
  PolygonDrawInstruction,
  PolygonStyle,
  PolygonStyleContext,
} from "#types/polygon-style";
import type {
  PolylineDrawInstruction,
  PolylineStyle,
  PolylineStyleContext,
} from "#types/polyline-style";
import type {
  KeypointDrawInstruction,
  KeypointStyle,
  KeypointStyleContext,
} from "#types/keypoint-style";

export interface PresentationStyleSet {
  readonly boxStyle?: BoxStyle | null;
  readonly boxCornerStyle?: BoxCornerStyle | null;
  readonly ellipseStyle?: EllipseStyle | null;
  readonly keypointStyle?: KeypointStyle | null;
  readonly labelStyle?: LabelStyle | null;
  readonly maskHaloStyle?: MaskHaloStyle | null;
  readonly maskStyle?: MaskStyle | null;
  readonly markerStyle?: MarkerStyle | null;
  readonly percentageBarStyle?: PercentageBarStyle | null;
  readonly polygonStyle?: PolygonStyle | null;
  readonly polylineStyle?: PolylineStyle | null;
}

export type SourcePresentation = PresentationStyleSet;

export interface SourcePresentationEntry {
  readonly id: string;
  readonly presentation?: SourcePresentation;
}

/**
 * Limits source-level overrides when the host explicitly selects annotation
 * renderers. Omit this option to retain legacy source-override behaviour.
 */
export interface SourceAwarePresentationOptions {
  readonly enabledRendererKinds?: readonly AnnotationRendererKind[];
}

export function createSourceAwarePresentation<
  TPresentation extends PresentationStyleSet,
>(
  globalPresentation: TPresentation,
  sources: readonly SourcePresentationEntry[],
  options?: SourceAwarePresentationOptions,
): TPresentation;
export function createSourceAwarePresentation(
  globalPresentation: PresentationStyleSet | undefined,
  sources: readonly SourcePresentationEntry[],
  options?: SourceAwarePresentationOptions,
): PresentationStyleSet;
export function createSourceAwarePresentation(
  globalPresentation: PresentationStyleSet = {},
  sources: readonly SourcePresentationEntry[],
  options: SourceAwarePresentationOptions = {},
): PresentationStyleSet {
  if (!sources.some((source) => source.presentation !== undefined)) {
    return globalPresentation;
  }

  const sourcePresentations = new Map(
    sources.map((source) => [source.id, source.presentation] as const),
  );
  const enabledStyleFields =
    options.enabledRendererKinds === undefined
      ? undefined
      : new Set(
          resolveAnnotationRendererStyleFields(options.enabledRendererKinds),
        );
  const shouldApplySourceStyle = (style: AnnotationRendererStyleField) =>
    hasSourceStyle(sources, style) &&
    (enabledStyleFields === undefined || enabledStyleFields.has(style));

  return {
    ...globalPresentation,
    boxStyle: shouldApplySourceStyle("boxStyle")
      ? new SourceAwareBoxStyle(
          normalizeGlobalBoxStyle(globalPresentation.boxStyle),
          sourcePresentations,
        )
      : globalPresentation.boxStyle,
    boxCornerStyle: shouldApplySourceStyle("boxCornerStyle")
      ? new SourceAwareBoxCornerStyle(
          globalPresentation.boxCornerStyle ?? null,
          sourcePresentations,
        )
      : globalPresentation.boxCornerStyle,
    ellipseStyle: shouldApplySourceStyle("ellipseStyle")
      ? new SourceAwareEllipseStyle(
          globalPresentation.ellipseStyle ?? null,
          sourcePresentations,
        )
      : globalPresentation.ellipseStyle,
    labelStyle: shouldApplySourceStyle("labelStyle")
      ? new SourceAwareLabelStyle(
          normalizeGlobalLabelStyle(globalPresentation.labelStyle),
          sourcePresentations,
        )
      : globalPresentation.labelStyle,
    maskStyle: shouldApplySourceStyle("maskStyle")
      ? new SourceAwareMaskStyle(
          normalizeGlobalMaskStyle(globalPresentation.maskStyle),
          sourcePresentations,
        )
      : globalPresentation.maskStyle,
    markerStyle: shouldApplySourceStyle("markerStyle")
      ? new SourceAwareMarkerStyle(
          normalizeGlobalMarkerStyle(globalPresentation.markerStyle),
          sourcePresentations,
        )
      : globalPresentation.markerStyle,
    percentageBarStyle: shouldApplySourceStyle("percentageBarStyle")
      ? new SourceAwarePercentageBarStyle(
          normalizeGlobalPercentageBarStyle(
            globalPresentation.percentageBarStyle,
          ),
          sourcePresentations,
        )
      : globalPresentation.percentageBarStyle,
    maskHaloStyle: shouldApplySourceStyle("maskHaloStyle")
      ? new SourceAwareMaskHaloStyle(
          normalizeGlobalMaskHaloStyle(globalPresentation.maskHaloStyle),
          sourcePresentations,
        )
      : globalPresentation.maskHaloStyle,
    polygonStyle: shouldApplySourceStyle("polygonStyle")
      ? new SourceAwarePolygonStyle(
          normalizeGlobalPolygonStyle(globalPresentation.polygonStyle),
          sourcePresentations,
        )
      : globalPresentation.polygonStyle,
    polylineStyle: shouldApplySourceStyle("polylineStyle")
      ? new SourceAwarePolylineStyle(
          normalizeGlobalPolylineStyle(globalPresentation.polylineStyle),
          sourcePresentations,
        )
      : globalPresentation.polylineStyle,
    keypointStyle: shouldApplySourceStyle("keypointStyle")
      ? new SourceAwareKeypointStyle(
          normalizeGlobalKeypointStyle(globalPresentation.keypointStyle),
          sourcePresentations,
        )
      : globalPresentation.keypointStyle,
  };
}

class SourceAwareBoxCornerStyle implements BoxCornerStyle {
  constructor(
    private readonly globalStyle: BoxCornerStyle | null,
    private readonly sourcePresentations: ReadonlyMap<
      string,
      SourcePresentation | undefined
    >,
  ) {}

  resolve(
    detection: Detection,
    context: BoxCornerStyleContext,
  ): BoxCornerDrawInstruction | undefined {
    return resolveSourceStyle(
      detection,
      this.globalStyle,
      this.sourcePresentations,
      "boxCornerStyle",
    )?.resolve(detection, context);
  }
}

class SourceAwareBoxStyle implements BoxStyle {
  constructor(
    private readonly globalStyle: BoxStyle | null,
    private readonly sourcePresentations: ReadonlyMap<
      string,
      SourcePresentation | undefined
    >,
  ) {}

  resolve(
    detection: Detection,
    context: BoxStyleContext,
  ): BoxDrawInstruction | undefined {
    const style = resolveSourceStyle(
      detection,
      this.globalStyle,
      this.sourcePresentations,
      "boxStyle",
    );

    return style?.resolve(detection, context);
  }
}

class SourceAwareEllipseStyle implements EllipseStyle {
  constructor(
    private readonly globalStyle: EllipseStyle | null,
    private readonly sourcePresentations: ReadonlyMap<
      string,
      SourcePresentation | undefined
    >,
  ) {}

  resolve(
    detection: Detection,
    context: EllipseStyleContext,
  ): EllipseDrawInstruction | undefined {
    const style = resolveSourceStyle(
      detection,
      this.globalStyle,
      this.sourcePresentations,
      "ellipseStyle",
    );

    return style?.resolve(detection, context);
  }
}

class SourceAwareLabelStyle implements LabelStyle {
  constructor(
    private readonly globalStyle: LabelStyle | null,
    private readonly sourcePresentations: ReadonlyMap<
      string,
      SourcePresentation | undefined
    >,
  ) {}

  resolve(
    detection: Detection,
    context: LabelStyleContext,
  ): LabelDrawInstruction | undefined {
    const style = resolveSourceStyle(
      detection,
      this.globalStyle,
      this.sourcePresentations,
      "labelStyle",
    );

    return style?.resolve(detection, context);
  }
}

class SourceAwareMaskStyle implements MaskStyle {
  readonly artifactKey = undefined;
  readonly opacity: number | undefined;

  constructor(
    private readonly globalStyle: MaskStyle | null,
    private readonly sourcePresentations: ReadonlyMap<
      string,
      SourcePresentation | undefined
    >,
  ) {
    this.opacity = globalStyle?.opacity;
  }

  resolve(
    detection: Detection,
    context: MaskStyleContext,
  ): MaskDrawInstruction | undefined {
    const style = resolveSourceStyle(
      detection,
      this.globalStyle,
      this.sourcePresentations,
      "maskStyle",
    );

    return style?.resolve(detection, context);
  }
}

class SourceAwareMaskHaloStyle implements MaskHaloStyle {
  constructor(
    private readonly globalStyle: MaskHaloStyle | null,
    private readonly sourcePresentations: ReadonlyMap<
      string,
      SourcePresentation | undefined
    >,
  ) {}

  resolve(
    detection: Detection,
    context: MaskHaloStyleContext,
  ): MaskHaloDrawInstruction | undefined {
    const style = resolveSourceStyle(
      detection,
      this.globalStyle,
      this.sourcePresentations,
      "maskHaloStyle",
    );

    return style?.resolve(detection, context);
  }
}

class SourceAwareMarkerStyle implements MarkerStyle {
  constructor(
    private readonly globalStyle: MarkerStyle | null,
    private readonly sourcePresentations: ReadonlyMap<
      string,
      SourcePresentation | undefined
    >,
  ) {}

  resolve(
    detection: Detection,
    context: MarkerStyleContext,
  ): MarkerDrawInstruction | undefined {
    const style = resolveSourceStyle(
      detection,
      this.globalStyle,
      this.sourcePresentations,
      "markerStyle",
    );

    return style?.resolve(detection, context);
  }
}

class SourceAwarePercentageBarStyle implements PercentageBarStyle {
  constructor(
    private readonly globalStyle: PercentageBarStyle | null,
    private readonly sourcePresentations: ReadonlyMap<
      string,
      SourcePresentation | undefined
    >,
  ) {}

  resolve(
    detection: Detection,
    context: PercentageBarStyleContext,
  ): PercentageBarDrawInstruction | undefined {
    const style = resolveSourceStyle(
      detection,
      this.globalStyle,
      this.sourcePresentations,
      "percentageBarStyle",
    );

    return style?.resolve(detection, context);
  }
}

class SourceAwarePolygonStyle implements PolygonStyle {
  constructor(
    private readonly globalStyle: PolygonStyle | null,
    private readonly sourcePresentations: ReadonlyMap<
      string,
      SourcePresentation | undefined
    >,
  ) {}

  resolve(
    detection: Detection,
    context: PolygonStyleContext,
  ): PolygonDrawInstruction | undefined {
    const style = resolveSourceStyle(
      detection,
      this.globalStyle,
      this.sourcePresentations,
      "polygonStyle",
    );

    return style?.resolve(detection, context);
  }
}

class SourceAwarePolylineStyle implements PolylineStyle {
  constructor(
    private readonly globalStyle: PolylineStyle | null,
    private readonly sourcePresentations: ReadonlyMap<
      string,
      SourcePresentation | undefined
    >,
  ) {}

  resolve(
    detection: Detection,
    context: PolylineStyleContext,
  ): PolylineDrawInstruction | undefined {
    const style = resolveSourceStyle(
      detection,
      this.globalStyle,
      this.sourcePresentations,
      "polylineStyle",
    );

    return style?.resolve(detection, context);
  }
}

class SourceAwareKeypointStyle implements KeypointStyle {
  constructor(
    private readonly globalStyle: KeypointStyle | null,
    private readonly sourcePresentations: ReadonlyMap<
      string,
      SourcePresentation | undefined
    >,
  ) {}

  resolve(
    detection: Detection,
    context: KeypointStyleContext,
  ): KeypointDrawInstruction | undefined {
    const style = resolveSourceStyle(
      detection,
      this.globalStyle,
      this.sourcePresentations,
      "keypointStyle",
    );

    return style?.resolve(detection, context);
  }
}

function hasSourceStyle(
  sources: readonly SourcePresentationEntry[],
  key: keyof SourcePresentation,
) {
  return sources.some((source) => source.presentation?.[key] !== undefined);
}

function resolveSourceStyle<
  TKey extends keyof SourcePresentation,
  TStyle extends NonNullable<SourcePresentation[TKey]>,
>(
  detection: Detection,
  globalStyle: TStyle | null,
  sourcePresentations: ReadonlyMap<string, SourcePresentation | undefined>,
  key: TKey,
): TStyle | null {
  const sourcePresentation = detection.sourceId
    ? sourcePresentations.get(detection.sourceId)
    : undefined;
  const sourceStyle = sourcePresentation?.[key];

  return sourceStyle === undefined ? globalStyle : (sourceStyle as TStyle);
}

function normalizeGlobalBoxStyle(style: BoxStyle | null | undefined) {
  return style === undefined ? new BaseBoxStyle() : style;
}

function normalizeGlobalLabelStyle(style: LabelStyle | null | undefined) {
  return style === undefined ? new BaseLabelStyle() : style;
}

function normalizeGlobalMaskStyle(style: MaskStyle | null | undefined) {
  return style === undefined ? new BaseMaskStyle() : style;
}

function normalizeGlobalMaskHaloStyle(style: MaskHaloStyle | null | undefined) {
  return style === undefined ? createDefaultMaskHaloStyle() : style;
}

function normalizeGlobalMarkerStyle(style: MarkerStyle | null | undefined) {
  return style === undefined ? new BaseMarkerStyle() : style;
}

function normalizeGlobalPercentageBarStyle(
  style: PercentageBarStyle | null | undefined,
) {
  return style === undefined ? new BasePercentageBarStyle() : style;
}

function normalizeGlobalPolygonStyle(style: PolygonStyle | null | undefined) {
  return style === undefined ? new BasePolygonStyle() : style;
}

function normalizeGlobalPolylineStyle(style: PolylineStyle | null | undefined) {
  return style === undefined ? new BasePolylineStyle() : style;
}

function normalizeGlobalKeypointStyle(style: KeypointStyle | null | undefined) {
  return style === undefined ? new BaseKeypointStyle() : style;
}
