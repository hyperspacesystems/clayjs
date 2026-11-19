/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/sheet.html"}
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { tabTable } from "../../../src/sheet/commit.js";
import {
  exportTabDelimited,
  freeImportTabName,
  importCsvIntoGrid,
  inspectDelimitedText,
  MAX_IMPORT_BYTES,
  openCsvFilePicker,
  openCsvMenu,
  openImportDialog,
} from "../../../src/sheet/csv.js";
import { resolveTheme } from "../../../src/ui/theme.js";

const CSV_BOOK = `<main sap plugins="grid"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Budget</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"><col data-id="c3" data-pos="t"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td></td><td></td><td></td></tr>
<tr data-id="r2" data-pos="l"><td></td><td></td><td></td></tr>
</tbody></table></section></div></main>`;

async function mountBook() {
  jest.resetModules();
  delete window.Sap;
  delete window.sapPlugins;
  window.clay = { ready: new Promise(() => {}) };
  document.body.innerHTML = CSV_BOOK;
  const Sap = (await import("../../../src/vendor/sap-core.vendor.js")).default;
  window.clay.region = (await import("../../../src/lib/region-policy.js")).regionShape;
  const { ownWorkbooks } = await import("../../../src/sheet/workbook.js");
  const books = ownWorkbooks({});
  await books.ready;
  Sap.mount();
  const root = document.querySelector("[sheet-workbook]");
  const grid = Sap.grid(tabTable(root, "s1"));
  return { Sap, root, grid, csv: Sap.grid.csv };
}

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  window.Sap?.unmount?.();
  delete window.Sap;
  delete window.clay;
  document.body.innerHTML = "";
  jest.restoreAllMocks();
});

async function importThroughMenu(rows, fileName = "Bank.csv") {
  const { csv } = await mountBook();
  const created = [];
  const writes = [];
  const notices = [];
  const dialogs = [];
  const root = document.createElement("div");
  root.setAttribute("sheet-workbook", "");
  const topRoot = document.createElement("div");
  const existing = document.createElement("section");
  existing.setAttribute("item", "");
  existing.setAttribute("data-id", "s1");
  existing.innerHTML = "<h2>Budget</h2><table grid></table>";
  root.append(existing);
  document.body.append(root, topRoot);

  let ids = 0;
  const sapGrid = {
    csv,
    newId: (prefix) => `${prefix}${++ids}`,
    createSheetWriter: () => ({
      table: (id, sheet) => {
        created.push({ id, rows: sheet.rows.length, cols: sheet.cols.length });
        return '<table grid></table>';
      },
    }),
  };
  const grid = {
    apply: ({ sheet }) => {
      const section = document.createElement("section");
      section.setAttribute("item", "");
      section.setAttribute("data-id", sheet.id);
      section.innerHTML = `<h2>${sheet.name}</h2>${sheet.html}`;
      root.append(section);
      return true;
    },
    importDelimited: (text, at, options) => {
      writes.push({ text, at, options });
    },
  };
  const tabs = {
    activeId: "s1",
    list: () => [...root.querySelectorAll("section[item]")].map((el) => ({
      id: el.getAttribute("data-id"),
      name: el.querySelector("h2")?.textContent ?? "",
      table: el.querySelector("table[grid]"),
    })),
    show: (id) => {
      tabs.activeId = id;
    },
  };
  const ctx = {
    doc: document,
    win: { Sap: { grid: sapGrid } },
    workbook: root,
    chrome: {
      theme: resolveTheme(),
      topRoot,
      findSlot: topRoot,
      getButton: () => null,
      showNotice: (msg) => notices.push(msg),
      hideNotice: () => {},
    },
    editor: { textarea: document.createElement("textarea"), focus: () => {} },
    tabs,
    gridOf: (table) => (table ? grid : null),
    viewOf: () => ({ rows: ["r1", "r2"], cols: ["c1", "c2"] }),
    setSel: () => {},
    getSel: () => ({ tab: "s1", anchor: { row: "r1", col: "c1" }, focus: { row: "r2", col: "c2" } }),
    applySelection: () => {},
    applyMove: () => {},
    runTabStep: (fn) => fn(),
    writeGrid: (fn) => {
      fn();
      return true;
    },
    subscribeGrids: () => {},
    refreshStatus: () => {},
    syncUI: () => {},
    showDialog: (tab, handle) => dialogs.push(handle),
    clearDialog: () => {},
  };

  let opened = null;
  openCsvMenu(ctx, {
    open: (opts) => {
      opened = opts;
    },
  });
  opened.items.find((item) => item.id === "import-delimited").onSelect();
  const input = topRoot.querySelector("[data-csv-file-input]");
  const bytes = new TextEncoder().encode(rows.join("\n"));
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [{ name: fileName, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer }],
  });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  return { created, writes, notices, dialogs, topRoot };
}

