import { planted } from "./planted.mjs";
import { applyFrame, resolved, covered, nextGeneration, ledgerMarks } from "./ledger.mjs";
import { act } from "./codec.mjs";
import { newRoom, newInstance, admit, retained, originOf } from "./room.mjs";
import { serialize, DOC, page, parsePage, ledgerBytes } from "./record.mjs";
import { clone } from "./lib.mjs";
import { opsOf, actionBytes } from "./limits.mjs";
import { explode } from "./frames.mjs";
import { COPY_VERSION, CLOSING, inFile, positions, preview, taken, weigh, markFor, madeFor } from "./recover.mjs";
import { seenBy, reviewed, unseenBy, holds, rowsOf, marksOf, createsOf, removesOf, has } from "./conflict.mjs";
import { codec } from "./codec.mjs";

export function newTab(id) {
  return {
    id,
    name: `user ${id}`,
    client: id,
    born: null,
    clients: new Set([id]),
    alive: true,
    connected: true,
    n: 0,
    room: null,
    gen: null,
    epoch: 0,
    base: null,
    state: null,
    a: 0,
    cursor: 0,
    inbox: new Map(),
    parts: new Map(),
    tail: [],
    held: [],
    inserts: {},
    pending: [],
    out: [],
    flight: new Set(),
    io: null,
    wake: false,
    fetched: null,
    refused: null,
    touched: 0,
    unknown: null,
    limbo: [],
    unstored: [],
    throttled: false,
    edits: new Map(),
    notices: [],
    marks: [],
    removals: [],
    recordSeen: 0,
    job: null,
    jobs: 0,
  };
}

export const editId = (client, n) => `${client}:${n}`;
export const frameId = (frame) => frame.e;
export const attached = (env, tab) => Boolean(tab.room) && tab.room === env.port.room();
export const nextCommit = (env) => `c${String(env.port.next("commits")).padStart(11, "0")}`;
export const nextGen = (env, epoch) => `${epoch}.${String(env.port.next("nonce")).padStart(8, "0")}`;

const fits = (wb, action) => rowsOf(action).every((row) => removesOf(action).includes(row) || has(wb, row));

const met = (wb, action) => (removesOf(action).length > 0 && !planted("taken-delete-labelled-by-its-cells") ? removesOf(action).every((row) => !has(wb, row)) || planted("taken-delete-saved-while-its-row-stands") : holds(wb, action));

const unsavedFor = (tab, action) => tab.tail.some((frame) => !frame.noop && (removesOf(action).length > 0 ? removesOf(frame.action).some((row) => removesOf(action).includes(row)) : marksOf(frame.action).some((key) => marksOf(action).includes(key))));

const takeMet = (tab, basis, action) => met(basis.file.state.wb, action) && (basis.saved || planted("given-up-take-settled-by-an-unsaved-value") || !unsavedFor(tab, action));

const inLineage = (state, frame) => frame.k === "adopt" && (covered(state, frame.from[0])?.[1] ?? -1) >= frame.from[1];

function settledElsewhere(tab) {
  const settled = new Set();
  for (const held of tab.held) {
    const here = new Set();
    for (const frame of held.frames) {
      const id = frameId(frame);
      if (frame.dup && !here.has(id)) settled.add(id);
      here.add(id);
    }
  }
  return settled;
}

function admitted(tab, unplaced) {
  const state = clone(tab.state);
  const done = new Set();
  const settled = settledElsewhere(tab);
  for (const held of tab.held) {
    for (const frame of held.frames) {
      const id = frameId(frame);
      if (frame.noop || done.has(id)) continue;
      done.add(id);
      if (resolved(tab.state, frame.c) >= frame.n || inLineage(state, frame) || settled.has(id)) continue;
      if (!act(state.wb, frame.action)) unplaced?.add(id);
      state.seen[frame.c] = [Math.max(resolved(state, frame.c), frame.n), 0];
    }
  }
  return state;
}

function draft(tab, state, unplaced) {
  const known = resolved(state, tab.client);
  for (const request of tab.pending) if (request.n > known && !act(state.wb, request.action)) unplaced?.add(request.id);
  return state.wb;
}

export const view = (tab) => draft(tab, admitted(tab));

export function snapshot(tab) {
  const unplaced = new Set();
  const state = admitted(tab, unplaced);
  const shared = clone(state.wb);
  return { shared, draft: draft(tab, state, unplaced), unplaced };
}

export function edit(env, tab, action, shown = view(tab)) {
  tab.touched++;
  const bytes = actionBytes(action);
  if (bytes > env.limits.actionBytes && !planted("no-action-cap")) {
    tab.notices.push({ kind: "too-large", bytes, edits: [] });
    return null;
  }
  const n = ++tab.n;
  const id = editId(tab.client, n);
  const saw = seenBy(planted("saw-from-shared") && tab.state ? tab.state.wb : shown, action);
  tab.pending.push({ n, id, action, saw, queued: false, sent: false });
  tab.edits.set(id, { c: tab.client, n, action, saw, state: "pending" });
  flush(env, tab);
  return id;
}

export function flush(env, tab) {
  if (!tab.alive || !tab.connected || !attached(env, tab)) return;
  if (tab.held.some((held) => !held.offered) && !writeMarks(env, tab)) return;
  for (const held of tab.held) {
    if (held.offered) continue;
    const entry = covered(tab.state, held.gen);
    const items = entry ? held.frames.filter((frame) => frame.seq > entry[1]) : [];
    const offer = (pack) => tab.out.push(...explode({ k: "adopt", gen: tab.gen, from: held.gen, items: pack }, `a:${held.gen}:${pack[0].n}`, env.limits));
    let pack = [];
    let ops = 0;
    for (const frame of items) {
      const item = { n: frame.seq, c: planted("copy-wrong-client") ? `wrong-${frame.c}` : frame.c, rn: frame.n, org: frame.org ?? [held.gen, frame.seq], via: frame.via, e: frame.e, action: frame.dup ? null : frame.action, saw: frame.dup ? null : frame.saw };
      if (frame.keep && !frame.dup && !planted("adopt-drops-keep")) item.keep = true;
      const origin = frame.dup || planted("returned-frame-loses-its-origin") ? null : originOf(frame);
      if (origin) {
        const known = env.port.verdict(origin[1])?.kind;
        Object.assign(item, { origin }, frame.reviewed && { reviewed: frame.reviewed }, frame.open && { open: true }, known && known !== "refused" && { listed: true });
      }
      const need = opsOf(item.action);
      if (pack.length && ops + need > env.limits.opsPerFrame) {
        offer(pack);
        pack = [];
        ops = 0;
      }
      pack.push(item);
      ops += need;
    }
    if (pack.length) offer(pack);
    held.offered = true;
  }
  if (tab.held.length && !planted("natives-before-adopt")) return;
  let before = resolved(tab.state, tab.client);
  for (const request of tab.pending) {
    if (request.n <= before) continue;
    if (planted("skips-an-open-request") && request === tab.pending[0] && tab.pending.length > 1) continue;
    if (!request.queued) {
      const frame = { k: "req", gen: tab.gen, c: tab.client, n: request.n, p: before, b: tab.born, e: request.id, action: request.action, saw: request.saw };
      if (request.take) frame.take = request.take;
      env.observer.onWire(env, tab, frame);
      tab.out.push(...explode(frame, `q:${tab.client}:${request.n}`, env.limits));
      request.queued = true;
      request.sent = true;
      tab.edits.get(request.id).tried = true;
    }
    before = request.n;
  }
  offerStored(env, tab);
}

