import { startShell } from "./shell.js";
import { ownWorkbooks } from "./workbook.js";
import { startInterface } from "./interface.js";

// The sheet editor (`?plugins=sheet`, edit mode): the row window (C5a), the workbook owner that
// saves every tab through sapjs's cached writer (C5b), and the interface (C6). Undo and paste
// land in C7, the other editing commands in C8, the optional features and their loader in C11.
const shell = startShell();
let ui = null;
let mounted = false;
const books = ownWorkbooks({
  onRebuild: () => {
    shell.restart();
    if (ui) ui.restart();
    else if (mounted) ui = startInterface({ shell });
  },
});

export const sheet = {
  windows: shell.windows,
  books: books.books,
  get ui() {
    return ui;
  },
};

// The mount waits for this: the workbook's Grids exist on one engine before the first pass. The
// interface starts after the mount, on the Grids the page holds then.
export const ready = books.ready;
Promise.resolve(window.clay?.ready)
  .then(() => {
    mounted = true;
    return shell.followed;
  })
  .then(() => {
    ui = startInterface({ shell });
  })
  .catch((error) => console.error("clayjs: the sheet interface could not start", error));
export default sheet;
