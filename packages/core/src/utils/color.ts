/** Returns black or white for readable text over an RGB background. */
export function resolveContrastTextColor(color: number) {
  "worklet";
  const red = (color >> 16) & 0xff;
  const green = (color >> 8) & 0xff;
  const blue = color & 0xff;
  const luminance = (red * 299 + green * 587 + blue * 114) / 1000;
  return luminance >= 150 ? 0x111111 : 0xffffff;
}

export function lightenColor(color: number, amount = 0.14) {
  "worklet";
  const mix = (value: number) => Math.round(value + (255 - value) * amount);
  return (
    (mix((color >> 16) & 0xff) << 16) |
    (mix((color >> 8) & 0xff) << 8) |
    mix(color & 0xff)
  );
}
