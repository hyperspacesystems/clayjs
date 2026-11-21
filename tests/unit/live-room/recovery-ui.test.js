/**
 * @jest-environment jsdom
 */
import v8 from "node:v8";
import { createReferenceHost } from "../../live-room/host/reference-host.mjs";
import { createRoomClient, connect } from "../../../src/live-room/room-client.js";
import { serialize, parse } from "../../../src/live-room/core/record.js";
import { useCodec } from "../../../src/live-room/core/codec.js";
import { labLimits } from "../../../src/live-room/core/limits.js";
import { codec as tiny } from "../../live-room/lab/codec-tiny/reducer.mjs";
import { createSaveChip } from "../../../src/live-room/ui/save-chip.js";
import { createRecoveryPanel } from "../../../src/live-room/ui/recovery-panel.js";

globalThis.structuredClone ??= (value) => v8.deserialize(v8.serialize(value));

if (!globalThis.Headers) {
  class SimpleHeaders {
    constructor(init = {}) {
      this._map = new Map();
      if (init instanceof SimpleHeaders) {
        for (const [k, v] of init._map) this._map.set(k, v);
      } else if (init && typeof init === "object") {
        for (const [k, v] of Object.entries(init)) {
          if (v !== undefined) this._map.set(String(k).toLowerCase(), String(v));
        }
      }
    }
    get(name) {
      return this._map.get(String(name).toLowerCase()) ?? null;
    }
    set(name, value) {
      this._map.set(String(name).toLowerCase(), String(value));
    }
    has(name) {
      return this._map.has(String(name).toLowerCase());
    }
  }
  globalThis.Headers = SimpleHeaders;
}

if (!globalThis.Request) {
  class SimpleRequest {
    constructor(input, init = {}) {
      this.url = String(input);
      this.method = String(init.method ?? "GET").toUpperCase();
      this.headers = new globalThis.Headers(init.headers);
      this._body = init.body === undefined ? "" : String(init.body);
    }
    async text() {
      return this._body;
    }
    async json() {
      return JSON.parse(this._body);
    }
    clone() {
      return new SimpleRequest(this.url, {
        method: this.method,
        headers: this.headers,
        body: this._body,
      });
    }
  }
  globalThis.Request = SimpleRequest;
}

if (!globalThis.Response) {
  class SimpleResponse {
    constructor(body = "", init = {}) {
      this._body = body === undefined || body === null ? "" : String(body);
      this.status = init.status ?? 200;
      this.ok = this.status >= 200 && this.status < 300;
      this.headers = new globalThis.Headers(init.headers);
    }
    async text() {
      return this._body;
    }
    async json() {
      return JSON.parse(this._body);
    }
    clone() {
      return new SimpleResponse(this._body, {
        status: this.status,
        headers: this.headers,
      });
    }
  }
  globalThis.Response = SimpleResponse;
}

const RECORD = {
  v: 2,
  doc: "doc0123456789abc",
  gen: "0.00000000",
  epoch: 0,
  commit: "c00000000000",
  parent: null,
  through: 0,
};
const START = {
  wb: {
    rows: {
      r1: { pos: "1", cells: { c1: "a", c2: "b" } },
      r2: { pos: "2", cells: { c1: "c", c2: "d" } },
    },
  },
  seen: {},
  lineage: [],
  cut: null,
  floor: -1,
};

const setCell = (row, col, value) => ({ t: "set", row, col, value });
const delRow = (row) => ({ t: "del", row });
const isCopyWrite = (request) => request.method === "PUT" && new URL(request.url).pathname.startsWith("/_/copies");
const isSaveWrite = (request) => request.method === "POST" && new URL(request.url).pathname === "/_/save";
const isFrame = (request) =>
  request.method === "POST" &&
  new URL(request.url).pathname === "/_/sync/room" &&
  !new URL(request.url).searchParams.has("op");

const openClients = [];
const openDisposables = [];

afterEach(async () => {
  for (const item of openDisposables.splice(0)) item.destroy();
  await Promise.all(openClients.splice(0).map((client) => client.close()));
  document.body.innerHTML = "";
});

