import { afterEach, describe, expect, test } from "@jest/globals";
import { createRowWindow, ruleText, scopeOf, windowFor } from "../../../src/sheet/row-window.js";

const fakeSheet = () => ({ text: "", writes: 0, replaceSync(text) { this.text = text; this.writes++; } });
const sync = (fn) => fn();

function workbook(groups) {
  let n = 0;
  const bodies = groups.map((count) => {
    let rows = "";
    for (let i = 0; i < count; i++, n++) rows += `<tr data-id="r${n}"><td>${n}</td></tr>`;
    return `<tbody>${rows}</tbody>`;
  }).join("");
  document.body.innerHTML = `<main sap plugins="grid"><div items="sheets" sheet-workbook><section item data-id="s1" data-pos="V"><h2 bind="name">Budget</h2><table grid><colgroup><col style="width:180px"><col></colgroup>${bodies}</table></section></div></main>`;
  return document.querySelector("table");
}

const heights = Array.from({ length: 20 }, () => 1300);

describe("windowFor (spike 05)", () => {
  test("at the top it shows groups 1 to 2 with nothing above", () => {
    expect(windowFor({ scrollTop: 0, viewport: 700, heights })).toEqual({ first: 1, last: 2, before: 0, after: 23400 });
  });
  test("at the end it shows the last two groups with nothing below", () => {
    expect(windowFor({ scrollTop: 26000 - 700, viewport: 700, heights })).toEqual({ first: 19, last: 20, before: 23400, after: 0 });
  });
  test("hidden above, shown and hidden below always add up to the whole table", () => {
    for (const overscan of [0, 1]) {
      for (let scrollTop = 0; scrollTop <= 26000; scrollTop += 650) {
        const w = windowFor({ scrollTop, viewport: 700, heights, overscan });
        const shown = heights.slice(w.first - 1, w.last).reduce((a, b) => a + b, 0);
        expect(w.before + shown + w.after).toBe(26000);
      }
    }
  });
});

