import { openMediabunnyMediaSource } from "#media/mediabunny-media-source";
import type {
  MediaRenderer,
  MediaRendererOptions,
} from "#types/media-renderer";
import { createMediaRendererCore } from "./media-renderer-core";
import { createPixiMediaScene } from "./pixi-media-scene";

/**
 * Mediabunny owns media reading and video decode; Pixi owns the visible
 * default scene adapter. Renderer orchestration stays in the provider-agnostic
 * core.
 */
export async function createMediaRenderer(
  options: MediaRendererOptions,
): Promise<MediaRenderer> {
  return createMediaRendererCore(options, {
    createScene: createPixiMediaScene,
    openMediaSource: openMediabunnyMediaSource,
  });
}