function writeMarks(env, tab) {
  tab.marks = tab.marks.filter((mark) => {
    env.port.keepDecision(mark);
    if (!env.port.fetchDecision(mark)) return true;
    env.observer.onMark(env, tab, mark);
    return false;
  });
  return !tab.marks.length;
}

function take(env, tab, job, entry) {
  tab.touched++;
  const n = ++tab.n;
  const id = editId(tab.client, n);
  const saw = job.choices.get(entry.e).reviewed;
  tab.pending.push({ n, id, action: entry.action, saw, take: [job.copy, job.at, entry.e], queued: false, sent: false });
  tab.edits.set(id, { c: tab.client, n, action: entry.action, saw, state: "pending", take: entry.e });
  env.observer.onTake(env, tab, id, job.id, entry.e, saw);
  return id;
}

function settleTakes(tab, job) {
  while (job.at < job.edits.length && job.took.has(job.edits[job.at].e)) {
    const { e } = job.edits[job.at];
    const id = job.took.get(e);
    const one = tab.edits.get(id);
    const here = one.gen === tab.gen;
    if (one.state === "pending" || (one.state === "shared" && !here)) return false;
    const held = one.state === "shared" || (one.state === "saved" && (here || (covered(tab.state, one.gen)?.[1] ?? -1) >= one.seq));
    if (!held) {
      job.took.delete(e);
      job.choices.delete(e);
      return true;
    }
    job.answers[job.at++] = { how: "applied", late: true, took: id, removed: one.removed };
    if (here) job.need = Math.max(job.need, one.seq);
  }
  return true;
}

function offerStored(env, tab) {
  const job = tab.job;
  if (!job || job.queued) return;
  if (job.gen !== tab.gen && !(planted("restore-job-forgets") && job.gen)) Object.assign(job, { gen: tab.gen, at: 0, answers: [], need: tab.a });
  if (!writeMarks(env, tab) || !settleTakes(tab, job)) return;
  if (job.at >= job.edits.length) return finishJob(env, tab);
  const entry = job.edits[job.at];
  const frame = { k: "copy", gen: tab.gen, job: job.id, copy: job.copy, i: job.at, p: entry.n - 1, ...entry, made: madeFor(job.made, entry.action), ...job.choices.get(entry.e) };
  const known = env.port.verdict(entry.e)?.kind;
  if (known === "open" && !planted("restore-ignores-record")) frame.open = true;
  else if (known || (planted("edit-listed-by-another-mark-of-its-copy") && env.port.decisions().some((mark) => mark.copy === job.copy))) frame.listed = true;
  if (planted("room-restore-trusts-the-tab")) frame.judged = weigh({ record: { gen: tab.gen, through: tab.a, epoch: tab.epoch }, state: tab.state }, frame);
  env.observer.onOffer(env, tab, frame);
  tab.out.push(...explode(frame, offerKey(job.id, job.at, frame.decide), env.limits));
  job.queued = true;
}

const offerKey = (job, i, decide) => `c:${job}:${i}:${decide ?? ""}`;

function storedAnswer(env, tab, frame, result) {
  const job = tab.job;
  if (!job || !job.queued || typeof result === "string") return;
  const entry = job.edits[job.at];
  const choice = planted("restore-answer-of-an-old-choice") ? frame.decide : job.choices.get(entry.e)?.decide;
  if ((frame.k === "part" ? frame.key : offerKey(frame.job, frame.i, frame.decide)) !== offerKey(job.id, job.at, choice) && !planted("restore-answer-of-another-job")) return;
  job.queued = false;
  if (result.how === "unlisted") {
    if (!env.port.verdict(entry.e) && !tab.marks.some((mark) => mark.e === entry.e)) tab.marks.push({ copy: job.copy, e: entry.e, kind: "open" });
    return flush(env, tab);
  }
  if (result.how === "take") {
    job.took.set(entry.e, take(env, tab, job, entry));
    return flush(env, tab);
  }
  const kind = markFor(result, env.port.verdict(entry.e)?.kind);
  const passing = (kind === "open" || kind === "refused") && !env.port.marked(entry.e, kind);
  if (passing && !planted("pass-without-record")) tab.marks.push({ copy: job.copy, e: entry.e, kind });
  job.answers[job.at++] = result;
  job.need = Math.max(job.need, result.seq ?? 0);
  flush(env, tab);
}

function finishJob(env, tab) {
  const job = tab.job;
  if (!job || job.queued || job.at < job.edits.length || (job.gen !== tab.gen && !planted("restore-job-forgets"))) return;
  if (tab.base.through < job.need && !planted("restore-notice-before-save")) return;
  const listed = (test) => job.edits.filter((_, i) => test(job.answers[i])).map((entry) => entry.e);
  const told = (how) => listed((answer) => answer.how === how);
  const shown = (cells) => (planted("notice-wrong-current-value") ? cells.map(([row, col, , value]) => [row, col, "not the current value", value]) : cells);
  const conflicts = job.edits.flatMap((entry, i) => (job.answers[i].how === "conflict" ? [{ e: entry.e, cells: shown(job.answers[i].cells) }] : []));
  const quiet = (answer) => answer.how === "held" && Boolean(answer.row) && !planted("waiting-edit-shown");
  const held = job.edits.flatMap((entry, i) => (job.answers[i].how !== "held" || quiet(job.answers[i]) ? [] : job.answers[i].row ? [{ e: entry.e, behind: null, row: job.answers[i].row }] : [{ e: entry.e, behind: job.answers[i].behind }]));
  const removed = job.edits.flatMap((entry, i) => (job.answers[i].removed?.length ? [{ e: entry.e, cells: job.answers[i].removed }] : []));
  const inFile = (answer) => answer.how === "saved" || answer.how === "resolved";
  const inSheet = (answer) => inFile(answer) && (answer.shown || planted("notice-counted-as-saved"));
  const notice = {
    kind: "restored",
    job: job.id,
    copy: job.copy,
    edits: [],
    decided: job.decided,
    applied: told("applied"),
    kept: told("kept"),
    misfit: told("misfit"),
    conflicts,
    saved: listed(inSheet),
    replaced: told("replaced"),
    counted: listed((answer) => inFile(answer) && !inSheet(answer)),
    refused: told("refused"),
    held,
    removed,
    left: listed((answer) => answer.how === "unjudged" || quiet(answer)),
  };
  for (const [i, entry] of job.edits.entries()) {
    const answer = job.answers[i];
    const known = env.port.verdict(entry.e)?.kind;
    const declined = known === "open" && job.choices.get(entry.e)?.decide === "keep" && answer.how === "resolved" && !answer.shown;
    const kind = answer.took ? "taken" : declined ? "kept" : markFor(answer, known);
    if (CLOSING.includes(kind) && !env.port.marked(entry.e, kind)) tab.marks.push({ copy: job.copy, e: entry.e, kind });
  }
  tab.notices.push(notice);
  tab.job = null;
  env.observer.onRestored(env, tab, notice);
  writeMarks(env, tab);
}

