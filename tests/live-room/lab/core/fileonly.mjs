import { planted } from "./planted.mjs";
import { serialize, parse, page, parsePage, DOC, ledgerBytes } from "./record.mjs";
import { act } from "./codec.mjs";
import { resolved, trimLedger, ledgerMarks, W } from "./ledger.mjs";
import { COPY_VERSION, preview } from "./recover.mjs";
import { seenBy } from "./conflict.mjs";
import { clone } from "./lib.mjs";

export const nextCommit = (env) => `c${String(env.port.next("commits")).padStart(11, "0")}`;

export const nextGen = (env, epoch) => `${epoch}.${String(env.port.next("nonce")).padStart(8, "0")}`;

export function view(tab) {
  const wb = clone(tab.base.state.wb);
  for (const request of tab.pending) act(wb, request.action);
  return wb;
}

export function edit(env, tab, action) {
  const n = ++tab.n;
  const id = `${tab.client}:${n}`;
  const shown = view(tab);
  tab.pending.push({ n, id, action, saw: seenBy(shown, action) });
  tab.edits.set(id, { action, state: "pending" });
  env.observer.onEdit(env, tab, id, action, shown);
  return id;
}

function settle(env, tab, ids) {
  for (const id of ids) {
    const one = tab.edits.get(id);
    if (tab.judged.get(id) ?? true) {
      one.state = "saved";
    } else {
      one.state = "dropped";
      if (!planted("file-refuse-silent")) tab.notices.push({ kind: "refused", edits: [id], action: one.action });
    }
  }
  if (!planted("file-resend-saved")) tab.pending = tab.pending.filter((request) => !ids.includes(request.id));
}

function store(env, tab, draft) {
  const trusting = planted("file-copy-unconfirmed");
  env.port.keepRecovery({ id: draft.id, by: tab.id, body: draft.body });
  const back = env.port.fetchRecovery(draft.id);
  if (back !== draft.body && !trusting) return false;
  const ids = (trusting || planted("file-copy-table-only") ? draft.edits : parsePage(back).record.edits).map((entry) => entry.e);
  tab.notices.push({ kind: "recovery", copy: draft.id, edits: ids, refused: [] });
  for (const id of ids) tab.edits.get(id).state = "recovered";
  env.observer.onCopy(env, tab, draft.id, ids);
  return true;
}

function keepCopy(env, tab, file, requests) {
  const id = `r${env.port.next("copies")}`;
  const edits = requests.map((request) => ({ e: request.id, c: tab.client, n: request.n, b: tab.born, src: null, org: null, via: [], out: "unanswered", sent: request.sent, action: request.action, saw: request.saw }));
  const kept = planted("file-copy-table-only") ? [] : edits;
  const about = { v: COPY_VERSION, recovery: id, by: tab.id, from: tab.base.record.gen, reason: "retired", client: tab.client, born: tab.born, epoch: file.record.epoch, onto: file.record.commit, tag: file.etag, at: [file.record.gen, file.record.through], refused: [], edits: kept };
  env.observer.onCopyBuilt(env, tab, about);
  const draft = { id, edits, body: page(about, kept.length ? preview(file.state.wb, kept) : view(tab)) };
  tab.pending = tab.pending.filter((request) => !requests.includes(request));
  if (!store(env, tab, draft)) tab.unstored.push(draft);
}

function rekey(tab, epoch) {
  tab.client = `${tab.id}.${tab.clients.size}`;
  tab.clients.add(tab.client);
  tab.born = epoch;
  tab.n = 0;
  for (const request of tab.pending) request.n = ++tab.n;
}

function absorb(env, tab, file, pushed = false) {
  if (tab.born === null) tab.born = file.record.epoch;
  tab.high = Math.max(tab.high ?? -1, file.record.epoch);
  const sent = tab.unknown;
  tab.unknown = null;
  for (const request of tab.pending) if (sent?.ids.includes(request.id)) request.unsure = true;
  const retired = !tab.io && !(tab.client in file.state.seen) && tab.born <= file.state.floor;
  if (retired && pushed && !planted("file-push-retires")) return refresh(env, tab);
  const known = resolved(file.state, tab.client);
  const covered = tab.pending.filter((request) => request.n <= known).map((request) => request.id);
  const unsure = tab.pending.filter((request) => (planted("file-retired-resends") ? sent?.ids.includes(request.id) : request.unsure));
  if ((retired || (planted("file-copy-keeps-saved") && !tab.io)) && unsure.length) keepCopy(env, tab, file, unsure);
  else if (covered.length && !tab.io && !planted("file-unknown-resend") && (sent || !planted("file-settle-once"))) settle(env, tab, covered);
  if (retired) rekey(tab, file.record.epoch);
  tab.base = file;
  return true;
}

export function refresh(env, tab) {
  if (!tab.alive) return false;
  tab.unstored = tab.unstored.filter((draft) => !store(env, tab, draft));
  return absorb(env, tab, env.port.read());
}

