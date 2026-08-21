import type { LabelTextStyle } from "supervision-js-core";

type SkiaFontWeight =
  | "normal"
  | "bold"
  | "100"
  | "200"
  | "300"
  | "400"
  | "500"
  | "600"
  | "700"
  | "800"
  | "900";

const SKIA_FONT_WEIGHTS = new Set<SkiaFontWeight>([
  "normal",
  "bold",
  "100",
  "200",
  "300",
  "400",
  "500",
  "600",
  "700",
  "800",
  "900",
]);

const NAMED_FONT_WEIGHTS: Readonly<Record<string, SkiaFontWeight>> = {
  black: "900",
  extrabold: "800",
  extralight: "200",
  light: "300",
  medium: "500",
  regular: "400",
  semibold: "600",
  thin: "100",
};

/**
 * Family name Skia's system font manager resolves when a label names none.
 *
 * `matchFont()` defaults to `"System"`, which only exists on CoreText. Android
 * returns a null typeface for it, and the resulting font makes `<Text>` reject
 * the blob with "Invalid prop value for SkTextBlob received", so Android needs
 * its own generic family instead.
 */
export function resolveReactNativeSkiaDefaultFontFamily(
  platformOs: string,
): string {
  return platformOs === "android" ? "sans-serif" : "System";
}

/** Maps core's CSS-like text style to the native Skia font matcher contract. */
export function resolveReactNativeSkiaLabelFontStyle(
  textStyle: LabelTextStyle | undefined,
  platformOs: string,
): {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly fontWeight?: SkiaFontWeight;
} {
  const fontFamily = resolveFontFamily(textStyle?.fontFamily);
  const fontWeight = resolveFontWeight(textStyle?.fontWeight);

  return {
    fontFamily:
      fontFamily || resolveReactNativeSkiaDefaultFontFamily(platformOs),
    fontSize: textStyle?.fontSize ?? 13,
    ...(fontWeight ? { fontWeight } : {}),
  };
}

function resolveFontFamily(fontFamily: string | undefined) {
  const primaryFamily = fontFamily?.split(",")[0]?.trim();

  return primaryFamily?.replace(/^(?:"([^"]+)"|'([^']+)')$/, "$1$2");
}

function resolveFontWeight(
  fontWeight: LabelTextStyle["fontWeight"] | undefined,
): SkiaFontWeight | undefined {
  if (fontWeight === undefined) {
    return undefined;
  }

  const normalized = String(fontWeight).trim().toLowerCase();

  if (SKIA_FONT_WEIGHTS.has(normalized as SkiaFontWeight)) {
    return normalized as SkiaFontWeight;
  }

  return NAMED_FONT_WEIGHTS[normalized] ?? "normal";
}