function startJob(env, tab, copyId, copy, choices = new Map()) {
  tab.job = { id: `${tab.id}#${++tab.jobs}`, copy: copyId, made: copy.made, edits: copy.edits, choices, took: new Map(), decided: [...choices].map(([e, choice]) => [e, choice.decide]), gen: null, at: 0, answers: [], need: 0, queued: false };
  env.observer.onRestoreStart(env, tab, tab.job.id, copyId);
  return tab.job;
}

export function restoreCopy(env, tab, copyId) {
  if (!tab.alive || tab.job) return false;
  const copy = env.port.readRecovery(copyId);
  if (!copy) return false;
  startJob(env, tab, copyId, copy);
  flush(env, tab);
  return true;
}

export function decide(env, tab, jobId, picks) {
  if (!tab.alive || tab.job || !picks.length) return false;
  const notice = tab.notices.find((one) => one.kind === "restored" && one.job === jobId);
  const copy = notice && env.port.readRecovery(notice.copy);
  if (!copy) return false;
  const choices = new Map();
  for (const [e, how] of picks) {
    const shown = notice.conflicts.find((one) => one.e === e);
    const entry = copy.edits.find((one) => one.e === e);
    if (!shown || !entry || choices.has(e)) return false;
    choices.set(e, how === "take" ? { decide: "take", reviewed: reviewed(entry.action, entry.saw, shown.cells) } : { decide: "keep" });
  }
  const job = startJob(env, tab, notice.copy, copy, choices);
  env.observer.onDecide(env, tab, job.id, jobId, picks);
  flush(env, tab);
  return true;
}

function resend(env, tab) {
  const receipts = [...tab.flight].filter((frame) => frame.k === "receipt" && frame.gen === tab.gen);
  tab.flight.clear();
  for (const request of tab.pending) request.queued = false;
  for (const held of tab.held) held.offered = false;
  if (tab.job) tab.job.queued = false;
  flush(env, tab);
  if (!planted("wire-receipt-not-resent")) tab.out.push(...receipts);
}

const fileBasis = (file) => ({ file, onto: file.record.commit, saved: true });

const stateBasis = (tab) => ({ file: { record: { gen: tab.gen, through: tab.a, epoch: tab.epoch }, state: tab.state }, onto: tab.base.commit, saved: false });

const kept = (action) => (planted("copy-trims-paste") && action.t === "paste" ? { ...action, cells: action.cells.slice(0, 1) } : action);

const heldEntry = (gen, frame) => ({ e: frame.e, c: planted("copy-wrong-client") ? `wrong-${frame.c}` : frame.c, n: frame.n, b: frame.b ?? null, src: [gen, frame.seq], org: frame.org ?? [gen, frame.seq], via: frame.via ?? [], out: frame.noop && !planted("copy-outcome-applied") ? "refused" : "applied", action: kept(frame.action), saw: frame.saw ?? null });

function ownEntry(tab, id, out, src = null) {
  const one = tab.edits.get(id);
  return { e: id, c: one.c, n: one.n, b: planted("copy-born-now") ? tab.epoch : tab.born, src, org: src, via: [], out: out ?? (one.tried ? "unanswered" : "unsent"), action: kept(one.action), saw: one.saw ?? null };
}

function inOrder(entries) {
  const groups = [];
  for (const entry of entries) {
    if (groups.at(-1)?.[0].src[0] === entry.src[0]) groups.at(-1).push(entry);
    else groups.push([entry]);
  }
  const first = new Map();
  for (const entry of planted("copy-holder-order") ? entries : groups.reverse().flat()) {
    const newer = first.get(entry.e);
    first.set(entry.e, newer ? { ...newer, org: entry.org, via: positions({ via: [...positions(entry), ...newer.via], src: null }) } : entry);
  }
  return [...first.values()];
}

const newCopy = (env, from, reason) => ({ id: `r${env.port.next("copies")}`, from, reason });

const afloat = (one) => one.state === "pending" || one.state === "shared";

const inCopy = (one) => one.state === "recovered" || one.state === "kept-refused";

function store(env, tab, draft) {
  const sent = planted("recovery-empty-bytes") ? page({ ...draft.about, edits: [] }, { rows: {} }) : draft.body;
  env.observer.onCopyWrite(env, tab, draft.id);
  if (!planted("recovery-no-bytes")) env.port.keepRecovery({ id: draft.id, by: tab.id, body: sent });
  const back = env.port.fetchRecovery(draft.id);
  const trusting = planted("recovery-no-bytes") || planted("recovery-empty-bytes") || planted("recovery-unconfirmed");
  if (back !== sent && !trusting) return false;
  const own = draft.listed ?? (trusting ? draft.about.edits : null);
  const stored = new Map((own ?? parsePage(back).record.edits).map((entry) => [entry.e, entry]));
  const ids = draft.fresh.filter((id) => stored.has(id));
  const learned = (id) => tab.edits.get(id)?.state === "kept-refused" && !planted("store-forgets-a-refusal");
  const refused = planted("notice-refused-as-recovered") ? [] : ids.filter((id) => !taken(stored.get(id)) || learned(id));
  tab.notices.push({ kind: "recovery", copy: draft.id, reason: draft.about.reason, edits: ids, refused });
  for (const id of ids) {
    const one = tab.edits.get(id);
    if (one && (afloat(one) || (inCopy(one) && !planted("restored-refusal-stays-recovered")))) Object.assign(one, { state: refused.includes(id) ? "kept-refused" : "recovered", copy: draft.id });
  }
  env.observer.onRecoveryCopy(env, tab, draft.id, ids, refused);
  return true;
}

function madeRows(tab, edits) {
  if (planted("copy-forgets-unsaved-inserts")) return null;
  const rows = [...new Set(edits.flatMap((entry) => rowsOf(entry.action)))].filter((row) => tab.inserts[row]);
  return rows.length ? Object.fromEntries(rows.map((row) => [row, tab.inserts[row]])) : null;
}

