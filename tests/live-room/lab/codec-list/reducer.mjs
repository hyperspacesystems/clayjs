// A second codec for the same core: an ordered list of items, each with named text fields.
// It has the small workbook codec's meaning (an edit conflicts per field, a cut that would take
// away fields its author did not see is told) under other names and shapes, so a core that runs
// the lab's proof with it reads the document only through the codec. Step P2b of C3.
import { planted } from "../core/planted.mjs";
import { clone, utf8Bytes } from "../core/lib.mjs";

const write1 = (item, field, value) => {
  if (value === "") delete item.fields[field];
  else item.fields[field] = value;
};

export function act(list, action) {
  if (action.t === "puts") {
    if (action.writes.some(([id]) => !list.items[id])) return false;
    for (const [id, field, text] of action.writes) write1(list.items[id], field, text);
    return true;
  }
  const item = list.items[action.id];
  if (action.t === "put") {
    if (!item) return false;
    if (planted("row-granularity")) item.fields = {};
    write1(item, action.field, action.text);
    return true;
  }
  if (action.t === "add") {
    if (item) return false;
    list.items[action.id] = { at: action.at, fields: Object.fromEntries(filled(action.fields)) };
    return true;
  }
  if (action.t === "cut") {
    if (!item) return false;
    delete list.items[action.id];
    return true;
  }
  throw new Error(`unknown action ${action.t}`);
}

export const writesOf = (action) => (action?.t === "puts" ? action.writes : action?.t === "put" ? [[action.id, action.field, action.text]] : []);

const shown = (list, id, field) => list.items[id]?.fields[field] ?? "";

const filled = (fields) => Object.entries(fields ?? {}).filter(([, value]) => value !== "" && value != null);

const keyOf = (id, field) => `${id}/${field}`;

const json = (value) => JSON.stringify(value ?? null);

function fits(list, action) {
  if (action.t === "add") return !list.items[action.id];
  return needs(action).every((id) => list.items[id]);
}

const needs = (action) => (action.t === "add" ? [] : action.t === "cut" ? [action.id] : [...new Set(writesOf(action).map(([id]) => id))]);

function inverse(list, action) {
  if (action.t === "puts") return { t: "puts", writes: action.writes.map(([id, field]) => [id, field, shown(list, id, field)]) };
  if (action.t === "put") return { t: "put", id: action.id, field: action.field, text: shown(list, action.id, action.field) };
  if (action.t === "add") return { t: "cut", id: action.id };
  return { t: "add", id: action.id, at: list.items[action.id].at, fields: { ...list.items[action.id].fields } };
}

function conflicts(list, action, saw) {
  if (action.t === "add") return [];
  if (action.t === "cut") {
    if (!saw) return [[action.id, null, "", ""]];
    const now = Object.fromEntries(filled(list.items[action.id]?.fields));
    return Object.keys(saw)
      .sort()
      .filter((field) => (now[field] ?? "") !== saw[field])
      .map((field) => [action.id, field, now[field] ?? "", ""]);
  }
  return writesOf(action).flatMap(([id, field, text], at) => (saw && shown(list, id, field) === saw[at] ? [] : [[id, field, shown(list, id, field), text]]));
}

