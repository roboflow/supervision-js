// Batch frame extraction and range walking, for a consumer that wants frames
// out of a source rather than a player. Separate from the main entry point
// because opening a source reaches the demuxer, and a consumer importing only a
// player type must not pull it.

export { AnalysisSession } from "./analysis-session";
export type {
  AnalysisMetadata,
  AnalysisOptions,
  ExtractedFrame,
} from "./analysis-session";
export { FrameExtractor } from "./frame-extractor";
export { FrameWalker, walkFrames } from "./frame-walker";
export type {
  FrameWalkMetadata,
  FrameWalkRange,
  WalkedFrame,
} from "./frame-walker";
export type { WalkFrameSource } from "./decode-source";
