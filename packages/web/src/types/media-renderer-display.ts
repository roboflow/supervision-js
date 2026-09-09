/** Display geometry used to size a media source's presentation output. */
export interface MediaRendererDisplay {
  /** Width of the presentation box in CSS pixels. */
  boxWidth: number;
  /** Height of the presentation box in CSS pixels. */
  boxHeight: number;
  /** Pixel ratio of the display containing the presentation box. */
  devicePixelRatio: number;
  /** Optional ceiling on the display pixel ratio. */
  maxDevicePixelRatio?: number;
}