function writeCopy(env, tab, copy, basis, entries) {
  const { record, state } = basis.file;
  const edits = planted("copy-shared-only") ? entries.filter((entry) => entry.src) : planted("copy-draft-only") ? entries.filter((entry) => !entry.src) : entries.slice();
  const names = Object.fromEntries([...new Set(edits.map((entry) => entry.c))].map((client) => [client, env.port.tabs().find((one) => one.clients.has(client))?.name ?? null]));
  const made = madeRows(tab, edits);
  const about = { v: COPY_VERSION, recovery: copy.id, by: tab.id, names, from: copy.from, reason: copy.reason, client: tab.retired?.client, born: tab.retired?.born, epoch: record.epoch, onto: basis.onto, at: [record.gen, record.through], ...(made ? { made } : {}), refused: planted("notice-refused-as-recovered") ? [] : edits.filter((entry) => !taken(entry)).map((entry) => entry.e), edits };
  env.observer.onCopyBuilt(env, tab, about);
  tab.unstored = tab.unstored.filter((draft) => draft.id !== copy.id);
  const listed = planted("copy-shared-only") || planted("copy-draft-only") ? entries : null;
  const draft = { id: copy.id, about, body: page(about, planted("copy-preview-stale") ? state.wb : preview(state.wb, edits)), fresh: entries.map((entry) => entry.e), listed };
  if (!store(env, tab, draft)) tab.unstored.push(draft);
  return copy.id;
}

function storeAgain(env, tab) {
  if (tab.unstored.length) tab.unstored = tab.unstored.filter((draft) => !store(env, tab, draft));
}

const inLine = (state, entry) => positions(entry).some(([gen, seq]) => (covered(state, gen)?.[1] ?? -1) >= seq);

function sift(env, tab, basis, entries) {
  const stay = [];
  for (const entry of entries) {
    if (planted("copy-keeps-saved") || !inFile(basis.file, entry)) {
      stay.push(entry);
      continue;
    }
    const one = tab.edits.get(entry.e);
    const unsettled = one && (one.state === "pending" || one.state === "shared");
    const saved = basis.saved || (inLine(basis.file.state, entry) && !planted("saved-own-left-shared"));
    const byValue = one?.take && !planted("given-up-take-settled-by-its-place");
    if (unsettled && saved) settleRequest(env, tab, entry.e, byValue ? takeMet(tab, basis, entry.action) : fits(basis.file.state.wb, entry.action), { saved: true, file: basis.saved ? basis.file : undefined, mark: planted("given-up-edit-saved-by-its-place") ? null : lostMark(env, basis.file, one, entry.e) });
  }
  return stay;
}

const homeless = (tab, snap, id) => codec().targets(tab.edits.get(id).action).length > 0 && snap.unplaced.has(id);

function refuse(env, tab, id) {
  const one = tab.edits.get(id);
  one.state = "dropped";
  tab.notices.push({ kind: "refused", edits: [id], action: one.action });
  env.observer.onHomeless(env, tab, id);
}

function keepLimbo(env, tab, limbo, entries, basis) {
  if (!entries.length) return;
  if (!planted("copy-written-again")) return writeCopy(env, tab, newCopy(env, limbo.from, "restore-misfit"), basis, entries);
  limbo.copy ??= { ...newCopy(env, limbo.from, "restore-misfit"), edits: [] };
  limbo.copy.edits.push(...entries);
  writeCopy(env, tab, limbo.copy, basis, limbo.copy.edits);
}

const prune = (tab) => {
  const known = resolved(tab.state, tab.client);
  if (tab.pending.length && tab.pending[0].n <= known) tab.pending = tab.pending.filter((request) => request.n > known);
};

const waits = (tab, id) => tab.unstored.some((draft) => draft.fresh.includes(id));

const unstored = (tab, id) => !planted("unstored-edit-stays-open") && waits(tab, id);

const open = (tab) => tab.pending.filter((request) => tab.edits.get(request.id).state === "pending" && !unstored(tab, request.id));

const retired = (state, tab) => !(tab.client in state.seen) && tab.born <= state.floor && !planted("retired-as-new");

function renew(tab, epoch) {
  tab.retired = { client: tab.client, born: tab.born };
  tab.client = `${tab.id}.${tab.clients.size}`;
  tab.born = epoch;
  tab.clients.add(tab.client);
  tab.n = 0;
  tab.pending = [];
}

function rekey(env, tab, epoch) {
  const requests = open(tab);
  renew(tab, epoch);
  for (const request of requests) {
    request.n = ++tab.n;
    request.queued = false;
    Object.assign(tab.edits.get(request.id), { c: tab.client, n: request.n });
  }
  tab.pending = requests;
  env.observer.onRekey(env, tab);
}

function giveUp(env, tab, basis, held, reason, from, epoch) {
  const waiting = new Set(tab.limbo.flatMap((limbo) => [...limbo.requests]));
  const fresh = open(tab).filter((request) => !waiting.has(request.id)).map((request) => ownEntry(tab, request.id));
  const parked = tab.limbo.map((limbo) => [limbo, [...limbo.requests].map((id) => ownEntry(tab, id))]);
  tab.limbo = [];
  renew(tab, epoch);
  for (const [limbo, entries] of parked) keepLimbo(env, tab, limbo, sift(env, tab, basis, entries), basis);
  const entries = sift(env, tab, basis, [...inOrder(held), ...fresh]);
  if (entries.some(taken)) writeCopy(env, tab, newCopy(env, from, reason), basis, entries);
}

const settledFor = (tab) => (planted("listed-though-settled") ? new Set() : settledElsewhere(tab));

const tookItsRow = (tab, basis, one) => Boolean(one.take) && removesOf(one.action).length > 0 && !planted("skipped-take-of-a-delete-shown-as-refused") && takeMet(tab, basis, one.action);

function settleOwn(env, tab, frames, settled, basis) {
  if (planted("settled-own-left-open")) return;
  for (const frame of frames) {
    const id = frameId(frame);
    const one = tab.edits.get(id);
    if (!settled.has(id) || one?.state !== "shared") continue;
    if (tookItsRow(tab, basis, one)) settleRequest(env, tab, id, true, { saved: true });
    else settleRequest(env, tab, id, false);
  }
}

function settleDecided(env, tab, frames, decided) {
  if (planted("decided-held-edit-stays-shared")) return;
  for (const frame of frames) {
    const id = frameId(frame);
    if (!frame.dup && decided(frame) && afloat(tab.edits.get(id) ?? {})) settleSkipped(env, tab, id);
  }
}

function strand(env, tab, gen) {
  const held = tab.held.find((one) => one.gen === gen);
  if (!held) return;
  env.observer.onJudgeHeld(env, tab);
  const settled = settledFor(tab);
  const from = covered(tab.state, gen)[1];
  tab.held = tab.held.filter((one) => one !== held);
  settleOwn(env, tab, held.frames, settled, stateBasis(tab));
  const decided = (frame) => settled.has(frameId(frame)) || (held.gen !== tab.gen && resolved(tab.state, frame.c) >= frame.n && !planted("stranded-though-decided"));
  settleDecided(env, tab, held.frames, decided);
  const lost = held.frames.filter((frame) => !frame.dup && !decided(frame) && frame.seq > from);
  giveUp(env, tab, stateBasis(tab), lost.map((frame) => heldEntry(gen, frame)), "retired", gen, tab.epoch);
}