describe("the row window", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("the rule names the tab's table, hides groups outside the window, and sets the width", () => {
    const table = workbook([50]);
    expect(scopeOf(table)).toBe('section[data-id="s1"]>table[grid]');
    expect(ruleText({ first: 2, last: 4, before: 1300, after: 2600 }, scopeOf(table), 280)).toBe(
      'section[data-id="s1"]>table[grid]{width:280px}' +
      '@media screen{section[data-id="s1"]>table[grid]{margin-top:1300px;margin-bottom:2600px;overflow-anchor:none}' +
      'section[data-id="s1"]>table[grid]>tbody:nth-of-type(-n+1),section[data-id="s1"]>table[grid]>tbody:nth-of-type(n+5){display:none}}',
    );
  });

  test("filtered rows get a display:none rule outside the screen-only block, by id", () => {
    const text = ruleText({ first: 2, last: 4, before: 1300, after: 2600 }, 'section[data-id="s1"]>table[grid]', 0, ["r2", 'a"b']);
    expect(text).toContain('>tbody>tr[data-id="r2"]');
    expect(text).toContain('>tbody>tr[data-id="a\\"b"]');
    const screenEnd = text.indexOf("{display:none}}") + "{display:none}}".length;
    const filteredAt = text.indexOf('>tbody>tr[data-id="r2"]');
    expect(filteredAt).toBeGreaterThan(screenEnd - 1);
    expect(text.endsWith("}")).toBe(true);
  });

  test("a new window adopts its sheet, shows the first groups, and writes nothing into the page", () => {
    const table = workbook([50, 50, 50, 50, 50]);
    const before = document.body.innerHTML;
    const sheet = fakeSheet();
    const adopted = [];
    const win = createRowWindow(table, { sheet, adopt: (s) => adopted.push(s), drop: () => {}, schedule: sync });
    expect(adopted).toEqual([sheet]);
    expect(win.shown.first).toBe(1);
    expect(sheet.text).toContain("{width:280px}");
    expect(sheet.text).toContain(`tbody:nth-of-type(n+${win.shown.last + 1}){display:none}`);
    expect(document.body.innerHTML).toBe(before);
    win.dispose();
  });

  test("a structure change reads the table again; a cell change does not rebuild", () => {
    const table = workbook([50, 50]);
    const win = createRowWindow(table, { sheet: fakeSheet(), adopt: () => {}, drop: () => {}, schedule: sync });
    const first = win.geometry;
    win.follow({ cells: [{ row: "r3", col: "c1" }], rows: { added: [], removed: [], changed: [] }, structure: false });
    expect(win.geometry).toBe(first);
    table.insertAdjacentHTML("beforeend", '<tbody><tr data-id="r100"></tr></tbody>');
    win.follow({ structure: true, rows: { added: ["r100"], removed: [], changed: [] }, cells: [] });
    expect(win.geometry).not.toBe(first);
    expect(win.geometry.groupCount).toBe(3);
    win.dispose();
  });

  test("a tab that is shown later places its window where the page is scrolled to", () => {
    const observers = [];
    globalThis.ResizeObserver = class {
      constructor(fn) { this.fn = fn; this.targets = []; observers.push(this); }
      observe(el) { this.targets.push(el); }
      disconnect() {}
    };
    try {
      const table = workbook([50, 50, 50, 50, 50, 50]);
      const sheet = fakeSheet();
      const win = createRowWindow(table, { sheet, adopt: () => {}, drop: () => {}, schedule: sync });
      expect(win.shown.first).toBe(1);
      // The tab was hidden while the page scrolled; now it has a box, deep in the page.
      table.getBoundingClientRect = () => ({ top: -4000 });
      const shown = observers.filter((o) => o.targets.includes(table));
      expect(shown).toHaveLength(1);
      shown[0].fn([]);
      expect(win.shown.first).toBeGreaterThan(1);
      win.dispose();
    } finally {
      delete globalThis.ResizeObserver;
    }
  });

  test("after dispose, scrolling writes no rule and the sheet is dropped", () => {
    const table = workbook([50, 50]);
    const sheet = fakeSheet();
    const dropped = [];
    const win = createRowWindow(table, { sheet, adopt: () => {}, drop: (s) => dropped.push(s), schedule: sync });
    const writes = sheet.writes;
    win.dispose();
    window.dispatchEvent(new Event("scroll"));
    win.refresh();
    expect(sheet.writes).toBe(writes);
    expect(dropped).toEqual([sheet]);
  });

  test("cellBox and cellAt place cells from the geometry and the hidden margin above, never from DOM row layout", () => {
    let n = 0;
    const bodies = Array.from({ length: 4 }, () => {
      let rows = "";
      for (let i = 0; i < 50; i++, n++) rows += `<tr data-id="r${n}"><td>${n}</td></tr>`;
      return `<tbody>${rows}</tbody>`;
    }).join("");
    document.body.innerHTML = `<main sap plugins="grid"><div items="sheets" sheet-workbook><section item data-id="s1" data-pos="V"><h2 bind="name">Budget</h2><table grid><colgroup><col><col><col></colgroup>${bodies}</table></section></div></main>`;
    const table = document.querySelector("table");
    table.getBoundingClientRect = () => ({ top: -1400, left: 10 });
    const sheet = fakeSheet();
    const win = createRowWindow(table, { sheet, adopt: () => {}, drop: () => {}, schedule: sync, overscan: 0 });
    expect(win.shown.before).toBe(1300);

    table.getBoundingClientRect = () => ({ top: 100, left: 10 });
    const box = win.cellBox(60, 2);
    expect(box).toEqual({ left: 10 + 200, top: 100 - 1300 + 60 * 26, width: 100, height: 26 });
    expect(win.cellAt(box.left + box.width / 2, box.top + box.height / 2)).toEqual({ r: 60, c: 2 });
    expect(win.cellAt(box.left - 250, box.top + 10)).toBeNull();
    win.dispose();
  });
});

