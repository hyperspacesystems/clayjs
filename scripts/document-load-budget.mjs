// The Document load ceilings, in bytes as served over the wire (Brotli q4), in one
// module the meter and the tests import: a report and a gate cannot disagree about a
// number, and moving bytes from one load phase to another never moves a ceiling.
export const DOCUMENT_LOAD_BUDGET = Object.freeze({
  readerBrotli: 52_992,           // 51.75 KiB: 45 KiB plus 15% (David, Nov 6)
  textEditorBrotli: 353_280,      // 345 KiB: the edit manifest lists every chunk, and the sheet's lazy features added seven (2026-11-19, 352,273 measured); was 352,256 for owned regions
  textEditorStretchBrotli: 266_240, // 260 KiB, reported as reached or not
  maxBuiltDepth: 3,
});