async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition did not hold before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function untilDone(work, check, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await work();
    if (check(value)) return value;
    if (Date.now() > end) throw new Error("async condition did not hold before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const gated = (host, matches, flag) => (url, init = {}) => {
  if (flag() && matches(new Request(new URL(url, "http://host.test"), init))) {
    return Promise.reject(new TypeError("fetch failed: gated"));
  }
  return host.fetch(url, init);
};

function createWorld() {
  let ids = 0;
  const host = createReferenceHost({
    codecs: { tiny },
    codec: "tiny",
    rooms: { limits: labLimits(), newId: () => 1000 * ++ids },
  });
  useCodec(tiny);
  host.put("doc", serialize(RECORD, structuredClone(START)));
  const join = (clientId, options = {}) => {
    const client = createRoomClient({
      page: "doc",
      codec: tiny,
      clientId,
      fetch: host.fetch,
      subscribe: host.subscribe,
      limits: labLimits(),
      firstId: 10_000 * (openClients.length + 1),
      idleMs: 5,
      maxMs: 20,
      waitMs: 40,
      ...options,
    });
    openClients.push(client);
    return client;
  };
  const cell = (row, col) => {
    useCodec(tiny);
    return parse(host.file("doc").bytes).state.wb.rows[row]?.cells[col] ?? "";
  };
  return { host, join, cell };
}

async function strandEdits(w, client, actions, { afterAdmitted } = {}) {
  const base = w.host.file("doc").bytes;
  useCodec(tiny);
  const { record, state } = parse(base);
  state.wb.rows.r2.cells.extra = "prep";
  await w.host.outside("doc", serialize(record, state), "agent");
  for (const action of actions) {
    const handle = client.submit(action);
    await expect(handle.admitted).resolves.toBe("shared");
  }
  afterAdmitted?.();
  w.host.loseRoom("doc");
  await w.host.outside("doc", base, "restore");
}

function mockRoom(initialStatus = {}, extras = {}) {
  const listeners = new Set();
  const room = {
    status: {
      mode: "ordered",
      connected: true,
      pending: 0,
      unsaved: 0,
      unknownSave: false,
      generation: "1.00000001",
      through: 2,
      copies: 0,
      unstored: 0,
      restoring: false,
      pendingMarks: 0,
      conflicts: 0,
      error: null,
      ...initialStatus,
    },
    view: () => ({ rows: { r1: { pos: "1", cells: { c1: "now" } } } }),
    notices: () => [],
    copies: () => [],
    unstoredCopies: () => [],
    refreshCopies: async () => {},
    restore: async () => false,
    decide: async () => false,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(event = { type: "change" }) {
      for (const fn of listeners) fn(event);
    },
    ...extras,
  };
  return room;
}

function buttonByText(container, label) {
  return [...container.querySelectorAll("button")].find(
    (btn) => btn.textContent.trim() === label || btn.textContent.includes(label),
  );
}

describe("createSaveChip", () => {
  // Bug it catches: a chip that prints "Saved" from stream connectivity alone, hiding pending,
  // unsaved, unknownSave, unstored, pendingMarks, conflicts, restoring, error, or unavailable state.
  test("never shows Saved when any single safety condition is false, and renders distinct states", () => {
    const room = mockRoom();
    const chip = createSaveChip({ room });
    openDisposables.push(chip);

    expect(chip.el.getAttribute("role")).toBe("status");
    expect(chip.el.getAttribute("aria-live")).toBe("polite");
    expect(chip.el.hasAttribute("data-live-room-chip")).toBe(true);
    expect(chip.el.textContent).toBe("Saved");

    room.status = { ...room.status, mode: "file" };
    room.emit();
    expect(chip.el.textContent).toBe("Saved");

    const singleMutations = [
      [{ mode: "connecting", connected: false }, "Connecting"],
      [{ mode: "unavailable" }, "Cannot save here"],
      [{ mode: "closed", connected: false }, "Closed"],
      [{ connected: false }, "Offline"],
      [{ pending: 2 }, "2 local edits"],
      [{ mode: "file", pending: 1 }, "1 local edit, saving"],
      [{ unsaved: 3 }, "Shared, saving"],
      [{ unknownSave: true }, "Checking save"],
      [{ unstored: 1 }, "1 copy not stored"],
      [{ pendingMarks: 1 }, "Recording decision"],
      [{ conflicts: 2 }, "2 conflicts to review"],
      [{ restoring: true }, "Restoring edits"],
      [{ error: new Error("socket closed") }, "Offline, retrying"],
    ];

    const savedBase = {
      mode: "ordered",
      connected: true,
      pending: 0,
      unsaved: 0,
      unknownSave: false,
      generation: "1.00000001",
      through: 2,
      copies: 0,
      unstored: 0,
      restoring: false,
      pendingMarks: 0,
      conflicts: 0,
      error: null,
    };

    for (const [patch, expectedText] of singleMutations) {
      room.status = { ...savedBase, ...patch };
      room.emit();
      expect(chip.el.textContent).not.toMatch(/saved/i);
      expect(chip.el.textContent).toContain(expectedText);
    }

    room.status = savedBase;
    room.emit();
    expect(chip.el.textContent).toBe("Saved");
  });

  // Bug it catches: conflict, unstored, or unavailable chip buttons that display a count as static
  // text or wire the wrong callback.
  test("wires conflict, unstored, and unavailable buttons to onOpenRecovery and onDownload", () => {
    let opened = 0;
    let downloaded = 0;
    const room = mockRoom({ conflicts: 3 });
    const chip = createSaveChip({
      room,
      onOpenRecovery: () => {
        opened += 1;
      },
      onDownload: () => {
        downloaded += 1;
      },
    });
    openDisposables.push(chip);

    const conflictBtn = chip.el.querySelector("button");
    expect(conflictBtn.textContent).toBe("3 conflicts to review");
    conflictBtn.click();
    expect(opened).toBe(1);
    expect(downloaded).toBe(0);

    room.status = { ...room.status, conflicts: 0, unstored: 2 };
    room.emit();
    const unstoredBtn = chip.el.querySelector("button");
    expect(unstoredBtn.textContent).toBe("2 copies not stored");
    unstoredBtn.click();
    expect(opened).toBe(2);

    const downloadOnlyChip = createSaveChip({
      room,
      onDownload: () => {
        downloaded += 1;
      },
    });
    openDisposables.push(downloadOnlyChip);
    downloadOnlyChip.el.querySelector("button").click();
    expect(downloaded).toBe(1);

    room.status = { ...room.status, unstored: 0, mode: "unavailable" };
    room.emit();
    expect(chip.el.textContent).toContain("Cannot save here");
    buttonByText(chip.el, "Download copy").click();
    expect(downloaded).toBe(2);

    chip.destroy();
    room.status = { ...room.status, mode: "ordered" };
    room.emit();
    expect(chip.el.isConnected).toBe(false);
  });
});

describe("createRecoveryPanel", () => {
  // Bug it catches: a conflict card that snapshots the cell value once on open and never updates
  // when a coworker edits the cell live, or resolves "Keep current" without clearing highlights.
  test("renders real conflict from reference host, updates live value with marker, and resolves via Keep current", async () => {
    const w = createWorld();
    let holdCopy = true;
    const ana = w.join("ana", {
      idleMs: 60_000,
      maxMs: 120_000,
      fetch: gated(w.host, isCopyWrite, () => holdCopy),
    });
    await ana.ready;
    await strandEdits(w, ana, [setCell("r1", "c1", "mine")]);

    const ben = w.join("ben");
    await ben.ready;
    await ben.submit(setCell("r1", "c1", "ben-first")).durable;

    holdCopy = false;
    await untilDone(
      async () => {
        await ana.flush();
        return ana.notices().find((n) => n.kind === "restored" && n.conflicts.length > 0);
      },
      Boolean,
    );

    const revealed = [];
    const highlights = [];
    let refreshed = 0;
    ana.refreshCopies = async () => {
      refreshed += 1;
    };

    const panel = createRecoveryPanel({
      room: ana,
      codec: tiny,
      onReveal: (target) => revealed.push(target),
      onConflictsHighlight: (targets) => highlights.push(targets),
    });
    openDisposables.push(panel);

    panel.open();
    expect(panel.isOpen()).toBe(true);
    expect(refreshed).toBe(1);
    expect(highlights.at(-1)).toEqual(["r1/c1"]);
    expect(panel.el.textContent).toContain("Saved with this document");
    expect(panel.el.textContent).toContain("1 needs your decision");
    expect(panel.el.textContent).toContain("Set a cell");
    expect(panel.el.textContent).toContain("r1 c1");
    expect(panel.el.textContent).toContain("mine");
    expect(panel.el.textContent).toContain("ben-first");
    expect(panel.el.querySelector("[data-changed-since-looked]")).toBeNull();

    buttonByText(panel.el, "Show in sheet").click();
    expect(revealed).toEqual(["r1/c1"]);

    await ben.submit(setCell("r1", "c1", "ben-live")).durable;
    await until(() => panel.el.textContent.includes("ben-live"));
    expect(panel.el.querySelector("[data-changed-since-looked]")?.textContent).toBe(
      "Changed since you looked",
    );

    buttonByText(panel.el, "Keep current").click();
    await untilDone(
      async () => {
        await ana.flush();
        return panel.el.querySelector("[data-earlier-section]");
      },
      Boolean,
    );

    expect(w.cell("r1", "c1")).toBe("ben-live");
    expect(panel.el.querySelector("[data-conflict-card]")).toBeNull();
    expect(highlights.at(-1)).toEqual([]);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.isOpen()).toBe(false);
    expect(highlights.at(-1)).toEqual([]);
  }, 15_000);

  // Bug it catches: a "Take copy" button that forgets to pass the decision to room.decide or fails
  // to move the settled copy into "Earlier" once the stored value lands on disk.
  test("Take copy applies the stored edit on the reference host and moves the copy to Earlier", async () => {
    const w = createWorld();
    let holdCopy = true;
    const ana = w.join("ana", {
      idleMs: 60_000,
      maxMs: 120_000,
      fetch: gated(w.host, isCopyWrite, () => holdCopy),
    });
    await ana.ready;
    await strandEdits(w, ana, [setCell("r1", "c1", "recovered-mine")]);

    const ben = w.join("ben");
    await ben.ready;
    await ben.submit(setCell("r1", "c1", "ben-value")).durable;

    holdCopy = false;
    await untilDone(
      async () => {
        await ana.flush();
        return ana.notices().find((n) => n.kind === "restored" && n.conflicts.length > 0);
      },
      Boolean,
    );

    const panel = createRecoveryPanel({ room: ana, codec: tiny });
    openDisposables.push(panel);
    panel.open();

    buttonByText(panel.el, "Take copy").click();
    await untilDone(
      async () => {
        await ana.flush();
        return w.cell("r1", "c1");
      },
      (val) => val === "recovered-mine",
    );
    await until(() => Boolean(panel.el.querySelector("[data-earlier-section]")));
    expect(panel.el.querySelector("[data-earlier-section]").textContent).toContain("1 restored and saved");
  }, 15_000);

  // Bug it catches: waiting edits rendered expanded by default (forcing users to scroll past dozens
  // of held edits) or "Keep current for the rest" dropping non-conflicting waiting edits instead of
  // stepping single keep decisions sequentially.
  test("collapses waiting edits by default and steps Keep current for the rest across author conflicts", async () => {
    const w = createWorld();
    let holdCopy = true;
    let holdSave = true;
    const ana = w.join("ana", {
      idleMs: 5,
      maxMs: 20,
      fetch: gated(w.host, (req) => (holdCopy && isCopyWrite(req)) || (holdSave && isSaveWrite(req)), () => true),
    });
    await ana.ready;
    await strandEdits(w, ana, [
      setCell("r1", "c1", "ana-c1-first"),
      setCell("r1", "c1", "ana-c1-later-1"),
      setCell("r1", "c1", "ana-c1-later-2"),
      setCell("r2", "c1", "ana-r2c1"),
      setCell("r2", "c2", "ana-clean"),
    ]);

    const ben = w.join("ben");
    await ben.ready;
    await ben.submit(setCell("r1", "c1", "ben-c1")).durable;
    await ben.submit(setCell("r2", "c1", "ben-r2c1")).durable;

    holdSave = false;
    holdCopy = false;
    await until(() => ana.notices().some((n) => n.kind === "restored" && n.conflicts.length > 0));

    const panel = createRecoveryPanel({ room: ana, codec: tiny });
    openDisposables.push(panel);
    panel.open();

    expect(panel.el.querySelectorAll("[data-conflict-card]")).toHaveLength(1);
    expect(panel.el.textContent).toContain("1 more conflict next");
    const waitingDetails = panel.el.querySelector("[data-waiting-group]");
    expect(waitingDetails).not.toBeNull();
    expect(waitingDetails.open).toBe(false);
    expect(waitingDetails.querySelector("summary").textContent).toBe(
      "2 later edits wait for this decision",
    );

    waitingDetails.open = true;
    waitingDetails.dispatchEvent(new Event("toggle"));
    expect(waitingDetails.textContent).toContain("ana-c1-later-1");
    expect(waitingDetails.textContent).toContain("ana-c1-later-2");

    expect(buttonByText(panel.el, "Take all")).toBeUndefined();
    buttonByText(panel.el, "Keep current for the rest").click();

    await until(() => Boolean(panel.el.querySelector("[data-earlier-section]")));
    expect(w.cell("r1", "c1")).toBe("ben-c1");
    expect(w.cell("r2", "c1")).toBe("ben-r2c1");
    expect(w.cell("r2", "c2")).toBe("ana-clean");
  }, 15_000);

  // Bug it catches: offering a "Take copy" button on an unjudged or misfit edit (which could apply
  // an insert twice or write to a deleted row), or failing to copy/download the stranded value.
  test("shows Copy value and Download copy on unjudged, misfit, and refused edits and never Take copy", async () => {
    const w = createWorld();
    let holdCopy = true;
    const ana = w.join("ana", {
      idleMs: 5,
      maxMs: 20,
      fetch: gated(w.host, isCopyWrite, () => holdCopy),
    });
    await ana.ready;
    await strandEdits(w, ana, [setCell("r1", "c1", "deleted-row-val")]);

    const ben = w.join("ben");
    await ben.ready;
    await ben.submit(delRow("r1")).durable;

    holdCopy = false;
    await until(() => ana.notices().some((n) => n.kind === "restored" && n.misfit.length > 0));

    const downloads = [];
    const revealed = [];
    let clipboardText = null;
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          clipboardText = text;
        },
      },
    });

    const realMisfitPanel = createRecoveryPanel({
      room: ana,
      codec: tiny,
      onReveal: (target) => revealed.push(target),
      onDownload: (copy) => downloads.push(copy),
    });
    openDisposables.push(realMisfitPanel);
    realMisfitPanel.open();

    expect(realMisfitPanel.el.textContent).toContain("1 no longer has a place");
    expect(realMisfitPanel.el.textContent).toContain("deleted-row-val");
    expect(buttonByText(realMisfitPanel.el, "Take copy")).toBeUndefined();
    expect(buttonByText(realMisfitPanel.el, "Keep current")).toBeUndefined();

    buttonByText(realMisfitPanel.el, "Copy value").click();
    await until(() => clipboardText === "deleted-row-val");

    buttonByText(realMisfitPanel.el, "Show in sheet").click();
    expect(revealed).toEqual(["r1/c1"]);

    buttonByText(realMisfitPanel.el, "Download copy").click();
    expect(downloads).toHaveLength(1);
    expect(downloads[0].edits[0].e).toBe("ana:1");

    const unjudgedCopy = {
      id: "r99",
      v: 4,
      edits: [
        { e: "old:1", c: "old", n: 1, out: "unanswered", action: setCell("r2", "c1", "unjudged-val"), saw: ["c"] },
        { e: "old:2", c: "old", n: 2, out: "refused", action: setCell("r2", "c2", "refused-val"), saw: ["d"] },
      ],
      refused: ["old:2"],
      marks: [],
    };
    const mock = mockRoom(
      { copies: 1 },
      {
        view: () => ({ rows: { r2: { pos: "2", cells: { c1: "current-c1", c2: "current-c2" } } } }),
        copies: () => [unjudgedCopy],
        notices: () => [
          {
            kind: "restored",
            job: "old#1",
            copy: "r99",
            applied: [],
            kept: [],
            misfit: [],
            conflicts: [],
            saved: [],
            replaced: [],
            counted: [],
            refused: ["old:2"],
            held: [],
            removed: [],
            left: ["old:1"],
          },
        ],
      },
    );

    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("clipboard blocked");
        },
      },
    });
    let execCopied = false;
    document.execCommand = (cmd) => {
      if (cmd === "copy") {
        execCopied = true;
        return true;
      }
      return false;
    };

    const unjudgedPanel = createRecoveryPanel({ room: mock, codec: tiny });
    openDisposables.push(unjudgedPanel);
    unjudgedPanel.open();

    expect(unjudgedPanel.el.textContent).toContain("1 cannot be judged");
    expect(unjudgedPanel.el.textContent).toContain("1 refused when made");
    expect(unjudgedPanel.el.textContent).toContain("unjudged-val");
    expect(unjudgedPanel.el.textContent).toContain("current-c1");
    expect(unjudgedPanel.el.textContent).toContain("refused-val");
    expect(buttonByText(unjudgedPanel.el, "Take copy")).toBeUndefined();
    expect(buttonByText(unjudgedPanel.el, "Keep current")).toBeUndefined();

    buttonByText(unjudgedPanel.el, "Copy value").click();
    await until(() => execCopied === true);
  }, 15_000);

  // Bug it catches: decision buttons left enabled while another copy's automatic restore job is
  // running (Opus 7), where room.decide silently returns false and drops the user's click.
  test("disables decision buttons with clear status text while status.restoring is true", () => {
    let decideCalls = 0;
    const copy = {
      id: "r1",
      v: 4,
      edits: [{ e: "ana:1", c: "ana", n: 1, out: "applied", action: setCell("r1", "c1", "mine"), saw: ["a"] }],
      refused: [],
      marks: [],
    };
    const room = mockRoom(
      { restoring: true, conflicts: 1, copies: 1 },
      {
        copies: () => [copy],
        notices: () => [
          {
            kind: "restored",
            job: "ana#1",
            copy: "r1",
            applied: [],
            kept: [],
            misfit: [],
            conflicts: [{ e: "ana:1", cells: [["r1", "c1", "now", "mine"]] }],
            saved: [],
            replaced: [],
            counted: [],
            refused: [],
            held: [],
            removed: [],
            left: [],
          },
        ],
        decide: async () => {
          decideCalls += 1;
          return true;
        },
      },
    );

    const panel = createRecoveryPanel({ room, codec: tiny });
    openDisposables.push(panel);
    panel.open();

    expect(panel.el.querySelector("[data-restoring-status]")?.textContent).toContain(
      "Restoring edits now",
    );
    const keepBtn = buttonByText(panel.el, "Keep current");
    const takeBtn = buttonByText(panel.el, "Take copy");
    const keepRestBtn = buttonByText(panel.el, "Keep current for the rest");
    expect(keepBtn.disabled).toBe(true);
    expect(takeBtn.disabled).toBe(true);
    expect(keepRestBtn.disabled).toBe(true);
    expect(keepBtn.getAttribute("aria-disabled")).toBe("true");

    keepBtn.click();
    takeBtn.click();
    expect(decideCalls).toBe(0);

    room.status = { ...room.status, restoring: false };
    room.emit();
    expect(buttonByText(panel.el, "Keep current").disabled).toBe(false);
    expect(buttonByText(panel.el, "Take copy").disabled).toBe(false);
  });

  // Bug it catches: unstored copies hidden or labeled as saved on the host, or stored copies from
  // another tab stuck with no action because this tab has no restored notice yet.
  test("renders unstored tab drafts with download trigger and restores unrestored copies from another tab", async () => {
    const w = createWorld();
    let dropFrames = false;
    const ana = w.join("ana", {
      idleMs: 60_000,
      maxMs: 120_000,
      fetch: gated(w.host, isFrame, () => dropFrames),
    });
    await ana.ready;
    await strandEdits(w, ana, [setCell("r1", "c1", "from-other-tab")], {
      afterAdmitted: () => {
        dropFrames = true;
      },
    });
    await until(() => ana.status.copies === 1);
    await ana.close();
    dropFrames = false;
    w.host.loseRoom("doc");

    const cy = w.join("cy");
    await cy.ready;
    const draft = {
      id: "draft-local",
      about: { edits: [{ e: "cy:1", c: "cy", n: 1, action: setCell("r2", "c1", "tab-only"), saw: ["c"] }] },
      body: "<!doctype html><p>draft</p>",
    };
    cy.unstoredCopies = () => [draft];

    const downloads = [];
    const panel = createRecoveryPanel({
      room: cy,
      codec: tiny,
      onDownload: (item) => downloads.push(item),
    });
    openDisposables.push(panel);
    panel.open();

    const unstoredCard = panel.el.querySelector("[data-unstored-copy]");
    expect(unstoredCard.textContent).toContain("Kept in this tab: keep open or download");
    expect(unstoredCard.textContent).toContain("tab-only");
    buttonByText(unstoredCard, "Download copy").click();
    expect(downloads).toEqual([draft]);

    const restoreBtn = buttonByText(panel.el, "Check and restore");
    expect(restoreBtn).toBeDefined();
    restoreBtn.click();

    await until(() => w.cell("r1", "c1") === "from-other-tab");
    await untilDone(
      async () => {
        await cy.flush();
        return panel.el.querySelector("[data-earlier-section]");
      },
      Boolean,
    );
    expect(panel.el.querySelector("[data-earlier-section]").textContent).toContain(
      "1 restored and saved",
    );
  }, 15_000);

  // Bug it catches: listing newer copies ahead of older ones (violating oldest-first recovery order)
  // or leaving controls below 44px touch height on 320px and 390px phone screens.
  test("lists open copies oldest first and applies 44px touch targets at 320px and 390px widths", () => {
    const prevWidth = window.innerWidth;
    window.innerWidth = 320;
    try {
      const newer = {
        id: "r-newer",
        v: 4,
        at: 2000,
        edits: [{ e: "b:1", c: "b", n: 1, out: "applied", action: setCell("r2", "c1", "second"), saw: ["c"] }],
        refused: [],
        marks: [],
      };
      const older = {
        id: "r-older",
        v: 4,
        at: 1000,
        edits: [{ e: "a:1", c: "a", n: 1, out: "applied", action: setCell("r1", "c1", "first"), saw: ["a"] }],
        refused: [],
        marks: [],
      };
      const room = mockRoom(
        { copies: 2, conflicts: 2 },
        {
          copies: () => [newer, older],
          notices: () => [
            {
              kind: "restored",
              job: "j-newer",
              copy: "r-newer",
              applied: [],
              kept: [],
              misfit: [],
              conflicts: [{ e: "b:1", cells: [["r2", "c1", "now", "second"]] }],
              saved: [],
              replaced: [],
              counted: [],
              refused: [],
              held: [],
              removed: [],
              left: [],
            },
            {
              kind: "restored",
              job: "j-older",
              copy: "r-older",
              applied: [],
              kept: [],
              misfit: [],
              conflicts: [{ e: "a:1", cells: [["r1", "c1", "now", "first"]] }],
              saved: [],
              replaced: [],
              counted: [],
              refused: [],
              held: [],
              removed: [],
              left: [],
            },
          ],
        },
      );

      const hostSlot = document.createElement("div");
      document.body.append(hostSlot);
      const panel = createRecoveryPanel({ room, codec: tiny, parent: hostSlot });
      openDisposables.push(panel);
      panel.open();

      const sections = [...panel.el.querySelectorAll("[data-copy-section]")].map((el) =>
        el.getAttribute("data-copy-section"),
      );
      expect(sections).toEqual(["r-older", "r-newer"]);
      expect(buttonByText(panel.el, "Keep current").style.getPropertyValue("min-height")).toBe("44px");

      window.innerWidth = 390;
      window.dispatchEvent(new Event("resize"));
      expect(buttonByText(panel.el, "Take copy").style.getPropertyValue("min-height")).toBe("44px");
    } finally {
      window.innerWidth = prevWidth;
    }
  });

  // Bug it catches: recovery-panel assumed 4-element codec-tiny conflict tuples, dropped row 26
  // from a 26-row Sap.grid.roomCodec paste, appended digests to highlights, showed raw FNV-1a hex
  // hashes in "Saw then", and stringified formula objects as JSON.
  test("renders Sap.grid.roomCodec 2-tuple conflicts, prioritizes conflicting cell beyond row 24, hides digest hashes, and formats formulas", async () => {
    const Sap = (await import("../../../src/vendor/sap-core.vendor.js")).default;
    const gridPlugin = (await import("../../../src/vendor/sap-grid.vendor.js")).default;
    if (!Sap.grid) Sap.use(gridPlugin);
    const sheetCodec = Sap.grid.roomCodec;
    const rows = Array.from({ length: 26 }, (_, i) => `<tr data-id="r${i + 1}" data-pos="a${String(i + 1).padStart(2, "0")}"><td>v${i + 1}</td></tr>`).join("");
    const html = `<section item data-id="s1" data-pos="V"><h2 bind="name">Sheet1</h2><table grid><colgroup><col data-id="c1" data-pos="V"></colgroup><tbody>${rows}</tbody></table></section><script type="application/json" sheet-commit>{"v":2,"doc":"doc0123456789abc","gen":"0.00000000","epoch":0,"commit":"c00000000000","parent":null,"through":0,"lineage":[],"cut":null,"floor":-1,"seen":{}}</script>`;
    const { doc } = sheetCodec.read(html);
    const liveDoc = structuredClone(doc);
    const peerApplied = sheetCodec.apply(liveDoc, { v: 1, t: "set", sheet: "s1", cells: [["r26", "c1", "COWORKER_R26"]] });
    expect(peerApplied.out).toBe("applied");

    const cells = Array.from({ length: 26 }, (_, i) => [
      `r${i + 1}`,
      "c1",
      i === 25 ? { f: "=B1*2" } : `mine-${i + 1}`,
    ]);
    const action = { v: 1, t: "set", sheet: "s1", cells };
    const saw = sheetCodec.seen(doc, action);
    const conflictTuples = sheetCodec.conflicts(liveDoc, action, saw);
    expect(conflictTuples).toHaveLength(1);
    expect(conflictTuples[0][0]).toBe("s1/r26/c1");

    const highlighted = [];
    const room = mockRoom(
      { copies: 1, conflicts: 1 },
      {
        view: () => liveDoc,
        copies: () => [
          {
            id: "r-sheet",
            v: 4,
            at: 1000,
            edits: [{ e: "a:1", c: "a", n: 1, out: "applied", action, saw }],
            refused: [],
            marks: [],
          },
        ],
        notices: () => [
          {
            kind: "restored",
            job: "j-sheet",
            copy: "r-sheet",
            applied: [],
            kept: [],
            misfit: [],
            conflicts: [{ e: "a:1", cells: [...conflictTuples, ["s1#rule:k1", "d2f5f88c"]] }],
            saved: [],
            replaced: [],
            counted: [],
            refused: [],
            held: [],
            removed: [],
            left: [],
          },
        ],
      },
    );

    const hostSlot = document.createElement("div");
    document.body.append(hostSlot);
    const panel = createRecoveryPanel({
      room,
      codec: sheetCodec,
      parent: hostSlot,
      onConflictsHighlight: (targets) => highlighted.push(targets),
    });
    openDisposables.push(panel);
    panel.open();

    const text = panel.el.textContent;
    expect(text).toContain("COWORKER_R26");
    expect(text).toContain("=B1*2");
    expect(text).not.toContain('{"f":"=B1*2"}');
    expect(text).not.toContain("Saw then");
    expect(text).toContain("Changed");
    expect(highlighted.at(-1)).toContain("s1/r26/c1");
    expect(highlighted.at(-1)).toContain("s1#rule:k1");
    expect(highlighted.at(-1).some((t) => /\/[0-9a-f]{8}$/.test(t))).toBe(false);
  });

  // Bug it catches: resolving a conflict in another tab left room.status.conflicts > 0, the save
  // chip wedged on "1 conflict to review", and the recovery panel showing a closed conflict as open.
  test("clears chip and conflict card when another tab records a closing decision mark", async () => {
    const w = createWorld();
    let holdCopy = true;
    let holdSave = true;
    const ana = w.join("ana", {
      fetch: gated(w.host, (req) => (holdCopy && isCopyWrite(req)) || (holdSave && isSaveWrite(req)), () => true),
    });
    await ana.ready;

    await strandEdits(w, ana, [setCell("r1", "c1", "mine")]);
    // Ben joins after the restore and changes r1/c1 while Ana's copy upload is gated, so restoring Ana's copy conflicts on ana:1.
    const ben = w.join("ben");
    await ben.ready;
    await expect(ben.submit(setCell("r1", "c1", "coworker")).durable).resolves.toBe("saved");
    holdSave = false;
    holdCopy = false;

    await until(() => ana.status.conflicts === 1);
    const chip = createSaveChip({ room: ana });
    const hostSlot = document.createElement("div");
    document.body.append(hostSlot);
    const panel = createRecoveryPanel({ room: ana, codec: tiny, parent: hostSlot });
    openDisposables.push(chip, panel);
    panel.open();
    expect(chip.el.textContent).toContain("1 conflict to review");
    expect(panel.el.querySelectorAll("[data-conflict-card]").length).toBe(1);

    // Ben restores the copy and takes Ana's edit, recording the closing mark on the host.
    const copyId = ana.copies()[0].id;
    await ben.refreshCopies();
    await ben.restore(copyId);
    await until(() => ben.notices().some((n) => n.kind === "restored" && n.copy === copyId && n.conflicts.length === 1));
    const benJob = ben.notices().filter((n) => n.kind === "restored" && n.copy === copyId).at(-1).job;
    await ben.decide(benJob, [[ana.copies()[0].edits[0].e, "take"]]);
    await ben.flush();

    await ana.refreshCopies();
    await until(() => ana.status.conflicts === 0);
    expect(chip.el.textContent).toContain("Saved");
    expect(panel.el.querySelectorAll("[data-conflict-card]").length).toBe(0);
  }, 15_000);

  // Bug it catches: after reload, a misfit edit on a deleted row was classified via countedSet as
  // "1 already saved" (green teal badge in Earlier) and its lost value was hidden (X1 round 5 #5).
  test("surfaces dropped misfit edit on deleted row after reload instead of reporting already saved", async () => {
    const w = createWorld();
    let holdCopy = true;
    const ana = w.join("ana", {
      idleMs: 10,
      maxMs: 25,
      waitMs: 25,
      fetch: gated(w.host, isCopyWrite, () => holdCopy),
    });
    await ana.ready;
    await strandEdits(w, ana, [setCell("r1", "c1", "LOST_BUDGET_50000")]);
    const ben = w.join("ben");
    await ben.ready;
    await ben.submit(delRow("r1")).durable;
    await ben.flush();
    await ben.close();

    holdCopy = false;
    await until(() => ana.notices().some((n) => n.kind === "restored" && n.misfit.includes("ana:1")));
    await ana.flush();

    // Same-session save chip must not show green "Saved" with no recovery button when misfit dropped (X1 round 5 #10B).
    const chip = createSaveChip({ room: ana, onOpenRecovery: () => {} });
    openDisposables.push(chip);
    expect(chip.el.getAttribute("data-save-state")).toBe("recovery");
    expect(chip.el.querySelectorAll("button")).toHaveLength(1);
    expect(chip.el.textContent).toContain("1 edit not applied");

    await ana.close();

    const ana2 = w.join("ana-reloaded", { idleMs: 10, maxMs: 25, waitMs: 25 });
    await ana2.ready;
    const panel = createRecoveryPanel({ room: ana2, codec: tiny });
    openDisposables.push(panel);
    panel.open();
    const checkBtn = buttonByText(panel.el, "Check and restore");
    expect(checkBtn).toBeDefined();
    checkBtn.click();

    await until(() => Boolean(panel.el.querySelector('[data-unsettleable-kind="misfit"]')));
    expect(panel.el.textContent).toContain("LOST_BUDGET_50000");
    expect(panel.el.textContent).toContain("1 no longer has a place");
    expect(panel.el.textContent).not.toContain("already saved");
    expect(panel.el.querySelector("[data-earlier-section]")).toBeNull();
  }, 15_000);

  // Bug it catches: reloading while an open conflict mark exists on the host dropped status.conflicts
  // to 0 and turned the save chip green "Saved" with no recovery button (X1 round 5 #10A).
  test("keeps open conflict visible on save chip and room.status.conflicts after reload", async () => {
    const w = createWorld();
    let holdCopy = true;
    const ana = w.join("ana", {
      idleMs: 10,
      maxMs: 25,
      waitMs: 25,
      fetch: gated(w.host, isCopyWrite, () => holdCopy),
    });
    await ana.ready;
    await strandEdits(w, ana, [setCell("r1", "c1", "ANA_MINE")]);
    const ben = w.join("ben");
    await ben.ready;
    await ben.submit(setCell("r1", "c1", "BEN_COWORKER")).durable;
    await ben.close();

    holdCopy = false;
    await until(() => ana.status.conflicts === 1);
    await ana.flush();
    await ana.close();

    const anaReloaded = w.join("ana_reload", { idleMs: 10, maxMs: 25, waitMs: 25 });
    await anaReloaded.ready;
    expect(anaReloaded.status.conflicts).toBe(1);
    const chip = createSaveChip({ room: anaReloaded, onOpenRecovery: () => {} });
    openDisposables.push(chip);
    expect(chip.el.getAttribute("data-save-state")).toBe("conflicts");
    expect(chip.el.textContent).toContain("1 conflict to review");
    expect(chip.el.querySelectorAll("button")).toHaveLength(1);
  }, 15_000);

  // Bug it catches: file-only mode trapped stored copies behind a dead-end "Check and restore" button
  // while showing "Saved", and createFileClient.unstoredCopies() stripped `edits` (X1 round 5 #6).
  test("file-only mode surfaces stored copy values directly without dead-end restore and preserves unstored edits", async () => {
    async function retireAna(withCopies) {
      const limits = labLimits({ ledgerCap: 120 });
      const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", room: false, rooms: { limits } });
      useCodec(tiny);
      host.put("doc", serialize(RECORD, structuredClone(START)));
      let dropSaves = false;
      let mutePushes = false;
      const ana = await connect({
        page: "doc",
        codec: tiny,
        clientId: "ana",
        fetch: (url, init = {}) =>
          dropSaves && init.method === "POST" && String(url).includes("/_/save")
            ? Promise.reject(new TypeError("save lost"))
            : host.fetch(url, init),
        subscribe: (page, clientId, listener) => host.subscribe(page, clientId, (ev) => !mutePushes && listener(ev)),
        extensions: withCopies ? ["ordered-file", "recovery-copies"] : ["ordered-file"],
        limits,
        idleMs: 10,
        maxMs: 25,
      });
      openClients.push(ana);
      await ana.ready;
      dropSaves = true;
      mutePushes = true;
      ana.submit(setCell("r1", "c1", "STRANDED_ONE"));
      ana.submit(setCell("r2", "c1", "STRANDED_TWO"));
      ana.submit(setCell("r2", "c2", "STRANDED_THREE"));
      await new Promise((r) => setTimeout(r, 30));
      for (let i = 1; i <= 8; i++) {
        const peer = await connect({
          page: "doc",
          codec: tiny,
          clientId: `peer_${i}`,
          fetch: host.fetch,
          subscribe: host.subscribe,
          extensions: ["ordered-file"],
          limits,
          idleMs: 5,
          maxMs: 15,
        });
        await peer.ready;
        peer.submit(setCell("r1", "c2", `p${i}`));
        await peer.flush();
        await peer.close();
      }
      dropSaves = false;
      mutePushes = false;
      ana.submit(setCell("r1", "c2", "after-retire"));
      await ana.flush();
      return ana;
    }

    const anaStored = await retireAna(true);
    await until(() => anaStored.copies().length === 1);
    const chip = createSaveChip({ room: anaStored, onOpenRecovery: () => {} });
    const panel = createRecoveryPanel({ room: anaStored, codec: tiny });
    openDisposables.push(chip, panel);
    expect(chip.el.getAttribute("data-save-state")).toBe("recovery");
    expect(chip.el.textContent).toContain("3 recovered edits");
    panel.open();
    expect(buttonByText(panel.el, "Check and restore")).toBeUndefined();
    expect(panel.el.textContent).toContain("STRANDED_ONE");
    expect(panel.el.textContent).toContain("STRANDED_TWO");
    expect(panel.el.textContent).toContain("STRANDED_THREE");

    const anaUnstored = await retireAna(false);
    const unstoredPanel = createRecoveryPanel({ room: anaUnstored, codec: tiny });
    openDisposables.push(unstoredPanel);
    unstoredPanel.open();
    const cardText = unstoredPanel.el.querySelector("[data-unstored-copy]")?.textContent ?? "";
    expect(cardText).toContain("3 edits could not be stored");
    expect(cardText).toContain("STRANDED_ONE");
    expect(cardText).toContain("STRANDED_TWO");
    expect(cardText).toContain("STRANDED_THREE");
  }, 15_000);

  // Bug it catches: recovery-panel crashed when an adopted dup frame had action: null, and leaked
  // raw internal IDs (r3/r1, s1/r2) in freeze conflicts and unsettleable deleteRows cards (X2 round 1 #7).
  test("handles null action without crashing and formats freeze and deleteRows labels without raw IDs", async () => {
    const Sap = (await import("../../../src/vendor/sap-core.vendor.js")).default;
    const gridPlugin = (await import("../../../src/vendor/sap-grid.vendor.js")).default;
    if (!Sap.grid) Sap.use(gridPlugin);
    const sheetCodec = Sap.grid.roomCodec;
    const initialDoc = {
      tabs: [
        {
          id: "s1",
          name: "Budget",
          pos: "b",
          sheet: {
            cols: [{ id: "c1", pos: "b" }, { id: "c2", pos: "c" }],
            rows: [
              { id: "r1", pos: "b", cells: [{ text: "Header" }, { text: "Amount" }] },
              { id: "r2", pos: "c", cells: [{ text: "Travel" }, { text: "500", n: true }] },
              { id: "r3", pos: "d", cells: [{ text: "Meals" }, { text: "120", n: true }] },
            ],
            rules: [],
          },
        },
      ],
    };
    const room1 = mockRoom(
      { unstored: 1 },
      {
        view: () => structuredClone(initialDoc),
        unstoredCopies: () => [{ id: "r1", about: { edits: [{ e: "c1:1", c: "c1", n: 1, out: "applied", action: null, saw: null }] }, body: "" }],
      },
    );
    const panel1 = createRecoveryPanel({ room: room1, codec: sheetCodec });
    openDisposables.push(panel1);
    expect(() => panel1.open()).not.toThrow();

    const freezeAction = { v: 1, t: "freeze", sheet: "s1", rowsThrough: "r3" };
    const sawFreeze = sheetCodec.seen(initialDoc, freezeAction);
    const deleteRowAction = { v: 1, t: "deleteRows", sheet: "s1", rows: ["r2"] };
    const peerDoc = structuredClone(initialDoc);
    sheetCodec.apply(peerDoc, { v: 1, t: "freeze", sheet: "s1", rowsThrough: "r1" });
    sheetCodec.apply(peerDoc, { v: 1, t: "deleteRows", sheet: "s1", rows: ["r2"] });
    const freezeConflicts = sheetCodec.conflicts(peerDoc, freezeAction, sawFreeze);

    const room2 = mockRoom(
      { copies: 1, conflicts: 1 },
      {
        view: () => structuredClone(peerDoc),
        copies: () => [
          {
            id: "r2",
            v: 4,
            edits: [
              { e: "c1:2", c: "c1", n: 2, out: "applied", action: freezeAction, saw: sawFreeze },
              { e: "c1:3", c: "c1", n: 3, out: "applied", action: deleteRowAction, saw: null },
            ],
            marks: [{ e: "c1:2", kind: "open" }, { e: "c1:3", kind: "misfit" }],
          },
        ],
        notices: () => [
          {
            kind: "restored",
            job: "t1#1",
            copy: "r2",
            conflicts: [{ e: "c1:2", cells: freezeConflicts }],
            applied: [],
            kept: [],
            misfit: ["c1:3"],
            saved: [],
            replaced: [],
            counted: [],
            refused: [],
            held: [],
            removed: [],
            left: [],
          },
        ],
      },
    );
    const panel2 = createRecoveryPanel({ room: room2, codec: sheetCodec });
    openDisposables.push(panel2);
    panel2.open();
    const text = panel2.el.textContent;
    expect(text).toContain("Row 1");
    expect(text).toContain("Row 2");
    expect(text).not.toContain("Delete rows · s1/r2");
  });
});
