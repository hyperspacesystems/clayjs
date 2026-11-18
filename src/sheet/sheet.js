import { startShell } from "./shell.js";
import { ownWorkbooks } from "./workbook.js";

// The sheet editor (`?plugins=sheet`, edit mode). C5a: the row window. C5b: the workbook owner,
// which saves every tab through sapjs's cached writer. The chrome and editing land in C6 to C8,
// the optional features and their loader in C11.
const shell = startShell();
const books = ownWorkbooks({ onRebuild: () => shell.restart() });

export const sheet = {
  windows: shell.windows,
  books: books.books,
};

// The mount waits for this: the workbook's Grids exist on one engine before the first pass.
export const ready = books.ready;
export default sheet;