function trust(tab, file) {
  if (tab.gen === file.record.gen || covered(file.state, tab.gen)) return "lineage";
  return file.state.cut?.[0] === tab.gen ? "cut" : null;
}

function settleCut(env, tab, ids, file, snap) {
  const gen = file.state.cut[0];
  const told = [];
  const actions = {};
  for (const id of ids) {
    const one = tab.edits.get(id);
    const limbo = tab.limbo.find((entry) => entry.requests.has(id));
    if (limbo) {
      limbo.requests.delete(id);
      keepLimbo(env, tab, limbo, [ownEntry(tab, id, "unanswered")], fileBasis(file));
      continue;
    }
    const seen = (one.state === "shared" && one.gen === gen) || planted("cut-means-backed-up");
    if (!seen && homeless(tab, snap, id)) {
      refuse(env, tab, id);
      continue;
    }
    one.state = "recovered";
    told.push(id);
    if (!seen) actions[id] = one.action;
  }
  tab.limbo = tab.limbo.filter((entry) => entry.requests.size);
  if (told.length) tab.notices.push({ kind: "restore", edits: told, actions });
}

function settleRequest(env, tab, id, applied, where) {
  const one = tab.edits.get(id);
  if (one.state !== "pending" && one.state !== "shared") return;
  const limbo = tab.limbo.find((entry) => entry.requests.has(id));
  limbo?.requests.delete(id);
  const misfit = Boolean(limbo) && !applied && !where?.declined;
  if (where?.mark) {
    Object.assign(one, { state: where.mark.kind === "open" ? "recovered" : "kept-refused", copy: where.mark.copy });
    tab.notices.push({ kind: "passed", copy: where.mark.copy, edits: [id], decided: where.mark.kind, actions: { [id]: one.action } });
  } else if (applied) {
    one.state = where.saved || planted("ack-on-delivery") ? "saved" : "shared";
    one.gen = where.gen;
    one.seq = where.seq;
  } else if (misfit && planted("restore-drops-misfit")) {
    one.state = "dropped";
  } else if (misfit) {
    const entry = where?.file && !planted("counted-stored-as-refused") ? { ...ownEntry(tab, id, "counted"), file: where.file.record.commit } : ownEntry(tab, id, "refused", where?.file ? null : [where.gen, where.seq]);
    keepLimbo(env, tab, limbo, [entry], where?.file ? fileBasis(where.file) : stateBasis(tab));
  } else {
    one.state = "dropped";
    tab.notices.push({ kind: "refused", edits: [id], action: planted("refusal-notice-no-action") ? undefined : one.action });
  }
  if (limbo && !limbo.requests.size) tab.limbo = tab.limbo.filter((entry) => entry !== limbo);
}

function applyReceipt(env, tab, receipt) {
  if (receipt.through <= tab.base.through) return;
  tab.base = { commit: receipt.commit, etag: receipt.etag, through: receipt.through };
  tab.tail = planted("receipt-trims-all") ? [] : tab.tail.filter((frame) => frame.seq > receipt.through);
  for (const one of tab.edits.values()) {
    if (one.state === "shared" && one.gen === tab.gen && one.seq <= receipt.through) one.state = "saved";
  }
  if (tab.unknown?.kind === "save" && tab.unknown.gen === tab.gen && tab.unknown.through <= receipt.through) tab.unknown = null;
  dropRemovals(tab, tab.gen, tab.base.through);
  finishJob(env, tab);
}

function dropRemovals(tab, gen, through) {
  tab.removals = tab.removals.filter(({ at }) => (at[0] === gen ? at[1] > through : planted("record-trusts-a-later-file")));
}

const heldRemovals = (tab) => tab.removals.filter(({ at }) => (at[0] === tab.gen ? at[1] <= tab.a : planted("record-trusts-a-later-file")));

function readRemovals(env, tab) {
  const fresh = env.port.removals().slice(tab.recordSeen);
  tab.recordSeen = env.port.removals().length;
  if (planted("record-entry-not-shown")) return;
  for (const { copy, by, cells } of fresh) {
    const shown = tab.notices.some((one) => one.kind === "removed" && one.by === by && JSON.stringify(one.cells) === JSON.stringify(cells));
    if (!shown) tab.notices.push({ kind: "removed", copy, by, edits: [], cells });
  }
}

export function retry(env, tab) {
  if (!tab.throttled || !tab.alive || !tab.connected || !attached(env, tab)) return;
  tab.throttled = false;
  resend(env, tab);
}

function pruneHeld(env, tab) {
  if (!tab.held.length) return;
  tab.held = tab.held.filter((held) => held.frames.some((frame) => frame.seq > covered(tab.state, held.gen)[1]));
  if (!tab.held.length) flush(env, tab);
}

const hidesRemoved = (frame, origin) => planted(origin[1] === frame.e ? "restored-delete-hides-removed-values" : "taken-delete-hides-removed-values");

function applyAction(env, tab, frame) {
  const origin = removesOf(frame.action).length > 0 && !frame.keep ? originOf(frame) : null;
  const removed = origin && !hidesRemoved(frame, origin) ? unseenBy(tab.state.wb, frame.action, frame.saw).slice(0, frame.k === "adopt" && planted("returned-delete-names-one-removed-value") ? 1 : Infinity) : [];
  const result = applyFrame(tab.state, frame, tab.epoch);
  if (result.applied) for (const row of createsOf(frame.action)) tab.inserts[row] = { e: frame.e, c: frame.c, n: frame.n, b: frame.b ?? null, src: [tab.gen, frame.seq], org: frame.org ?? [tab.gen, frame.seq], via: frame.via ?? [] };
  if (result.applied && origin) {
    if (removed.length && !(frame.k === "adopt" && planted("returned-delete-shows-no-removed-notice"))) tab.notices.push({ kind: "removed", copy: origin[0], by: frameId(frame), edits: [], cells: removed });
    env.observer.onRemoved(tab, frame, removed);
    if (env.removals && removed.length && !planted("record-misses-removed-values") && (frame.seq > tab.base.through || planted("record-keeps-a-saved-entry"))) tab.removals.push({ copy: origin[0], by: frameId(frame), at: [tab.gen, frame.seq], cells: removed });
    if (env.removals && removed.length && planted("record-written-before-its-save")) storeRemovals(env, tab, tab.removals.slice(-1));
  }
  tab.a = frame.seq;
  if (frame.seq > tab.base.through) tab.tail.push(result.applied ? frame : { ...frame, noop: true, dup: result.dup });
  if (!tab.clients.has(frame.c)) return;
  const mine = tab.edits.get(frameId(frame));
  const kept = mine && inCopy(mine) && (frame.copy || frame.k === "adopt");
  if (frame.keep && !result.dup) env.observer.onKeepSeen(tab, frameId(frame));
  if (mine?.take && result.applied) mine.removed = removed;
  const inSave = frame.seq <= tab.base.through && !planted("restored-edit-waits-for-a-save-it-has");
  const back = frame.k === "adopt" && frame.keep && frame.open && !result.dup;
  if (back && !planted("returned-edit-shown-as-dropped")) settleReturned(env, tab, frameId(frame), frame.seq);
  else if (kept && frame.copy && (result.applied || (frame.keep && planted("kept-edit-shown-as-saved")))) Object.assign(mine, { state: inSave ? "saved" : "shared", gen: tab.gen, seq: frame.seq });
  else if (kept && !result.applied && !result.dup && !planted("restored-refusal-stays-recovered")) mine.state = "kept-refused";
  else if (!result.dup) settleRequest(env, tab, frameId(frame), result.applied, { gen: tab.gen, seq: frame.seq });
  else if (mine && (mine.copy || !planted("skipped-adoption-needs-its-own-copy")) && frame.k === "adopt" && mine.gen !== tab.gen && !planted("skipped-adoption-stays-shared") && (!waits(tab, frameId(frame)) || planted("skipped-frame-relabels-an-unstored-edit"))) settleSkipped(env, tab, frameId(frame));
  prune(tab);
  if (!planted("passed-limbo-request-waits")) settlePassedLimbo(env, tab);
}

