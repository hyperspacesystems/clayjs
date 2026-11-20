// The Document load ceilings, in bytes as served over the wire (Brotli q4), in one
// module the meter and the tests import: a report and a gate cannot disagree about a
// number, and moving bytes from one load phase to another never moves a ceiling.
export const DOCUMENT_LOAD_BUDGET = Object.freeze({
  readerBrotli: 52_992,           // 51.75 KiB: 45 KiB plus 15% (David, Nov 6)
  textEditorBrotli: 354_304,      // 346 KiB: the edit manifest lists every chunk, lazy ones too; the unsaved report HTML Clay's Quit reads added one (2026-11-20, 353,368 measured); was 353,280 for the sheet's lazy features, 352,256 for owned regions
  textEditorStretchBrotli: 266_240, // 260 KiB, reported as reached or not
  maxBuiltDepth: 3,
});
