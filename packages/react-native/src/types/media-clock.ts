/**
 * What paces a media session.
 *
 * This is the axis that separates "process this video" from "watch this
 * video". Both are legitimate; treating one as the only mode is what made
 * saved-video playback run in slow motion.
 *
 * - `realtime` — the source has its own clock and stale frames are worthless,
 *   so frames arriving while busy are dropped. This is the live camera lane,
 *   already implemented as VisionCamera's `dropFramesWhileBusy`.
 * - `analysis` — every frame is processed, as fast as the pipeline allows.
 *   Playback therefore runs at inference speed. Correct for producing a fully
 *   annotated video; wrong as a default for watching one.
 * - `media` — frames are presented on their own timeline, so a ten second clip
 *   takes ten seconds. Inference runs on whatever subset fits, and frames
 *   between inferred ones reuse the most recent detections.
 */
export type ReactNativeMediaClock = "realtime" | "analysis" | "media";

/**
 * The clocks a saved-video session implements.
 *
 * `realtime` is excluded deliberately: dropping frames because they went stale
 * only means something for a source with its own clock. A file has no clock
 * until the session gives it one.
 */
export type ReactNativeVideoClock = Extract<
  ReactNativeMediaClock,
  "analysis" | "media"
>;