function settleReturned(env, tab, id, seq) {
  const mine = tab.edits.get(id);
  if (mine && afloat(mine)) settleRequest(env, tab, id, false, { gen: tab.gen, seq, mark: passedMark(env, id) });
}

function settlePassedLimbo(env, tab) {
  for (const id of tab.limbo.flatMap((limbo) => [...limbo.requests])) {
    const one = tab.edits.get(id);
    if (one.n > resolved(tab.state, one.c)) continue;
    const mark = passedMark(env, id);
    if (mark && !(mark.kind === "refused" && planted("refused-limbo-request-waits"))) settleRequest(env, tab, id, false, { mark });
  }
}

function settleSkipped(env, tab, id) {
  const mark = passedMark(env, id);
  if (mark) return settleRequest(env, tab, id, false, { mark });
  const one = tab.edits.get(id);
  if (one.state === "shared" && ["taken", "saved"].includes(env.port.verdict(id)?.kind)) one.state = "saved";
}

function applyRoomFrame(env, tab, frame) {
  tab.touched++;
  if (frame.k === "receipt") {
    applyReceipt(env, tab, frame);
    return retry(env, tab);
  }
  applyAction(env, tab, frame);
  if (tab.job && !tab.job.queued) flush(env, tab);
  if (frame.k !== "adopt") return;
  pruneHeld(env, tab);
  retry(env, tab);
}

export function toTab(env, tab) {
  if (!tab.alive || !tab.connected || !attached(env, tab)) return false;
  const room = env.port.room();
  if (tab.cursor < room.floor && !tab.inbox.has(tab.cursor)) {
    sync(env, tab);
    return attached(env, tab) && tab.cursor >= env.port.room().floor;
  }
  if (!env.port.scrambled()) {
    if (tab.cursor >= room.log.length) return false;
    if (!arrive(env, tab, room.log[tab.cursor])) return true;
    applyRoomFrame(env, tab, room.log[tab.cursor++]);
    return true;
  }
  const waiting = [];
  for (let no = Math.max(tab.cursor, room.floor); no < room.log.length; no++) if (!tab.inbox.has(no)) waiting.push(no);
  if (!waiting.length) return false;
  receive(env, tab, waiting[env.port.pick(waiting.length)]);
  return true;
}

function arrive(env, tab, frame) {
  const parts = frame.parts ?? 1;
  if (parts === 1) return true;
  const got = (tab.parts.get(frame.no) ?? 0) + 1;
  if (planted("apply-partial-paste")) {
    const size = env.limits.opsPerFrame;
    for (const [row, col, value] of frame.action.cells.slice((got - 1) * size, got * size)) if (tab.state.wb.rows[row]) tab.state.wb.rows[row].cells[col] = value;
  }
  if (got < parts) {
    tab.parts.set(frame.no, got);
    return false;
  }
  tab.parts.delete(frame.no);
  return true;
}

export function receive(env, tab, no) {
  const room = env.port.room();
  if (!arrive(env, tab, room.log[no])) return;
  const early = planted("no-reorder-buffer");
  tab.inbox.set(no, room.log[no]);
  if (early) applyRoomFrame(env, tab, room.log[no]);
  while (attached(env, tab) && tab.inbox.has(tab.cursor)) {
    const frame = tab.inbox.get(tab.cursor);
    tab.inbox.delete(tab.cursor++);
    if (!early) applyRoomFrame(env, tab, frame);
  }
}

export function toRoom(env, tab, at = env.port.scrambled() ? env.port.pick(tab.out.length) : 0) {
  if (!tab.alive || !tab.connected || !tab.out.length || !env.port.room()) return false;
  const [frame] = tab.out.splice(at, 1);
  hear(env, tab, frame, admit(env, env.port.room(), frame, tab.id));
  return true;
}

export function post(env, tab, at = env.port.scrambled() ? env.port.pick(tab.out.length) : 0) {
  if (!tab.alive || !tab.connected || !tab.out.length) return false;
  const [frame] = tab.out.splice(at, 1);
  tab.flight.add(frame);
  env.port.post(tab, frame);
  return true;
}

export function answered(env, tab, frame, result) {
  if (!tab.flight.delete(frame)) return false;
  if (!tab.alive || !tab.connected) return false;
  hear(env, tab, frame, result);
  return true;
}

export function waited(env, tab) {
  if (!tab.alive || !tab.connected || !tab.flight.size) return false;
  if (planted("wire-never-resent")) {
    tab.flight.clear();
    return true;
  }
  resend(env, tab);
  return true;
}

function hear(env, tab, frame, result) {
  if (frame.gen !== tab.gen) return;
  const retired = result === "retired" && (frame.k === "adopt" || frame.of === "adopt");
  const behind = retired && tab.a < tab.base.through - (planted("gives-up-one-frame-before-its-save") ? 1 : 0) && !planted("gives-up-before-it-reads-its-save");
  if (result === "full" || result === "gap" || result === "ledger-full" || behind) {
    tab.throttled = true;
    if (frame.k === "part") tab.out = tab.out.filter((other) => other.key !== frame.key);
  }
  if (retired && !behind) strand(env, tab, frame.from);
  if (result?.how === "returned") markReturned(env, tab, frame.from, result);
  if (frame.k === "copy" || frame.of === "copy") storedAnswer(env, tab, frame, result);
  if (frame.of === "copy" && typeof result !== "string" && !planted("restore-sends-an-answered-offer")) tab.out = tab.out.filter((other) => other.key !== frame.key);
}

function markReturned(env, tab, gen, { copy, e }) {
  if (!tab.marks.some((mark) => mark.e === e && mark.kind === "open")) tab.marks.push({ copy, e, kind: "open" });
  tab.out = tab.out.filter((other) => !((other.k === "adopt" || other.of === "adopt") && other.from === gen));
  for (const held of tab.held) if (held.gen === gen) held.offered = false;
  flush(env, tab);
}