export function push(env, tab, lost = false) {
  const pushed = env.port.takePush(tab);
  if (!pushed) return false;
  const { etag, body } = pushed;
  if (lost || !tab.alive || etag === tab.base.etag) return true;
  if (planted("file-push-skips-rebase")) tab.base = { ...tab.base, etag };
  else if (planted("file-push-skips-settle")) {
    tab.unknown = null;
    tab.base = { etag, ...parse(body) };
  } else absorb(env, tab, { etag, ...parse(body) }, true);
  return true;
}

export function save(env, tab) {
  if (!tab.alive || tab.io) return false;
  if (tab.unknown || tab.unstored.length) refresh(env, tab);
  if (!tab.pending.length || tab.unstored.length) return false;
  const { record, state, etag } = tab.base;
  const next = clone(state);
  const outcomes = new Map();
  for (const request of tab.pending) outcomes.set(request.id, act(next.wb, request.action));
  for (const [id, applied] of outcomes) tab.judged.set(id, applied);
  const upto = tab.pending.at(-1).n;
  let { gen, epoch } = record;
  delete next.seen[tab.client];
  next.seen[tab.client] = [upto, epoch];
  const cap = env.limits.ledgerCap;
  tab.high = Math.max(tab.high ?? -1, epoch);
  const back = epoch < tab.high && !planted("file-save-reuses-epoch");
  if (back || (ledgerBytes(next.seen) > ledgerMarks(cap).rotate && !planted("file-no-ledger-trim"))) {
    const folded = trimLedger(Object.entries(next.seen).filter(([client]) => client !== tab.client), next.floor, Math.max(0, cap - 60));
    epoch = (planted("file-save-reuses-epoch") ? record.epoch : tab.high) + 1;
    gen = nextGen(env, epoch);
    if (!planted("file-forgets-own-epoch")) tab.high = epoch;
    next.seen = { ...Object.fromEntries(folded.kept), [tab.client]: [upto, epoch] };
    next.floor = folded.floor;
    next.lineage = [[record.gen, record.through], ...state.lineage].slice(0, W);
  }
  const commit = nextCommit(env);
  const body = serialize({ v: 2, doc: record.doc ?? DOC, gen, epoch, commit, parent: record.commit, through: 0, room: null, mode: "file" }, next);
  const io = { client: tab.client, etag: planted("file-save-unconditional") ? "*" : etag, body, commit, upto, ids: tab.pending.map((request) => request.id), outcomes };
  for (const request of tab.pending) request.sent = [commit, outcomes.get(request.id)];
  env.observer.onSend(env, tab, io, tab.pending.map((request) => [request.id, request.n]));
  tab.io = io;
  env.port.send(tab, io);
  if (planted("file-ack-on-send")) for (const id of io.ids) tab.edits.get(id).state = "saved";
  return true;
}

function refused(env, tab, io) {
  env.observer.onRefused(env);
  if (planted("file-save-no-rebase")) {
    tab.io = { ...io, etag: env.port.etag() };
    env.port.send(tab, tab.io);
    return;
  }
  refresh(env, tab);
}

export function deliver(env, at = 0, lost = false) {
  const answered = env.port.takeAnswer(at);
  if (!answered) return false;
  const { tab, io, status, etag } = answered;
  if (tab.io === io) tab.io = null;
  if (!tab.alive) return true;
  if (lost || !status) {
    tab.unknown = io;
  } else if (status === 200) {
    settle(env, tab, io.ids);
    if (tab.base.etag === io.etag) tab.base = { etag, ...parse(io.body) };
  } else {
    refused(env, tab, io);
  }
  return true;
}

// The outside write step of a file-only host (rule 22): a version restore, an agent's write or an
// upload becomes a new file generation whose ledger folds the incoming file's and the current
// file's, so a save whose answer was lost before the write is never applied again on top of it.
// `source` and `current` are parsed files; answers the file to write.
export function outsideFold(env, source, current) {
  const merged = [];
  for (const client of new Set([...Object.keys(source.state.seen), ...Object.keys(current.state.seen)])) {
    const [low, lowAt] = source.state.seen[client] ?? [0, -1];
    const [high, highAt] = planted("file-outside-forgets-ledger") ? [0, -1] : current.state.seen[client] ?? [0, -1];
    const dropped = !(client in current.state.seen) && lowAt <= current.state.floor && !planted("file-fold-revives-retired");
    const stale = !(client in source.state.seen) && highAt <= source.state.floor && !planted("file-fold-keeps-stale");
    if (Math.max(low, high) > 0 && !dropped && !stale) merged.push([client, [Math.max(low, high), Math.max(lowAt, highAt)]]);
  }
  const folded = trimLedger(merged, Math.max(source.state.floor, current.state.floor), env.limits.ledgerCap);
  const epoch = Math.max(current.record.epoch, folded.floor) + 1;
  const state = { wb: source.state.wb, seen: Object.fromEntries(folded.kept), lineage: [], cut: [current.record.gen, current.record.through, {}], floor: folded.floor };
  const record = { v: 2, doc: current.record.doc ?? DOC, gen: nextGen(env, epoch), epoch, commit: nextCommit(env), parent: current.record.commit, through: 0, room: null, mode: "file", restored: source.record.commit };
  return { record, body: serialize(record, state) };
}