// A jsdom stand-in for a browser's layout, the way the coherence check's runs stub it: the
// table's box sits at the margin the rule gives it, the groups outside the window have no
// box, and each row reports the height a browser would give it.
function layouted({ groups, rowsPerGroup, heightOf }) {
  let n = 0;
  const rowHeights = [];
  let bodies = "";
  for (let g = 0; g < groups; g++) {
    let rows = "";
    for (let i = 0; i < rowsPerGroup; i++, n++) {
      rowHeights.push(heightOf(g));
      rows += `<tr data-id="r${n}"><td>${n}</td></tr>`;
    }
    bodies += `<tbody>${rows}</tbody>`;
  }
  document.body.innerHTML = `<div id="scroller" style="overflow-y: auto"><main sap plugins="grid"><div items="sheets" sheet-workbook><section item data-id="s1" data-pos="V"><h2 bind="name">Budget</h2><table grid><colgroup><col style="width:180px"></colgroup>${bodies}</table></section></div></main></div>`;
  const scroller = document.getElementById("scroller");
  const table = scroller.querySelector("table");
  let marginTop = 0;
  let shownFirst = 1;
  let shownLast = groups;
  [...table.tBodies].forEach((group, g) => {
    for (const tr of group.rows) {
      Object.defineProperty(tr, "offsetHeight", {
        get: () => (g + 1 < shownFirst || g + 1 > shownLast ? 0 : rowHeights[Number(tr.getAttribute("data-id").slice(1))]),
      });
    }
    Object.defineProperty(group, "offsetHeight", {
      get: () => (g + 1 < shownFirst || g + 1 > shownLast ? 0 : [...group.rows].reduce((sum, tr) => sum + tr.offsetHeight, 0)),
    });
  });
  Object.defineProperty(scroller, "clientHeight", { get: () => 700 });
  table.getBoundingClientRect = () => ({ top: marginTop - scroller.scrollTop });
  scroller.getBoundingClientRect = () => ({ top: 0 });

  const sheet = {
    text: "",
    writes: 0,
    replaceSync(text) {
      this.text = text;
      this.writes++;
      const margins = text.match(/margin-top:(\d+)px;margin-bottom:(\d+)px/);
      if (margins) marginTop = Number(margins[1]);
      const shown = text.match(/nth-of-type\(-n\+(\d+)\).*nth-of-type\(n\+(\d+)\)/);
      if (shown) {
        shownFirst = Number(shown[1]) + 1;
        shownLast = Number(shown[2]) - 1;
      }
    },
  };

  const jobs = [];
  const schedule = (fn) => jobs.push(fn);
  const settle = () => {
    for (let guard = 0; jobs.length && guard < 1000; guard++) jobs.shift()();
  };
  return {
    scroller,
    table,
    sheet,
    schedule,
    settle,
    scrollTo(y) {
      scroller.scrollTop = Math.max(0, y);
      scroller.dispatchEvent(new Event("scroll"));
      settle();
    },
    // The row at the viewport's top edge, and how far into it the viewport starts.
    topRow() {
      let y = marginTop;
      for (let g = shownFirst - 1; g <= shownLast - 1; g++) {
        for (let i = 0; i < table.tBodies[g].rows.length; i++) {
          const height = table.tBodies[g].rows[i].offsetHeight;
          if (y + height > scroller.scrollTop) return { row: g * rowsPerGroup + i, offset: scroller.scrollTop - y };
          y += height;
        }
      }
      return null;
    },
    // Where that row really sits, so two reports of it can be compared.
    yOf({ row, offset }) {
      let y = 0;
      for (let i = 0; i < row; i++) y += rowHeights[i];
      return y + offset;
    },
  };
}

describe("the row window against a laid out table", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("a refresh deep in the table keeps the rows on screen", () => {
    const env = layouted({ groups: 400, rowsPerGroup: 50, heightOf: () => 26 });
    const win = createRowWindow(env.table, { sheet: env.sheet, adopt: () => {}, drop: () => {}, schedule: env.schedule });
    env.scrollTo(260000);
    expect(env.topRow()).toEqual({ row: 10000, offset: 0 });

    win.refresh();
    env.settle();

    expect(win.shown.first).toBe(200);
    expect(win.shown.last).toBeGreaterThanOrEqual(201);
    expect(env.topRow()).toEqual({ row: 10000, offset: 0 });
    win.dispose();
  });

  test("measuring rows above the top while scrolling up does not move the rows on screen", () => {
    // Two groups were measured when the window opened; every group above row 10,000 still
    // sits on the 26 px estimate and is four lines tall.
    const env = layouted({ groups: 400, rowsPerGroup: 50, heightOf: (g) => (g < 200 ? 104 : 26) });
    const win = createRowWindow(env.table, { sheet: env.sheet, adopt: () => {}, drop: () => {}, schedule: env.schedule });
    env.scrollTo(201 * 1300 + 2 * 50 * (104 - 26) + 10 * 26);

    for (let step = 1; step <= 18; step++) {
      const before = env.topRow();
      env.scrollTo(env.scroller.scrollTop - 15);
      expect(env.yOf(env.topRow()) - env.yOf(before)).toBe(-15);
    }
    win.dispose();
  });

  test("reading the table again deep in it keeps the rows on screen when rows are not 26 px", () => {
    const env = layouted({ groups: 200, rowsPerGroup: 50, heightOf: () => 30 });
    const win = createRowWindow(env.table, { sheet: env.sheet, adopt: () => {}, drop: () => {}, schedule: env.schedule });
    for (let y = 0; y <= 5000 * 30; y += 600) env.scrollTo(y);
    const top = env.topRow();
    expect(top.row).toBeGreaterThan(4900);

    win.follow({ rescanned: true, structure: true, cells: [], rows: { added: [], removed: [], changed: [] }, cols: { added: [], removed: [], changed: [] } });
    env.settle();
    expect(env.topRow()).toEqual(top);

    win.follow({ structure: true, cells: [], rows: { added: [], removed: [], changed: [] }, cols: { added: [], removed: [], changed: ["c1"] } });
    env.settle();
    expect(env.topRow()).toEqual(top);
    win.dispose();
  });
});
