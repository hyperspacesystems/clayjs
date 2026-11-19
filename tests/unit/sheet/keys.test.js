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

  // Bug: the sheet intercepted browser/page shortcuts (Ctrl+S, Ctrl+P) or C7/C8 shortcuts (Ctrl+Z, Ctrl+Enter, Ctrl+D, Ctrl+R) or plain typing.
  test("keys the sheet does not own return null so preventDefault is never called on them", () => {
    for (const [event, opts] of [
      [{ key: "s", ctrlKey: true }, { platform: "Win32", editing: false }],
      [{ key: "s", metaKey: true }, { platform: "MacIntel", editing: true }],
      [{ key: "p", ctrlKey: true }, { platform: "Win32", editing: false }],
      [{ key: "z", metaKey: true }, { platform: "MacIntel", editing: false }],
      [{ key: "Enter", ctrlKey: true }, { platform: "Win32", editing: true }],
      [{ key: "d", ctrlKey: true }, { platform: "Win32", editing: false }],
      [{ key: "r", ctrlKey: true }, { platform: "Win32", editing: false }],
      [{ key: "f", metaKey: true }, { platform: "MacIntel", editing: false }],
      [{ key: "x" }, { platform: "Win32", editing: false }],
      [{ key: " ", shiftKey: true }, { platform: "Win32", editing: true }],
      [{ key: "Escape" }, { platform: "Win32", editing: false }],
    ]) {
      expect(keyIntent(event, opts)).toBeNull();
    }
  });
});
