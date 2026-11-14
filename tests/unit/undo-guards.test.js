/**
 * @jest-environment jsdom
 */

/**
 * The guarded replay as the page sees it.
 *
 * ClayJS asks the engine for a whole-entry replay, so the plugin's own state has
 * to follow the engine's answer:
 *
 *   - a step the engine can no longer replay is announced as one
 *     `clay:undo-skipped` event, leaves the history and the press goes on to the
 *     next older step; an explicit `entryId` still refuses as one
 *     `clay:undo-refused` event;
 *   - persist controls take their attributes back only after a successful
 *     replay, never after a skip or a refusal;
 *   - ClayJS's derived, tab-local and route state is not page content, so a
 *     change to it cannot make the recorded edit unsafe.
 */

const FIXTURE = `
  <article id="card" data-id="card" sap>
    <span id="count" attr:count="1">1</span>
    <p id="text">authored</p>
  </article>
  <input id="field" type="text" persist value="attr">
`;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = () => document.getElementById("text");
const count = () => document.getElementById("count");
const card = () => document.getElementById("card");
const field = () => document.getElementById("field");

let plugin;
let undo;
const leases = [];
const refusals = [];
const skips = [];

const onRefused = (event) => refusals.push(event.detail);
const onSkipped = (event) => skips.push(event.detail);

const enter = async () => {
  const lease = await plugin.undoParticipant().prepare({ generation: 1, isCurrent: () => true });
  lease.enable();
  leases.push(lease);
  return lease;
};

// Keep the recorded target the same node: a text-node data write is one scalar
// edit, where assigning textContent replaces the node.
const setText = (el, value) => {
  if (el.firstChild && el.firstChild.nodeType === 3) el.firstChild.data = value;
  else el.textContent = value;
};

const edit = async (value) => {
  setText(text(), value);
  await settle();
  undo.flush();
};

const peerWrite = (write) => {
  undo.pause();
  try { write(); } finally { undo.resume() }
};

beforeAll(async () => {
  plugin = await import("../../src/plugins/undo.js");
  undo = plugin.undo;
});

beforeEach(() => {
  refusals.length = 0;
  skips.length = 0;
  // A new page starts in the default mode; a mode a case picked is that page's own.
  undo.setRecording("automatic");
  window.clay = {};
  document.documentElement.removeAttribute("route-tab");
  document.body.innerHTML = FIXTURE;
  document.addEventListener("clay:undo-refused", onRefused);
  document.addEventListener("clay:undo-skipped", onSkipped);
});

afterEach(() => {
  document.removeEventListener("clay:undo-refused", onRefused);
  document.removeEventListener("clay:undo-skipped", onSkipped);
  while (leases.length) leases.pop().dispose();
  window.clay = undefined;
});

test("a derived, tab-local or route attribute change after an edit does not refuse its undo", async () => {
  await enter();
  await edit("typed");

  count().setAttribute("count", "2");
  card().setAttribute("route-active", "");
  document.documentElement.setAttribute("route-tab", "b");
  await settle();
  undo.flush();

  expect(undo.history).toHaveLength(1);
  const receipt = undo.undo();
  expect(receipt).toEqual({ ok: true, entryId: expect.any(String), label: "Edit", direction: "undo", caret: { node: expect.anything(), offset: expect.any(Number) } });
  expect(refusals).toHaveLength(0);
  expect(text().textContent).toBe("authored");
});

test("a peer's change to the edited text skips the undo, announced once", async () => {
  await enter();
  await edit("typed");
  const { id } = undo.history[0];
  peerWrite(() => setText(text(), "peer"));
  await settle();
  undo.flush();

  const receipt = undo.undo();

  expect(receipt).toMatchObject({ ok: false, code: "empty", direction: "undo" });
  expect(receipt.skipped).toEqual([
    expect.objectContaining({ entryId: id, label: "Edit", direction: "undo", code: "content-changed" }),
  ]);
  expect(skips).toEqual([{ entryId: id, label: "Edit", direction: "undo", code: "content-changed" }]);
  expect(refusals).toHaveLength(0);
  expect(text().textContent).toBe("peer");
  expect(undo.history).toHaveLength(0);
  expect(undo.canUndo).toBe(false);
  expect(undo.canRedo).toBe(false);
});