const esc = (text) => (planted("no-escape") ? String(text) : String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"));

const unesc = (text) => text.replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");

const byAt = ([a, x], [b, y]) => (x.at < y.at ? -1 : x.at > y.at ? 1 : a < b ? -1 : a > b ? 1 : 0);

const span = ([field, text]) => `<span data-field="${esc(field)}">${esc(text)}</span>`;

const li = ([id, item]) => `<li data-key="${esc(id)}" data-at="${esc(item.at)}">${filled(item.fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(span).join("")}</li>`;

const write = (list, record) =>
  `<!doctype html><ol>${Object.entries(list.items).sort(byAt).map(li).join("")}</ol><script type="application/json" id="commit">${JSON.stringify(record).replaceAll("<", "\\u003c")}</script>`;

function read(body) {
  const record = JSON.parse(body.match(/<script type="application\/json" id="commit">(.*?)<\/script>/s)[1]);
  const items = {};
  for (const [, id, at, inner] of body.matchAll(/<li data-key="([^"]*)" data-at="([^"]*)">(.*?)<\/li>/gs)) {
    const fields = {};
    for (const [, field, text] of inner.matchAll(/<span data-field="([^"]*)">(.*?)<\/span>/gs)) fields[unesc(field)] = unesc(text);
    items[unesc(id)] = { at: unesc(at), fields };
  }
  return { record, doc: { items } };
}

const text = (value) => typeof value === "string";

function validate(action) {
  if (!action || typeof action !== "object") return false;
  if (action.t === "put") return text(action.id) && text(action.field) && text(action.text);
  if (action.t === "puts") return Array.isArray(action.writes) && action.writes.every((one) => Array.isArray(one) && one.length === 3 && one.every(text));
  if (action.t === "add") return text(action.id) && text(action.at) && Boolean(action.fields) && typeof action.fields === "object" && Object.values(action.fields).every(text);
  if (action.t === "cut") return text(action.id);
  return false;
}

export const codec = {
  name: "list",
  version: 1,
  read,
  write,
  docBytes: (list) => utf8Bytes(json(list)),
  validate,
  apply(list, action) {
    const undo = fits(list, action) ? inverse(list, action) : null;
    return act(list, action) ? { out: "applied", inverse: undo } : { out: "refused", inverse: null };
  },
  size: (action) => utf8Bytes(json(action)),
  ops: (action) => (action.t === "puts" ? Math.max(1, action.writes.length) : 1),
  split({ action, saw, reviewed }, limits) {
    const size = limits.opsPerFrame;
    const cut = (list, i) => list?.slice(i * size, (i + 1) * size);
    return {
      head: { action: { ...action, writes: [] }, saw: saw && [], reviewed: reviewed && [] },
      parts: Array.from({ length: Math.ceil(action.writes.length / size) }, (_, i) => ({ writes: cut(action.writes, i), saw: cut(saw, i), reviewed: cut(reviewed, i) })),
    };
  },
  assemble(head, parts) {
    const all = (field) => parts.flatMap((part) => part?.[field] ?? []);
    return { action: { ...head.action, writes: all("writes") }, saw: head.saw && all("saw"), reviewed: head.reviewed && all("reviewed") };
  },
  partOps: (part) => part.writes.length,
  targets: (action) => writesOf(action).map(([id, field]) => keyOf(id, field)),
  creates: (action) => (action.t === "add" ? [action.id] : []),
  needs,
  removes: (action) => (action.t === "cut" ? [action.id] : []),
  has: (list, id) => Boolean(list.items[id]),
  seen(list, action) {
    if (action.t === "add") return null;
    if (action.t === "cut") return Object.fromEntries(filled(list.items[action.id]?.fields));
    return writesOf(action).map(([id, field]) => shown(list, id, field));
  },
  fits,
  conflicts,
  unseen(list, action, saw) {
    if (action.t !== "cut" || !saw) return [];
    return filled(list.items[action.id]?.fields)
      .filter(([field]) => !(field in saw))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([field, text]) => [action.id, field, text]);
  },
  review(action, saw, cells) {
    if (action.t === "add" || !saw) return null;
    if (action.t === "cut") {
      const item = { ...saw };
      for (const [, field, now] of cells) {
        if (now === "") delete item[field];
        else item[field] = now;
      }
      return item;
    }
    const now = new Map(cells.map(([id, field, text]) => [keyOf(id, field), text]));
    return writesOf(action).map(([id, field], at) => now.get(keyOf(id, field)) ?? saw[at]);
  },
  holds(list, action) {
    if (action.t === "add") return Boolean(list.items[action.id]);
    const writes = writesOf(action);
    return writes.length > 0 && writes.every(([id, field, text]) => text !== "" && shown(list, id, field) === text);
  },
  describe: (action) => ({ title: { put: "Edit a field", puts: "Edit several fields", add: "Add an item", cut: "Remove an item" }[action.t], cells: writesOf(action).map(([id, field, text]) => ({ target: keyOf(id, field), label: `${id} ${field}`, stored: text })) }),
  current(list, target) {
    const at = target.indexOf("/");
    return shown(list, target.slice(0, at), target.slice(at + 1));
  },
  preview(list, actions) {
    const doc = clone(list);
    for (const action of actions) act(doc, action);
    return doc;
  },
};
