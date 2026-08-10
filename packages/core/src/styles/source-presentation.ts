import { BaseBoxStyle } from "#styles/box-style";
import { BaseLabelStyle } from "#styles/label-style";
import { BaseMaskStyle } from "#styles/mask-style";
import { BaseKeypointStyle } from "#styles/keypoint-style";
import { BasePolygonStyle } from "#styles/polygon-style";
import { BasePolylineStyle } from "#styles/polyline-style";
import type { AnnotationRenderer } from "#types/annotation-renderer";
import type {
  BoxDrawInstruction,
  BoxStyle,
  BoxStyleContext,
} from "#types/box-style";
import type { Detection } from "#types/detections";
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
  readonly keypointStyle?: KeypointStyle | null;
  readonly labelStyle?: LabelStyle | null;
  readonly maskStyle?: MaskStyle | null;
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
  readonly enabledRendererKinds?: readonly AnnotationRenderer["kind"][];
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

  return {
    ...globalPresentation,
    boxStyle: shouldApplySourceStyle(sources, "boxStyle", options)
      ? new SourceAwareBoxStyle(
          normalizeGlobalBoxStyle(globalPresentation.boxStyle),
          sourcePresentations,
        )
      : globalPresentation.boxStyle,
    labelStyle: shouldApplySourceStyle(sources, "labelStyle", options)
      ? new SourceAwareLabelStyle(
          normalizeGlobalLabelStyle(globalPresentation.labelStyle),
          sourcePresentations,
        )
      : globalPresentation.labelStyle,
    maskStyle: shouldApplySourceStyle(sources, "maskStyle", options)
      ? new SourceAwareMaskStyle(
          normalizeGlobalMaskStyle(globalPresentation.maskStyle),
          sourcePresentations,
        )
      : globalPresentation.maskStyle,
    polygonStyle: shouldApplySourceStyle(sources, "polygonStyle", options)
      ? new SourceAwarePolygonStyle(
          normalizeGlobalPolygonStyle(globalPresentation.polygonStyle),
          sourcePresentations,
        )
      : globalPresentation.polygonStyle,
    polylineStyle: shouldApplySourceStyle(sources, "polylineStyle", options)
      ? new SourceAwarePolylineStyle(
          normalizeGlobalPolylineStyle(globalPresentation.polylineStyle),
          sourcePresentations,
        )
      : globalPresentation.polylineStyle,
    keypointStyle: shouldApplySourceStyle(sources, "keypointStyle", options)
      ? new SourceAwareKeypointStyle(
          normalizeGlobalKeypointStyle(globalPresentation.keypointStyle),
          sourcePresentations,
        )
      : globalPresentation.keypointStyle,
  };
}

function shouldApplySourceStyle(
  sources: readonly SourcePresentationEntry[],
  style: keyof PresentationStyleSet,
  options: SourceAwarePresentationOptions,
): boolean {
  if (!hasSourceStyle(sources, style)) {
    return false;
  }

  const rendererKind = rendererKindByStyle[style];

  return (
    rendererKind === undefined ||
    options.enabledRendererKinds === undefined ||
    options.enabledRendererKinds.includes(rendererKind)
  );
}

const rendererKindByStyle: Readonly<
  Partial<Record<keyof PresentationStyleSet, AnnotationRenderer["kind"]>>
> = {
  boxStyle: "box",
  keypointStyle: "keypoints",
  labelStyle: "label",
  maskStyle: "mask",
  polygonStyle: "polygon",
  polylineStyle: "polyline",
};

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

function normalizeGlobalPolygonStyle(style: PolygonStyle | null | undefined) {
  return style === undefined ? new BasePolygonStyle() : style;
}

function normalizeGlobalPolylineStyle(style: PolylineStyle | null | undefined) {
  return style === undefined ? new BasePolylineStyle() : style;
}

function normalizeGlobalKeypointStyle(style: KeypointStyle | null | undefined) {
  return style === undefined ? new BaseKeypointStyle() : style;
}