const through = (file, gen) => (file.record.gen === gen ? file.record.through : covered(file.state, gen)?.[1] ?? -1);

const returnedTake = (file, one) => Boolean(one.take) && one.gen !== file.record.gen && !planted("returned-take-shown-as-saved");

const lostMark = (env, file, one, id) => (one.gen === file.record.gen || planted("lost-room-position-means-saved") || (planted("lost-room-position-means-a-paste-is-saved") && one.action.t === "paste") ? null : passedMark(env, id));

function passedMark(env, id) {
  const mark = planted("label-ignores-record") ? null : env.port.verdict(id);
  return mark && mark.kind !== "taken" && mark.kind !== "saved" ? mark : null;
}

function relabel(env, tab) {
  for (const [id, one] of tab.edits) {
    if (!inCopy(one)) continue;
    const kind = env.port.verdict(id)?.kind;
    if (kind === "taken" || kind === "saved") one.state = "saved";
    else if (kind === "kept" || kind === "misfit") one.state = "kept-refused";
  }
}

function learnFromFile(env, tab, file, snap) {
  const how = tab.gen === null ? null : trust(tab, file);
  if (how) {
    const cut = [];
    for (const [id, one] of tab.edits) {
      if (one.state !== "pending" && one.state !== "shared") continue;
      if (waits(tab, id) && !planted("unstored-edit-settles")) continue;
      const known = resolved(file.state, one.c);
      if (one.n > known) {
        if (one.state !== "shared") continue;
        if (how === "cut" && one.gen === file.state.cut[0] && one.seq <= file.state.cut[1]) cut.push(id);
        else if (through(file, one.gen) >= one.seq) settleRequest(env, tab, id, planted("coverage-means-saved") || (returnedTake(file, one) ? met(file.state.wb, one.action) : fits(file.state.wb, one.action)), { saved: true, file, mark: lostMark(env, file, one, id) });
        continue;
      }
      const [low, high] = (how === "cut" && file.state.cut[2][one.c]) || [known, known];
      if (one.n > low && one.n <= high) cut.push(id);
      else settleRequest(env, tab, id, one.take && !planted("take-settled-from-the-ledger") ? met(file.state.wb, one.action) : fits(file.state.wb, one.action), { saved: true, file, declined: one.take && fits(file.state.wb, one.action) && !planted("declined-take-stored-as-counted"), mark: one.state === "shared" && through(file, one.gen) >= one.seq ? lostMark(env, file, one, id) : passedMark(env, id) });
    }
    if (cut.length) settleCut(env, tab, cut, file, snap ?? snapshot(tab));
  }
  if (tab.unknown?.kind === "save") tab.unknown = null;
  if (attached(env, tab) && file.record.gen === tab.gen && file.record.through > tab.base.through) {
    const receipt = { k: "receipt", gen: tab.gen, commit: file.record.commit, etag: file.etag, through: file.record.through };
    applyReceipt(env, tab, receipt);
    tab.out.push(receipt);
  }
}

function load(tab, file) {
  if (tab.born === null) tab.born = file.record.epoch;
  tab.gen = file.record.gen;
  tab.epoch = file.record.epoch;
  tab.state = clone(file.state);
  tab.a = file.record.through;
  tab.base = { commit: file.record.commit, etag: file.etag, through: file.record.through };
  tab.tail = [];
  tab.pending = open(tab);
}

function startEstablish(env, tab, file) {
  if (tab.io) return false;
  const epoch = file.record.epoch + 1;
  const gen = nextGen(env, epoch);
  const commit = nextCommit(env);
  const record = { v: 2, doc: DOC, gen, epoch, commit, parent: file.record.commit, through: 0, room: env.port.room().id };
  const [own, before] = file.state.opened ?? [file.record.epoch, file.record.epoch];
  const state = nextGeneration(file.state, file.record.gen, file.record.through, epoch, env.limits.ledgerCap, file.record.room === env.port.room().id ? [planted("ledger-turn-restarts-the-room") ? epoch : own, before] : [epoch, own]);
  request(env, tab, { kind: "establish", gen, commit, through: 0, etag: planted("establish-unconditional") ? "*" : file.etag, body: serialize(record, state) });
  return true;
}

function request(env, tab, io) {
  tab.io = io;
  env.observer.onRequest(env, tab, io);
  env.port.send(tab, io);
}

export function nudge(env, tab) {
  if (!tab.alive || !tab.connected) return;
  if (env.split) tab.wake = true;
  else sync(env, tab);
}

export function nudgeAll(env, except = null) {
  for (const tab of env.port.tabs()) if (tab !== except) nudge(env, tab);
}

function openRoom(env, tab, file, snap) {
  const room = env.port.room();
  const live = env.port.read();
  const named = live.record.room === room.id || planted("open-unnamed");
  if (!planted("stale-open") && (live.record.gen !== file.record.gen || !named)) return read(env, tab);
  const from = planted("stale-open") ? file : live;
  if (room.gen) env.observer.onRoomLoss(env, room, "replaced");
  env.port.setRoom(newRoom(from.record, from.etag, from.state, room.id));
  env.observer.onRoom(env, env.port.room());
  attach(env, tab, file, snap);
  nudgeAll(env, tab);
}

function classify(env, tab, file, snap) {
  const state = file.state;
  const from = tab.gen;
  const keep = [];
  const lost = [];
  const stored = [];
  env.observer.onJudgeHeld(env, tab);
  const settled = settledFor(tab);
  let stranded = null;
  for (const held of tab.held) {
    const entry = planted("copy-not-adopt") ? null : covered(state, held.gen);
    if (entry) {
      held.frames = held.frames.filter((frame) => frame.seq > entry[1]);
      if (held.frames.length) keep.push(held);
      continue;
    }
    const cut = state.cut?.[0] === held.gen ? state.cut[1] : null;
    settleOwn(env, tab, held.frames, settled, fileBasis(file));
    const decided = (frame) => settled.has(frameId(frame)) || (held.gen !== from && resolved(tab.state, frame.c) >= frame.n && !planted("lost-though-decided"));
    settleDecided(env, tab, held.frames, decided);
    const left = held.frames.filter((frame) => !frame.dup && !decided(frame) && (cut === null || frame.seq > cut));
    const beyond = left.filter((frame) => !frame.noop);
    stored.push(...left.map((frame) => heldEntry(held.gen, frame)));
    if (!beyond.length) continue;
    lost.push(...beyond);
    if (cut === null) stranded = held.gen;
  }
  tab.held = keep;
  if (planted("recover-own-only")) {
    const own = keep.flatMap((held) => held.frames).filter((frame) => frame.c === tab.client && frame.n > resolved(state, tab.client));
    for (const frame of own) tab.edits.get(frameId(frame)).state = "pending";
    tab.pending = [...own.map((frame) => ({ n: frame.n, id: frame.e, action: frame.action, queued: false, sent: true })), ...tab.pending].sort((a, b) => a.n - b.n);
    tab.held = [];
  }
  const how = trust(tab, file);
  const out = Boolean(how) && retired(state, tab);
  const waiting = new Set(tab.limbo.flatMap((limbo) => [...limbo.requests]));
  const fresh = open(tab).filter((request) => !waiting.has(request.id));
  if (how === "cut" && !out) for (const request of fresh) request.sent = false;
  const unsure = out && (waiting.size > 0 || fresh.some((request) => request.sent));
  if (!how || lost.length || unsure) {
    const reason = stranded || !how ? "lineage" : lost.length ? "restore" : "retired";
    return giveUp(env, tab, fileBasis(file), stored, reason, stranded ?? from, file.record.epoch);
  }
  if (out) rekey(env, tab, file.record.epoch);
  if (how === "cut" && fresh.length) tab.limbo.push({ requests: new Set(fresh.map((request) => request.id)), from, copy: null });
}

