// The vendor bundle's entry: sapjs's grid plugin, plus sapjs's formula tokenizer on Sap.grid,
// which the sheet's reference outlines and picking read. sapjs does not put it there yet; when
// it does (or propagate takes over the vendor file), this entry goes.
import grid from "SAPJS/src/plugins/grid.js";
import { tokenize } from "SAPJS/src/grid/formula/text.js";

const setup = grid.setup;
grid.setup = function (kit) {
  const out = setup.call(this, kit);
  // setup returns { api: { grid: gridOf } }, which sapjs assigns onto Sap (src/plugins.js:143).
  if (typeof out?.api?.grid === "function") out.api.grid.tokenize ??= tokenize;
  return out;
};
export default grid;
