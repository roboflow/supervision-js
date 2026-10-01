// A track's frame index from its packet table, for a reader that opened the
// file with the same demuxer and decodes it elsewhere. Separate from the main
// entry point so that reader loads the walk without the engine and its worker.

export { readFrameTimeline } from "./frame-timeline-reader";
