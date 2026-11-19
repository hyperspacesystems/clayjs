const ARROWS = {
  ArrowUp: { dr: -1, dc: 0 },
  ArrowDown: { dr: 1, dc: 0 },
  ArrowLeft: { dr: 0, dc: -1 },
  ArrowRight: { dr: 0, dc: 1 },
};

const isMacPlatform = (platform) => /mac|iphone|ipad|ipod/i.test(String(platform ?? ""));

export function keyIntent(event, { platform = "", editing = false, picking = false, composing = false } = {}) {
  if (!event || composing || event.isComposing || event.keyCode === 229) return null;

  const mac = isMacPlatform(platform);
  const ctrl = Boolean(event.ctrlKey);
  const meta = Boolean(event.metaKey);
  const alt = Boolean(event.altKey);
  const shift = Boolean(event.shiftKey);
  const mod = mac ? meta && !ctrl : ctrl && !meta;
  const plain = !ctrl && !meta && !alt;
  const key = event.key;

  if (editing) {
    if (key === "Escape" && plain && !shift) return { type: "cancel" };
    if (key === "Enter") {
      if (alt && !ctrl && !meta) return { type: "newline" };
      if (plain) return { type: "commit", dr: shift ? -1 : 1, dc: 0 };
      return null;
    }
    if (key === "Tab" && plain) return { type: "commit", dr: 0, dc: shift ? -1 : 1 };
    if (key === "F4" && plain && !shift) return { type: "cycleRef" };
    const arrow = ARROWS[key];
    if (arrow && picking && plain) return { type: "pick", dr: arrow.dr, dc: arrow.dc, extend: shift };
    return null;
  }

  const arrow = ARROWS[key];
  if (arrow) {
    if (alt) return null;
    if (mod) return { type: "edge", dr: arrow.dr, dc: arrow.dc, extend: shift };
    if (plain) return { type: "move", dr: arrow.dr, dc: arrow.dc, extend: shift };
    return null;
  }

  if (key === "Tab" && plain) return { type: "move", dr: 0, dc: shift ? -1 : 1, extend: false };
  if (key === "Enter" && plain) return shift ? { type: "move", dr: -1, dc: 0, extend: false } : { type: "edit" };
  if (key === "F2" && plain && !shift) return { type: "edit" };
  if ((key === "Delete" || key === "Backspace") && plain) return { type: "clear" };

  if (key === "Home" && !alt) {
    if (mod) return { type: "sheetCorner", end: false, extend: shift };
    if (plain) return { type: "rowEdge", end: false, extend: shift };
    return null;
  }
  if (key === "End" && !alt) {
    if (mod) return { type: "sheetCorner", end: true, extend: shift };
    if (plain) return { type: "rowEdge", end: true, extend: shift };
    return null;
  }
  if ((key === "PageDown" || key === "PageUp") && !alt) {
    const dir = key === "PageDown" ? 1 : -1;
    if (mod && !shift) return { type: "tab", delta: dir };
    if (plain) return { type: "page", dir, extend: shift };
    return null;
  }

  if ((key === "a" || key === "A") && mod && !alt && !shift) return { type: "selectAll" };
  if (key === " ") {
    if (mod && !alt && !shift) return { type: "selectCols" };
    if (shift && plain) return { type: "selectRows" };
  }

  if ((key === "z" || key === "Z") && mod && !alt) return shift ? { type: "redo" } : { type: "undo" };
  if ((key === "y" || key === "Y") && mod && !alt && !shift) return { type: "redo" };
  if ((key === "v" || key === "V") && mod && !alt && shift) return { type: "pasteValues" };

  return null;
}
