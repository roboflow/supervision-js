import { describe, expect, it } from "vitest";

import { MediaRendererFit } from "#types/media-renderer";
import { calculatePixiSceneFit } from "./pixi-scene-fit";

describe("Pixi scene fit", () => {
  it.each([
    { screenHeight: 900, screenWidth: 1600 },
    { screenHeight: 1200, screenWidth: 700 },
  ])(
    "preserves portrait media proportions in a $screenWidth x $screenHeight host",
    (screen) => {
      const mediaWidth = 720;
      const mediaHeight = 956;
      const fit = calculatePixiSceneFit({
        fit: MediaRendererFit.Contain,
        mediaHeight,
        mediaWidth,
        ...screen,
      });

      expect(fit).toBeDefined();
      const renderedWidth = mediaWidth * (fit?.scale ?? 0);
      const renderedHeight = mediaHeight * (fit?.scale ?? 0);
      expect(renderedWidth / renderedHeight).toBeCloseTo(
        mediaWidth / mediaHeight,
        10,
      );
      expect(fit?.x).toBeCloseTo((screen.screenWidth - renderedWidth) / 2, 10);
      expect(fit?.y).toBeCloseTo(
        (screen.screenHeight - renderedHeight) / 2,
        10,
      );
    },
  );
});
