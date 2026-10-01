// Separate from the main entry point so a reader that decodes a track
// elsewhere loads the packet walk without the engine and its worker.

export { readFrameIndex, readFrameTimeline } from "./frame-timeline-reader";