describe("sheet CSV and TSV import and export", () => {
  // Bug: the import dialog missed semicolon detection, rendered more than 20 preview rows or raw HTML, ignored per-column Plain text, or evaluated "=" cells as formulas.
  test("detects delimiter, previews the first 20 rows as plain text, honors per-column Plain text, and keeps '=' cells as text on import", async () => {
    const { grid, csv } = await mountBook();
    const lines = ["007;12.5;=1+1;<b>bold</b>"];
    for (let i = 2; i <= 25; i++) lines.push(`00${i};${i};=A${i};row ${i}`);
    const raw = lines.join("\r\n");

    const container = document.createElement("div");
    document.body.append(container);
    let confirmed = null;
    const dlg = openImportDialog({
      doc: document,
      theme: resolveTheme(),
      container,
      fileName: "items.csv",
      text: raw,
      csv,
      existingTabs: [{ id: "s1", name: "Budget" }],
      onConfirm: (choice) => {
        confirmed = choice;
      },
    });

    const delimSelect = container.querySelector("[data-import-delimiter]");
    expect(delimSelect.value).toBe(";");
    const previewRows = container.querySelectorAll("[data-import-preview] tbody tr");
    expect(previewRows).toHaveLength(20);
    expect(container.querySelector("[data-import-preview] b")).toBeNull();
    expect(previewRows[0].children[3].textContent).toBe("<b>bold</b>");

    // Set column A to "Plain text" so "007" stays text while column B stays Automatic.
    const col0Select = container.querySelector('[data-col-type="0"]');
    col0Select.value = "text";
    col0Select.dispatchEvent(new Event("change", { bubbles: true }));

    dlg.confirmBtn.click();
    expect(confirmed).toEqual({
      delimiter: ";",
      types: ["text", "auto", "auto", "auto"],
      destination: "new",
      tabName: "items",
      rowCount: 25,
      colCount: 4,
    });

    importCsvIntoGrid(grid, raw, "A1", confirmed);
    expect(grid.get("A1")).toBe("007");
    expect(grid.get("B1")).toBe(12.5);
    expect(grid.get("C1")).toBe("=1+1");
    expect(grid.cell("C1").content).toBe("=1+1");
  });

  // Bug: files over 5 MB or 200,000 cells were parsed before refusal, or a DelimitedError hid its line number.
  test("refuses files over 5 MB or over 200,000 cells before calling parseDelimited, and reports the line of a parse error", async () => {
    const { csv } = await mountBook();
    const parseSpy = jest.spyOn(csv, "parseDelimited");

    const overBytes = inspectDelimitedText("a,b\n1,2", { byteLength: MAX_IMPORT_BYTES + 1, csv });
    expect(overBytes.ok).toBe(false);
    expect(overBytes.reason).toBe("too_many_bytes");
    expect(parseSpy).not.toHaveBeenCalled();

    const row = Array.from({ length: 201 }, () => "1").join(",");
    const overCellsText = Array.from({ length: 1000 }, () => row).join("\n");
    const overCells = inspectDelimitedText(overCellsText, { csv });
    expect(overCells.ok).toBe(false);
    expect(overCells.reason).toBe("too_many_cells");
    expect(parseSpy).not.toHaveBeenCalled();

    const broken = inspectDelimitedText('a,b\n1,2\n"unterminated,3\n4,5', { csv });
    expect(broken.ok).toBe(false);
    expect(broken.reason).toBe("parse_error");
    expect(broken.line).toBe(3);
    expect(broken.message).toContain("line 3");
  });

  // Bug: a new-tab import made a 100 by 26 tab first, so a file past sapjs\'s growth limit was refused and stranded an empty tab.
  test("a 10,200-row import into a new tab makes the tab big enough for the whole file before writing", async () => {
    const lines = ["Name,Amount"];
    for (let i = 1; i < 10200; i++) lines.push(`Row ${i},${i}.25`);

    const { created, writes, notices, dialogs } = await importThroughMenu(lines);
    expect(notices).toEqual([]);
    expect(dialogs).toHaveLength(1);
    dialogs[0].confirmBtn.click();

    expect(created).toHaveLength(1);
    expect(created[0].rows).toBe(10200);
    expect(created[0].cols).toBe(26);
    expect(writes).toHaveLength(1);
    expect(writes[0].at).toBe("A1");
    expect(writes[0].options).toEqual({ delimiter: ",", types: ["auto", "auto"], formulas: false });
    expect(writes[0].text.split("\n")).toHaveLength(10200);
  });

  // Bug: a new-tab import made a 26-column tab first, so a wider file was refused and stranded an empty tab.
  test("a wide import into a new tab makes the tab wide enough for every column", async () => {
    const wide = Array.from({ length: 1100 }, (_, i) => `c${i}`).join(",");
    const { created, writes, notices, dialogs } = await importThroughMenu([wide, wide, wide], "Wide.csv");
    expect(notices).toEqual([]);
    expect(dialogs).toHaveLength(1);
    dialogs[0].confirmBtn.click();

    expect(created).toHaveLength(1);
    expect(created[0].cols).toBe(1100);
    expect(created[0].rows).toBe(100);
    expect(writes).toHaveLength(1);
  });

  // Bug: "At the selected cell" wrote a file past sapjs\'s growth limit instead of refusing before any write.
  test("an import at the selected cell refuses before writing when it needs more rows than the sheet can grow", async () => {
    const lines = ["Name,Amount"];
    for (let i = 1; i < 10200; i++) lines.push(`Row ${i},${i}.25`);

    const { writes, notices, dialogs, topRoot } = await importThroughMenu(lines);
    expect(dialogs).toHaveLength(1);
    topRoot.querySelector('[data-import-dest="cell"]').click();
    dialogs[0].confirmBtn.click();

    expect(writes).toEqual([]);
    expect(notices).toContain("This file is too large to place here. Import it into a new tab.");
  });

  // Bug: both destination buttons looked identical, and a parse error stayed behind display:none !important.
  test("the import dialog marks the picked destination and shows the parse error", async () => {
    const { csv } = await mountBook();
    const container = document.createElement("div");
    document.body.append(container);
    const dlg = openImportDialog({
      doc: document,
      theme: resolveTheme(),
      container,
      fileName: "broken.csv",
      text: 'a;b\n1;2\n"open',
      csv,
      existingTabs: [{ id: "s1", name: "Budget" }],
      onConfirm: () => {},
    });

    const newBtn = container.querySelector('[data-import-dest="new"]');
    const cellBtn = container.querySelector('[data-import-dest="cell"]');
    expect(newBtn.getAttribute("aria-checked")).toBe("true");
    expect(cellBtn.getAttribute("aria-checked")).toBe("false");
    expect(cellBtn.getAttribute("style")).not.toBe(newBtn.getAttribute("style"));

    cellBtn.click();
    expect(cellBtn.getAttribute("aria-checked")).toBe("true");
    expect(newBtn.getAttribute("aria-checked")).toBe("false");
    expect(cellBtn.getAttribute("style")).not.toBe(newBtn.getAttribute("style"));
    expect(getComputedStyle(cellBtn).borderTopWidth).toBe("2px");

    const delimSelect = container.querySelector("[data-import-delimiter]");
    delimSelect.value = ",";
    delimSelect.dispatchEvent(new Event("change", { bubbles: true }));

    const errorBox = container.querySelector("[data-import-error]");
    const previewWrap = container.querySelector("[data-import-preview]");
    expect(errorBox.textContent).toContain("line 3");
    expect(getComputedStyle(errorBox).display).toBe("block");
    // The dialog paints display:none !important; only an !important declaration can undo it.
    expect(errorBox.style.getPropertyPriority("display")).toBe("important");
    expect(previewWrap.hidden).toBe(true);
    expect(dlg.confirmBtn.isDisabled()).toBe(true);
  });

  // Bug: a Windows-1252 (Excel) CSV was decoded as UTF-8, turning é into a replacement character.
  test("a Windows-1252 CSV keeps its accented letters", async () => {
    await mountBook();
    const container = document.createElement("div");
    document.body.append(container);
    const picked = [];
    const input = openCsvFilePicker({
      doc: document,
      container,
      onPickFile: (file) => picked.push(file),
      onNotice: () => {},
    });

    // 4A 6F 73 E9 is "José" in Windows-1252 and is not valid UTF-8.
    const bytes = new Uint8Array([0x4a, 0x6f, 0x73, 0xe9]);
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [{ name: "names.csv", size: 4, arrayBuffer: async () => bytes.buffer }],
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(picked).toHaveLength(1);
    expect(picked[0].text).toBe("José");
    expect(picked[0].name).toBe("names.csv");
  });

  // Bug: freeImportTabName kept the file extension or collided case-insensitively with existing sheet names.
  test("freeImportTabName strips the extension and picks a free case-insensitive tab name", () => {
    expect(freeImportTabName("Q1.Report.csv", [{ name: "Sheet 1" }])).toBe("Q1.Report");
    expect(
      freeImportTabName("/tmp/budget.tsv", [{ name: "Budget" }, { name: "budget 2" }]),
    ).toBe("budget 3");
  });

  // Bug: export omitted protect:true on formula-like text, exported raw values instead of shown values, used the wrong Blob filename, or failed to revoke the Blob URL after clicking.
  test("exportTabDelimited writes shown values with protect:true, names the download <tab>.csv/.tsv, and revokes the Blob URL after click", async () => {
    const { grid } = await mountBook();
    jest.useFakeTimers();
    grid.set("A1", "$12.50");
    grid.set("B1", "=10+5");
    grid.set("C1", "'=SUM(1,2)");

    const order = [];
    let clickedDownload = "";
    let clickedHref = "";
    const origCreateElement = document.createElement.bind(document);
    jest.spyOn(document, "createElement").mockImplementation((tag, opts) => {
      const el = origCreateElement(tag, opts);
      if (tag === "a") {
        el.click = () => {
          clickedDownload = el.download;
          clickedHref = el.getAttribute("href");
          order.push("click");
        };
      }
      return el;
    });
    const urlApi = {
      createObjectURL: jest.fn(() => {
        order.push("create");
        return "blob:https://example.com/test-csv";
      }),
      revokeObjectURL: jest.fn((href) => {
        order.push(`revoke:${href}`);
      }),
    };

    const csvOut = exportTabDelimited(grid, "Budget", ",", { doc: document, urlApi });
    expect(clickedDownload).toBe("Budget.csv");
    expect(clickedHref).toBe("blob:https://example.com/test-csv");
    expect(csvOut.text.split("\r\n")[0]).toBe('$12.50,15,"\'=SUM(1,2)"');
    // Safari aborts a download whose Blob URL is revoked before WebKit reads it: hold the URL for 40 s.
    expect(order).toEqual(["create", "click"]);
    jest.advanceTimersByTime(39999);
    expect(order).toEqual(["create", "click"]);
    jest.advanceTimersByTime(1);
    expect(order).toEqual(["create", "click", "revoke:blob:https://example.com/test-csv"]);

    const tsvOut = exportTabDelimited(grid, "Budget", "\t", { doc: document, urlApi });
    expect(tsvOut.filename).toBe("Budget.tsv");
    expect(tsvOut.text.split("\r\n")[0]).toBe("$12.50\t15\t'=SUM(1,2)");
    jest.useRealTimers();
  });
});
