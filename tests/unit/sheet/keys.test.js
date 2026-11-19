/**
 * @jest-environment node
 */
import { describe, expect, test } from "@jest/globals";
import { keyIntent } from "../../../src/sheet/keys.js";

describe("sheet keyboard map", () => {
  // Bug: macOS treated Ctrl as the primary shortcut modifier or Windows treated Meta as Ctrl.
  test("maps Ctrl shortcuts on Windows and Command shortcuts on macOS across ready-mode navigation and selection", () => {
    expect(keyIntent({ key: "ArrowRight", ctrlKey: true }, { platform: "Win32" })).toEqual({
      type: "edge",
      dr: 0,
      dc: 1,
      extend: false,
    });
    expect(keyIntent({ key: "ArrowRight", metaKey: true }, { platform: "Win32" })).toBeNull();

    expect(keyIntent({ key: "ArrowDown", metaKey: true, shiftKey: true }, { platform: "MacIntel" })).toEqual({
      type: "edge",
      dr: 1,
      dc: 0,
      extend: true,
    });
    expect(keyIntent({ key: "ArrowDown", ctrlKey: true }, { platform: "MacIntel" })).toBeNull();

    expect(keyIntent({ key: "a", ctrlKey: true }, { platform: "Win32" })).toEqual({ type: "selectAll" });
    expect(keyIntent({ key: "a", metaKey: true }, { platform: "MacIntel" })).toEqual({ type: "selectAll" });
    expect(keyIntent({ key: " ", ctrlKey: true }, { platform: "Win32" })).toEqual({ type: "selectCols" });
    expect(keyIntent({ key: " ", metaKey: true }, { platform: "MacIntel" })).toEqual({ type: "selectCols" });
    expect(keyIntent({ key: " ", shiftKey: true }, { platform: "Win32" })).toEqual({ type: "selectRows" });

    expect(keyIntent({ key: "Home", ctrlKey: true }, { platform: "Win32" })).toEqual({
      type: "sheetCorner",
      end: false,
      extend: false,
    });
    expect(keyIntent({ key: "End", metaKey: true, shiftKey: true }, { platform: "MacIntel" })).toEqual({
      type: "sheetCorner",
      end: true,
      extend: true,
    });
    expect(keyIntent({ key: "PageDown", ctrlKey: true }, { platform: "Win32" })).toEqual({
      type: "tab",
      delta: 1,
    });
    expect(keyIntent({ key: "PageUp", metaKey: true }, { platform: "MacIntel" })).toEqual({
      type: "tab",
      delta: -1,
    });
  });

  // Bug: ready-mode and edit-mode confused Enter, Tab, F2, Delete, F4 and reference-pick arrows.
  test("maps ready-mode edit/clear/move keys and edit-mode commit/cancel/F4/pick keys", () => {
    expect(keyIntent({ key: "Enter" }, { editing: false })).toEqual({ type: "edit" });
    expect(keyIntent({ key: "Enter", shiftKey: true }, { editing: false })).toEqual({
      type: "move",
      dr: -1,
      dc: 0,
      extend: false,
    });
    expect(keyIntent({ key: "F2" }, { editing: false })).toEqual({ type: "edit" });
    expect(keyIntent({ key: "Delete" }, { editing: false })).toEqual({ type: "clear" });
    expect(keyIntent({ key: "Backspace" }, { editing: false })).toEqual({ type: "clear" });
    expect(keyIntent({ key: "Tab", shiftKey: true }, { editing: false })).toEqual({
      type: "move",
      dr: 0,
      dc: -1,
      extend: false,
    });

    expect(keyIntent({ key: "Enter" }, { editing: true })).toEqual({ type: "commit", dr: 1, dc: 0 });
    expect(keyIntent({ key: "Enter", shiftKey: true }, { editing: true })).toEqual({ type: "commit", dr: -1, dc: 0 });
    expect(keyIntent({ key: "Tab" }, { editing: true })).toEqual({ type: "commit", dr: 0, dc: 1 });
    expect(keyIntent({ key: "Escape" }, { editing: true })).toEqual({ type: "cancel" });
    expect(keyIntent({ key: "F4" }, { editing: true })).toEqual({ type: "cycleRef" });
    expect(keyIntent({ key: "ArrowUp", shiftKey: true }, { editing: true, picking: true })).toEqual({
      type: "pick",
      dr: -1,
      dc: 0,
      extend: true,
    });
    expect(keyIntent({ key: "ArrowUp" }, { editing: true, picking: false })).toBeNull();
  });

  // Bug: Alt+Enter (Option+Enter on macOS) committed and closed the cell instead of inserting a line break.
  test("Alt+Enter in edit mode inserts a line break rather than committing", () => {
    expect(keyIntent({ key: "Enter", altKey: true }, { platform: "Win32", editing: true })).toEqual({
      type: "newline",
    });
    expect(keyIntent({ key: "Enter", altKey: true }, { platform: "MacIntel", editing: true })).toEqual({
      type: "newline",
    });
  });

  // Bug: pressing Enter to confirm an IME candidate committed the unfinished cell edit.
  test("a composing Enter (isComposing or keyCode 229) produces null in both ready and edit modes", () => {
    expect(keyIntent({ key: "Enter", isComposing: true }, { editing: true })).toBeNull();
    expect(keyIntent({ key: "Enter", keyCode: 229 }, { editing: true })).toBeNull();
    expect(keyIntent({ key: "Enter", isComposing: true }, { editing: false })).toBeNull();
    expect(keyIntent({ key: "Enter", keyCode: 229 }, { editing: false })).toBeNull();
    expect(keyIntent({ key: "Enter" }, { editing: true, composing: true })).toBeNull();
    expect(keyIntent({ key: "ArrowDown" }, { editing: true, picking: true, composing: true })).toBeNull();
  });

  // Bug: the sheet intercepted browser/page shortcuts (Ctrl+S, Ctrl+P, Ctrl+G) or plain typing.
  test("keys the sheet does not own return null so preventDefault is never called on them", () => {
    for (const [event, opts] of [
      [{ key: "s", ctrlKey: true }, { platform: "Win32", editing: false }],
      [{ key: "s", metaKey: true }, { platform: "MacIntel", editing: true }],
      [{ key: "p", ctrlKey: true }, { platform: "Win32", editing: false }],
      [{ key: "g", ctrlKey: true }, { platform: "Win32", editing: false }],
      [{ key: "g", metaKey: true }, { platform: "MacIntel", editing: false }],
      [{ key: "x" }, { platform: "Win32", editing: false }],
      [{ key: " ", shiftKey: true }, { platform: "Win32", editing: true }],
      [{ key: "Escape" }, { platform: "Win32", editing: false }],
    ]) {
      expect(keyIntent(event, opts)).toBeNull();
    }
  });

  // Bug: ready-mode undo and redo went to the page or the textarea instead of the sheet's history,
  // or Ctrl+Shift+V pasted a formula instead of values.
  test("maps ready-mode undo, redo and values-only, and leaves the keys native while editing", () => {
    expect(keyIntent({ key: "z", metaKey: true }, { platform: "MacIntel", editing: false })).toEqual({ type: "undo" });
    expect(keyIntent({ key: "z", ctrlKey: true }, { platform: "Win32", editing: false })).toEqual({ type: "undo" });
    expect(keyIntent({ key: "Z", metaKey: true, shiftKey: true }, { platform: "MacIntel", editing: false })).toEqual({ type: "redo" });
    expect(keyIntent({ key: "Z", ctrlKey: true, shiftKey: true }, { platform: "Win32", editing: false })).toEqual({ type: "redo" });
    expect(keyIntent({ key: "y", ctrlKey: true }, { platform: "Win32", editing: false })).toEqual({ type: "redo" });
    expect(keyIntent({ key: "V", metaKey: true, shiftKey: true }, { platform: "MacIntel", editing: false })).toEqual({ type: "pasteValues" });
    expect(keyIntent({ key: "V", ctrlKey: true, shiftKey: true }, { platform: "Win32", editing: false })).toEqual({ type: "pasteValues" });

    expect(keyIntent({ key: "z", metaKey: true }, { platform: "MacIntel", editing: true })).toBeNull();
    expect(keyIntent({ key: "Z", metaKey: true, shiftKey: true }, { platform: "MacIntel", editing: true })).toBeNull();
    expect(keyIntent({ key: "y", ctrlKey: true }, { platform: "Win32", editing: true })).toBeNull();
    expect(keyIntent({ key: "V", metaKey: true, shiftKey: true }, { platform: "MacIntel", editing: true })).toBeNull();

    expect(keyIntent({ key: "c", metaKey: true }, { platform: "MacIntel", editing: false })).toBeNull();
    expect(keyIntent({ key: "x", metaKey: true }, { platform: "MacIntel", editing: false })).toBeNull();
    expect(keyIntent({ key: "v", metaKey: true }, { platform: "MacIntel", editing: false })).toBeNull();
  });

  // Bug: AltGr characters on Windows (reported as Ctrl+Alt) and Option characters on macOS triggered insert, delete and strikethrough.
  test("AltGr and Option characters never trigger insert, delete or strikethrough", () => {
    const altGr = (extra) => ({
      ctrlKey: true,
      altKey: true,
      getModifierState: (name) => name === "AltGraph",
      ...extra,
    });

    expect(keyIntent(altGr({ key: "\\", code: "Minus" }), { platform: "Win32", editing: false })).toBeNull();
    expect(keyIntent(altGr({ key: "}", code: "Equal" }), { platform: "Win32", editing: false })).toBeNull();
    expect(
      keyIntent({ key: "[", code: "Digit5", altKey: true, shiftKey: true }, { platform: "MacIntel", editing: false }),
    ).toBeNull();
  });

  // Bug: formatting, structure and context-menu shortcuts fired while editing a cell's text or missed platform modifiers.
  test("maps formatting, alignment, number-format, clear-format, insert/delete and context-menu shortcuts in ready mode only", () => {
    expect(keyIntent({ key: "b", ctrlKey: true }, { platform: "Win32", editing: false })).toEqual({ type: "bold" });
    expect(keyIntent({ key: "b", metaKey: true }, { platform: "MacIntel", editing: false })).toEqual({ type: "bold" });
    expect(keyIntent({ key: "i", ctrlKey: true }, { platform: "Win32", editing: false })).toEqual({ type: "italic" });
    expect(keyIntent({ key: "u", metaKey: true }, { platform: "MacIntel", editing: false })).toEqual({ type: "underline" });
    expect(keyIntent({ key: "5", altKey: true, shiftKey: true }, { platform: "Win32", editing: false })).toEqual({
      type: "strikethrough",
    });
    expect(keyIntent({ key: "X", metaKey: true, shiftKey: true }, { platform: "MacIntel", editing: false })).toEqual({
      type: "strikethrough",
    });
    expect(keyIntent({ key: "X", ctrlKey: true, shiftKey: true }, { platform: "Win32", editing: false })).toBeNull();

    expect(keyIntent({ key: "L", ctrlKey: true, shiftKey: true }, { platform: "Win32", editing: false })).toEqual({
      type: "align",
      align: "left",
    });
    expect(keyIntent({ key: "E", metaKey: true, shiftKey: true }, { platform: "MacIntel", editing: false })).toEqual({
      type: "align",
      align: "center",
    });
    expect(keyIntent({ key: "R", ctrlKey: true, shiftKey: true }, { platform: "Win32", editing: false })).toEqual({
      type: "align",
      align: "right",
    });

    expect(keyIntent({ key: "1", ctrlKey: true, shiftKey: true }, { platform: "Win32", editing: false })).toEqual({
      type: "numberFormat",
      fmt: "#,##0.00",
    });
    expect(keyIntent({ key: "$", metaKey: true, shiftKey: true }, { platform: "MacIntel", editing: false })).toEqual({
      type: "numberFormat",
      fmt: "$#,##0.00",
    });
    expect(keyIntent({ key: "%", ctrlKey: true, shiftKey: true }, { platform: "Win32", editing: false })).toEqual({
      type: "numberFormat",
      fmt: "0.00%",
    });
    expect(keyIntent({ key: "\\", ctrlKey: true }, { platform: "Win32", editing: false })).toEqual({
      type: "clearFormat",
    });

    expect(keyIntent({ key: "=", ctrlKey: true, altKey: true }, { platform: "Win32", editing: false })).toEqual({
      type: "insertAxis",
    });
    expect(keyIntent({ key: "-", metaKey: true, altKey: true }, { platform: "MacIntel", editing: false })).toEqual({
      type: "deleteAxis",
    });
    expect(keyIntent({ key: "ContextMenu" }, { platform: "Win32", editing: false })).toEqual({ type: "contextMenu" });
    expect(keyIntent({ key: "F10", shiftKey: true }, { platform: "Win32", editing: false })).toEqual({
      type: "contextMenu",
    });

    for (const [event, opts] of [
      [{ key: "b", ctrlKey: true }, { platform: "Win32", editing: true }],
      [{ key: "i", metaKey: true }, { platform: "MacIntel", editing: true }],
      [{ key: "u", ctrlKey: true }, { platform: "Win32", editing: true }],
      [{ key: "X", metaKey: true, shiftKey: true }, { platform: "MacIntel", editing: true }],
      [{ key: "L", ctrlKey: true, shiftKey: true }, { platform: "Win32", editing: true }],
      [{ key: "1", ctrlKey: true, shiftKey: true }, { platform: "Win32", editing: true }],
      [{ key: "\\", ctrlKey: true }, { platform: "Win32", editing: true }],
      [{ key: "=", ctrlKey: true, altKey: true }, { platform: "Win32", editing: true }],
      [{ key: "-", ctrlKey: true, altKey: true }, { platform: "Win32", editing: true }],
      [{ key: "F10", shiftKey: true }, { platform: "Win32", editing: true }],
    ]) {
      expect(keyIntent(event, opts)).toBeNull();
    }
  });

  // Bug: fill, find, go-to and Ctrl+Enter shortcuts fired in the wrong mode, stole Ctrl+G from the browser, or confused Ctrl+Shift+R align-right with Ctrl+R fill-right.
  test("maps Ctrl+D, Ctrl+R, Ctrl+F and Ctrl+J in ready mode, Ctrl+Enter as commitAll in edit mode, and leaves Ctrl+G to the browser", () => {
    expect(keyIntent({ key: "d", ctrlKey: true }, { platform: "Win32", editing: false })).toEqual({ type: "fillDown" });
    expect(keyIntent({ key: "d", metaKey: true }, { platform: "MacIntel", editing: false })).toEqual({ type: "fillDown" });
    expect(keyIntent({ key: "r", ctrlKey: true }, { platform: "Win32", editing: false })).toEqual({ type: "fillRight" });
    expect(keyIntent({ key: "r", metaKey: true }, { platform: "MacIntel", editing: false })).toEqual({ type: "fillRight" });
    expect(keyIntent({ key: "f", ctrlKey: true }, { platform: "Win32", editing: false })).toEqual({ type: "find" });
    expect(keyIntent({ key: "f", metaKey: true }, { platform: "MacIntel", editing: false })).toEqual({ type: "find" });
    expect(keyIntent({ key: "j", ctrlKey: true }, { platform: "Win32", editing: false })).toEqual({ type: "goto" });
    expect(keyIntent({ key: "j", metaKey: true }, { platform: "MacIntel", editing: false })).toEqual({ type: "goto" });

    expect(keyIntent({ key: "Enter", ctrlKey: true }, { platform: "Win32", editing: true })).toEqual({ type: "commitAll" });
    expect(keyIntent({ key: "Enter", metaKey: true }, { platform: "MacIntel", editing: true })).toEqual({ type: "commitAll" });
    expect(keyIntent({ key: "Enter", ctrlKey: true }, { platform: "Win32", editing: false })).toBeNull();

    for (const [event, opts] of [
      [{ key: "d", ctrlKey: true }, { platform: "Win32", editing: true }],
      [{ key: "r", metaKey: true }, { platform: "MacIntel", editing: true }],
      [{ key: "f", ctrlKey: true }, { platform: "Win32", editing: true }],
      [{ key: "j", metaKey: true }, { platform: "MacIntel", editing: true }],
      [{ key: "g", ctrlKey: true }, { platform: "Win32", editing: false }],
      [{ key: "g", metaKey: true }, { platform: "MacIntel", editing: false }],
    ]) {
      expect(keyIntent(event, opts)).toBeNull();
    }
  });
});