function attach(env, tab, file, snap) {
  const room = env.port.room();
  const moved = tab.gen !== room.gen;
  if (moved && tab.tail.length) tab.held.push({ gen: tab.gen, frames: tab.tail, offered: false });
  if (moved && tab.gen !== null) classify(env, tab, file, snap);
  tab.room = room;
  load(tab, file);
  tab.inbox = new Map();
  tab.parts = new Map();
  tab.throttled = false;
  if (!planted("attach-no-tail")) for (const frame of retained(room)) if (frame.k !== "receipt" && frame.seq > tab.a) applyAction(env, tab, frame);
  tab.cursor = room.log.length;
  if (file.record.through > room.base.through) tab.out.push({ k: "receipt", gen: tab.gen, commit: file.record.commit, etag: file.etag, through: file.record.through });
  pruneHeld(env, tab);
  resend(env, tab);
}

export function read(env, tab) {
  if (!tab.alive || !tab.connected) return false;
  storeAgain(env, tab);
  if (tab.marks.length && writeMarks(env, tab)) flush(env, tab);
  relabel(env, tab);
  const file = env.port.read();
  const snap = tab.state && tab.gen !== file.record.gen ? snapshot(tab) : null;
  learnFromFile(env, tab, file, snap);
  if (env.removals) {
    dropRemovals(tab, file.record.gen, file.record.through);
    readRemovals(env, tab);
  }
  if (!tab.state) load(tab, file);
  if (tab.unknown?.kind === "establish") tab.unknown = null;
  tab.wake = false;
  tab.fetched = { file, snap, touched: tab.touched };
  return true;
}

const retiredOnOldFile = (env, tab, file) => tab.gen !== null && retired(file.state, tab) && env.port.read().etag !== file.etag && !planted("retire-on-stale-file");

export function link(env, tab) {
  if (!tab.alive || !tab.connected || !tab.fetched) return false;
  if (tab.fetched.touched !== tab.touched) read(env, tab);
  const { file, snap } = tab.fetched;
  tab.fetched = null;
  if (!env.port.room()) env.port.setRoom(newInstance(env));
  const room = env.port.room();
  if (room.gen === file.record.gen) {
    if (tab.room === room && (tab.cursor >= room.floor || tab.inbox.has(tab.cursor))) resend(env, tab);
    else if (file.record.through < room.base.through && !planted("attach-stale-file")) read(env, tab);
    else if (retiredOnOldFile(env, tab, file)) read(env, tab);
    else attach(env, tab, file, snap);
  } else if (file.record.room === room.id || (planted("open-unnamed") && !room.gen)) {
    openRoom(env, tab, file, snap);
  } else {
    startEstablish(env, tab, file);
  }
  return true;
}

export function sync(env, tab) {
  if (!read(env, tab) || env.split) return;
  for (let tries = 0; tab.fetched && tries < 8; tries++) link(env, tab);
}

export function rotate(env, tab) {
  if (!tab || !tab.alive || !tab.connected || !attached(env, tab)) return false;
  return startEstablish(env, tab, env.port.read());
}

export function capture(env, tab) {
  if (!tab || !tab.alive || !tab.connected || tab.io || tab.wake || tab.fetched) return false;
  if (planted("save-waits-for-every-tab") && env.port.tabs().some((one) => one.alive && !one.connected)) return false;
  if (tab.unknown || !attached(env, tab) || tab.base.etag === tab.refused) sync(env, tab);
  if (tab.io || tab.fetched || !attached(env, tab) || tab.base.etag === tab.refused) return false;
  if (tab.a <= tab.base.through) {
    const large = ledgerBytes(tab.state.seen) > ledgerMarks(env.limits.ledgerCap).rotate;
    return large && !planted("no-ledger-cap") ? startEstablish(env, tab, env.port.read()) : false;
  }
  const commit = nextCommit(env);
  const record = { v: 2, doc: DOC, gen: tab.gen, epoch: tab.epoch, commit, parent: tab.base.commit, through: tab.a, room: tab.room.id };
  const state = tab.state;
  let body = () => serialize(record, state);
  if (planted("capture-overlay")) body = serialize(record, { ...state, wb: view(tab) });
  else if (!planted("capture-live")) body = serialize(record, state);
  request(env, tab, { kind: "save", gen: tab.gen, commit, through: tab.a, etag: tab.base.etag, body, removals: env.removals && !planted("record-not-sent-with-its-save") ? heldRemovals(tab) : [] });
  if (planted("receipt-before-accept")) tab.out.push({ k: "receipt", gen: tab.gen, commit, etag: tab.base.etag, through: tab.a });
  return true;
}

function refused(env, tab, io) {
  if (planted("412-no-fetch")) return;
  if (planted("412-repin") && io.kind === "save") return request(env, tab, { ...io, etag: env.port.etag() });
  tab.refused = io.etag;
  sync(env, tab);
}

function unanswered(env, tab, io) {
  if (planted("unknown-never-resolved")) {
    tab.io = io;
    return;
  }
  if (planted("unknown-assumes-saved") && io.kind === "save" && attached(env, tab) && tab.gen === io.gen) {
    const receipt = { k: "receipt", gen: io.gen, commit: io.commit, etag: tab.base.etag, through: io.through };
    applyReceipt(env, tab, receipt);
    tab.out.push(receipt);
    return;
  }
  tab.unknown = { kind: io.kind, gen: io.gen, commit: io.commit, through: io.through };
}

export function storeRemovals(env, tab, entries) {
  env.port.keepRemovals(entries);
  for (const entry of entries) env.observer.onRemoval(env, tab, entry);
}

export function deliver(env, at = 0, lost = false) {
  const answered = env.port.takeAnswer(at);
  if (!answered) return false;
  const { tab, io, status } = answered;
  if (tab.io === io) tab.io = null;
  if (!tab.alive) return true;
  if (lost || !status || !tab.connected) return unanswered(env, tab, io), true;
  env.observer.onAnswer(env, tab, io, status);
  if (status !== 200) refused(env, tab, io);
  else sync(env, tab);
  return true;
}