test("a skipped redo is announced once, leaves the page as it was and the entry gone", async () => {
  await enter();
  await edit("typed");
  const { id } = undo.history[0];
  expect(undo.undo().ok).toBe(true);
  expect(text().textContent).toBe("authored");

  peerWrite(() => setText(text(), "peer redo"));
  await settle();
  undo.flush();

  const receipt = undo.redo();

  expect(receipt).toMatchObject({ ok: false, code: "empty", direction: "redo" });
  expect(receipt.skipped).toEqual([
    expect.objectContaining({ entryId: id, label: "Edit", direction: "redo", code: "content-changed" }),
  ]);
  expect(skips).toEqual([{ entryId: id, label: "Edit", direction: "redo", code: "content-changed" }]);
  expect(refusals).toHaveLength(0);
  expect(text().textContent).toBe("peer redo");
  expect(undo.canRedo).toBe(false);
  expect(undo.canUndo).toBe(false);
});

test("persist controls are not restored after a skip and are after a success", async () => {
  await enter();
  await edit("typed");
  field().value = "live";

  peerWrite(() => setText(text(), "peer"));
  await settle();
  undo.flush();
  expect(undo.undo()).toMatchObject({ ok: false, code: "empty" });
  expect(skips).toHaveLength(1);
  expect(refusals).toHaveLength(0);
  expect(field().value).toBe("live");

  await edit("typed again");
  expect(undo.undo()).toMatchObject({ ok: true, direction: "undo" });
  expect(text().textContent).toBe("peer");
  expect(field().value).toBe("attr");
});

describe("removed subtrees", () => {
  test("a deleted card inside an app redoes after its painted attribute is repainted", async () => {
    document.body.insertAdjacentHTML("beforeend", '<main id="app" sap><ul id="lists"><li id="gone" attr:data-count="n" data-count="2">List<b attr:data-count="n" data-count="1">Card</b></li></ul></main>');
    await enter();
    undo.setRecording("commands");
    const list = document.getElementById("gone");

    undo.command("Delete list", () => list.remove());
    expect(undo.undo()).toMatchObject({ ok: true, direction: "undo" });
    // The app repaints the restored list, as sapjs does after a merge or a refresh.
    list.setAttribute("data-count", "3");

    expect(undo.redo()).toMatchObject({ ok: true, direction: "redo" });
    expect(document.getElementById("gone")).toBeNull();
    expect(refusals).toHaveLength(0);
    document.getElementById("app").remove();
  });

  test("an attribute the page keeps outside history, repaired on a restored card, does not refuse its redo", async () => {
    document.body.insertAdjacentHTML("beforeend", '<main id="board"><ol><li id="num-card" data-num="4">Card</li></ol></main>');
    await enter();
    undo.setRecording("commands");
    const off = undo.ignoreAttribute("data-num");
    const card = document.getElementById("num-card");

    undo.command("Delete card", () => card.remove());
    expect(undo.undo()).toMatchObject({ ok: true, direction: "undo" });
    // A numbering repair outside history gives the restored card a new number.
    card.setAttribute("data-num", "7");

    expect(undo.redo()).toMatchObject({ ok: true, direction: "redo" });
    expect(document.getElementById("num-card")).toBeNull();
    expect(refusals).toHaveLength(0);
    off();
    document.getElementById("board").remove();
  });
});

describe("added subtrees", () => {
  let resolveRegionPolicy;
  beforeAll(async () => {
    ({ resolveRegionPolicy } = await import("../../src/lib/region-policy.js"));
  });

  const addCard = async (inner) => {
    const added = document.createElement("article");
    added.id = "added";
    added.setAttribute("sap", "");
    added.innerHTML = inner;
    document.body.appendChild(added);
    await settle();
    undo.flush();
    return added;
  };

  test("a derived attribute changed on an added card does not refuse undoing the add", async () => {
    await enter();
    await addCard('<span id="n" attr:count="1">1</span>');

    document.getElementById("n").setAttribute("count", "2");
    await settle();
    undo.flush();

    expect(undo.undo()).toMatchObject({ ok: true, direction: "undo" });
    expect(document.getElementById("added")).toBeNull();
    expect(refusals).toHaveLength(0);
  });

  test("saved content with its own history inside an added card skips undoing the add", async () => {
    window.clay = { region: { resolveRegionPolicy } };
    await enter();
    await addCard('<div id="own" clay="no-undo"><p>kept</p></div>');

    const { id } = undo.history.at(-1);
    const kept = new Promise((resolve) => document.addEventListener("clay:undo-kept", resolve, { once: true }));
    const receipt = undo.undo();

    expect(receipt).toMatchObject({ ok: false, code: "empty", direction: "undo" });
    expect(skips).toEqual([{ entryId: id, label: expect.any(String), direction: "undo", code: "protected" }]);
    expect(refusals).toHaveLength(0);
    expect(document.getElementById("own").textContent).toBe("kept");
    expect(undo.history).toHaveLength(0);
    // The recovery copy is made behind the receipt, so a case that ends on a skip
    // waits for the announcement or the page is gone while it is still in flight.
    await kept;
  });

  test("editor chrome inside an added card is not protected", async () => {
    window.clay = { region: { resolveRegionPolicy } };
    await enter();
    await addCard('<div clay="editor-ui">chrome</div><p>body</p>');

    expect(undo.undo()).toMatchObject({ ok: true });
    expect(document.getElementById("added")).toBeNull();
  });
});

describe("clay:undo-change", () => {
  const changes = [];
  const onChange = (event) => changes.push(event.detail);
  const summary = (detail) => ({
    canUndo: detail.canUndo,
    canRedo: detail.canRedo,
    undo: detail.undo?.label ?? null,
    redo: detail.redo?.label ?? null,
    refused: detail.redo?.refused?.code ?? detail.undo?.refused?.code ?? null,
  });

  beforeEach(() => {
    changes.length = 0;
    document.addEventListener("clay:undo-change", onChange);
  });
  afterEach(() => document.removeEventListener("clay:undo-change", onChange));

  test("names the entries the next Undo and Redo would replay, through a skip", async () => {
    await enter();
    undo.setRecording("commands");
    expect(summary(changes.at(-1))).toEqual({ canUndo: false, canRedo: false, undo: null, redo: null, refused: null });

    undo.command("Rename", () => setText(text(), "renamed"));
    expect(summary(changes.at(-1))).toMatchObject({ canUndo: true, undo: "Rename" });

    undo.undo();
    expect(summary(changes.at(-1))).toEqual({ canUndo: false, canRedo: true, undo: null, redo: "Rename", refused: null });

    const { id } = undo.future[0];
    peerWrite(() => setText(text(), "peer"));
    const skipped = undo.redo();
    expect(skipped).toMatchObject({ ok: false, code: "empty", direction: "redo" });
    expect(skips).toEqual([{ entryId: id, label: "Rename", direction: "redo", code: "content-changed" }]);
    // The skipped entry leaves the stack, so no dismissal is needed to stop offering it,
    // and the press announces that Redo has nothing left.
    expect(undo.canRedo).toBe(false);
    expect(summary(changes.at(-1))).toEqual({ canUndo: false, canRedo: false, undo: null, redo: null, refused: null });
    expect(text().textContent).toBe("peer");

    undo.command("Note", () => setText(text(), "noted"));
    expect(summary(changes.at(-1))).toEqual({ canUndo: true, canRedo: false, undo: "Note", redo: null, refused: null });
    expect(text().textContent).toBe("noted");

    leases.pop().dispose();
    expect(summary(changes.at(-1))).toEqual({ canUndo: false, canRedo: false, undo: null, redo: null, refused: null });
  });
});

test("an explicit undo({ entryId }) on a stale entry still refuses and is announced once", async () => {
  await enter();
  await edit("typed");
  await edit("typed again");
  const [older] = undo.history;

  const receipt = undo.undo({ entryId: older.id });

  expect(receipt).toEqual({
    ok: false,
    code: "stale-entry",
    entryId: older.id,
    label: "Edit",
    direction: "undo",
  });
  expect(refusals).toEqual([{
    ok: false,
    code: "stale-entry",
    entryId: older.id,
    label: "Edit",
    direction: "undo",
  }]);
  expect(skips).toHaveLength(0);
  expect(text().textContent).toBe("typed again");
  expect(undo.history).toHaveLength(2);
  expect(undo.canUndo).toBe(true);
});
