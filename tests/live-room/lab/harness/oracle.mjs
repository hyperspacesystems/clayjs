import { canon, fromCanon } from "./lib.mjs";
import { recordBytes, recordBudget, ledgerBytes } from "../core/record.mjs";
import { get, verdict, FIRST_GEN, FIRST_COMMIT } from "./host.mjs";
import { W, epochOf, ledgerMarks } from "../core/ledger.mjs";
import { stateReserve } from "../core/room.mjs";
import { frameBytes, frameOps, actionBytes } from "../core/limits.mjs";
import { cellsOf as workbookCells } from "../codec-tiny/reducer.mjs";
import { attached, view as codecView, frameId } from "../core/tab.mjs";
import { refAction, refDoc, codecAction, codecDoc } from "./lens.mjs";
import { replay, CLOSING } from "../core/recover.mjs";
import { reviewed } from "../core/conflict.mjs";
import { planted } from "../core/planted.mjs";
import { readPage, parse } from "./reader.mjs";

export const newTally = () => ({ applied: 0, misfit: 0, saved: 0, resolved: 0, replaced: 0, unjudged: 0, refused: 0, conflict: 0, held: 0, order: 0, row: 0, kept: 0, late: 0, again: 0, shown: 0, back: 0 });

const cellsOf = (action) => workbookCells(refAction(action));

const view = (tab) => refDoc(codecView(tab));

const codecFile = (file) => ({ ...file, state: { ...file.state, wb: codecDoc(file.state.wb) } });

const newWhatIf = () => ({ copies: 0, edits: 0, auto: 0, chosen: 0, kept: 0, released: 0, misfit: 0, conflict: 0, held: 0, left: 0 });

const OUTSIDE = { id: "outside", alive: false, edits: new Map(), notices: [] };

const authorOf = (world, edit) => world.tabs.find((tab) => tab.id === edit.by) ?? OUTSIDE;

const shownRefused = (world, oracle, id) => oracle.takeOf.has(id) && oracle.edits.get(id).action.t === "del" && ["dropped", "kept-refused"].includes(authorOf(world, oracle.edits.get(id)).edits.get(id)?.state);

export function refStep(wb, done, id, action) {
  wb = refDoc(wb);
  action = refAction(action);
  if (done.has(id)) return { applied: false, dup: true };
  done.add(id);
  const row = wb.rows[action.row];
  if (action.t === "set" || action.t === "paste") {
    const cells = cellsOf(action);
    if (cells.some(([at]) => !wb.rows[at])) return { applied: false, dup: false };
    for (const [at, col, value] of cells) {
      if (value === "") delete wb.rows[at].cells[col];
      else wb.rows[at].cells[col] = value;
    }
  } else if (action.t === "ins") {
    if (row) return { applied: false, dup: false };
    wb.rows[action.row] = { pos: action.pos, cells: { ...action.cells } };
  } else {
    if (!row) return { applied: false, dup: false };
    delete wb.rows[action.row];
  }
  return { applied: true, dup: false };
}

const fitsRef = (wb, action) => fitsRefOf(refDoc(wb), refAction(action));

const fitsRefOf = (wb, action) => (action.t === "ins" ? !wb.rows[action.row] : action.t === "del" ? Boolean(wb.rows[action.row]) : cellsOf(action).every(([row]) => wb.rows[row]));

const rowsRef = (action) => rowsRefOf(refAction(action));

const rowsRefOf = (action) => (action.t === "ins" ? [] : action.t === "del" ? [action.row] : cellsOf(action).map(([row]) => row));

const marksRef = (action) => marksRefOf(refAction(action));

const marksRefOf = (action) => (action.t === "ins" ? [action.row] : cellsOf(action).map(([row, col]) => `${row}/${col}`));

function aheadOf(wb, action, waiting) {
  const row = rowsRef(action).find((one) => !wb.rows[one] && waiting.has(one));
  const mark = row ?? (action.t === "ins" ? undefined : marksRef(action).find((one) => waiting.has(one)));
  return mark === undefined ? null : { mark, row: row !== undefined, e: waiting.get(mark) };
}

function note(sets, key, value) {
  if (!sets.has(key)) sets.set(key, new Set());
  sets.get(key).add(value);
}

const newWaits = () => ({ marks: new Map() });

function noteWait(waits, { e, c, n }, action, how, at) {
  const ins = action.t === "ins";
  const waiting = ins ? how === "unjudged" : how === "conflict" || how === "held";
  if (waiting) waits.marks.set(at, { e, c, n, at, ins, marks: marksRef(action) });
  else waits.marks.delete(at);
}

function openWaits(waits, seen, at) {
  const open = new Map();
  for (const ahead of [...waits.marks.values()].sort((a, b) => a.at - b.at)) {
    if (ahead.at < at && (!ahead.ins || (seen[ahead.c]?.[0] ?? 0) < ahead.n)) for (const mark of ahead.marks) open.set(mark, ahead.e);
  }
  return open;
}

function wholeRef({ record, state }, entry) {
  const since = entry.org ? epochOf(entry.org[0]) : entry.b;
  return since !== null && since !== undefined && since > state.floor && since >= record.epoch - W;
}

const outOfRoom = (oracle, room) => (id) => oracle.cutOut.has(id) || oracle.backedUp.has(id) || oracle.gens.get(room.gen).done.has(id);

function rowToComeRef(oracle, target, wb, action, made, gone = replacedNow(oracle), far = false) {
  wb = refDoc(wb);
  return rowsRef(action).find((row) => !wb.rows[row] && insertPending(oracle, target, made?.[row], gone, far)) ?? null;
}

const madeOf = (made, action) => {
  const rows = rowsRef(action).filter((row) => made?.[row]);
  return rows.length ? Object.fromEntries(rows.map((row) => [row, made[row]])) : null;
};

function nearRoom(oracle, gen, seenIn) {
  const rooms = [];
  let turns = 0;
  for (let at = gen; at; at = oracle.gens.get(at).parent) {
    const { room } = oracle.gens.get(at);
    if (room === null) return null;
    if (rooms.at(-1) !== room) {
      rooms.push(room);
      turns = 0;
    }
    if (rooms.length > 2) return null;
    if (at === seenIn) return rooms.length === 1 ? "same" : turns ? "earlier" : "next";
    turns++;
  }
  return null;
}

function insertPending(oracle, target, insert, gone, far) {
  if (!insert || gone(insert.e)) return false;
  if ((target.state.seen[insert.c]?.[0] ?? 0) >= insert.n) return false;
  if (placedRef(target, insert)) return false;
  const held = insert.src[0] === target.record.gen ? insert.src[1] > target.record.through : target.state.lineage.some(([gen, through]) => gen === insert.src[0] && insert.src[1] > through);
  const since = epochOf(insert.src[0]);
  const taken = insert.src[0] === target.record.gen || target.state.lineage.some(([gen]) => epochOf(gen) >= since && (insert.c in target.state.seen || epochOf(gen) >= target.state.floor));
  const open = insert.src[0] === target.record.gen ? held : !target.state.lineage.some(([gen, through]) => gen === insert.src[0] && insert.src[1] <= through);
  if (far) return wholeRef(target, insert) || held || (open && taken);
  return (planted("oracle-trusts-the-ledger-floor") ? wholeRef(target, insert) : open && taken) && nearRoom(oracle, target.record.gen, insert.src[0]) !== null;
}

function noteStop(oracle, room, wb, id, made) {
  const { action } = oracle.edits.get(id);
  const far = Boolean(rowToComeRef(oracle, { record: { gen: room.gen, epoch: room.epoch }, state: room.state }, wb, action, made, outOfRoom(oracle, room), true));
  if (far) oracle.stopped.add(id);
  for (const row of rowsRef(action)) {
    const insert = made?.[row];
    if (insert && !wb.rows[row] && (room.state.seen[insert.c]?.[0] ?? 0) < insert.n && nearRoom(oracle, room.gen, insert.src[0]) !== null) oracle.gaveUp.set(insert.e, { id, row, gen: room.gen });
  }
  return far;
}

const whyComing = (row) => `its row ${row} is missing, and a room took an insert of that row that the ledger has not counted yet and still can, and the room that follows that lost room is still open, also after it turned its ledger: another tab can still bring that row back (rules 106 and 124)`;

function whyLeft(file, entry, stands) {
  if (entry.out === "counted") return "the copy stores it as counted by a file";
  if (!wholeRef(file, entry)) return "the ledger can no longer judge its client";
  if (stands < entry.n - 1) return "an earlier request of its client is not resolved";
  return null;
}

const whyWaits = ({ mark, row, e }) => (row ? `its row ${mark} is created by ${e}, an earlier insert of the same copy that was left waiting` : `${e}, an earlier edit of the same copy that writes its cell ${mark}, was left waiting: edits of one copy that write the same cell are restored in their order`);

const holdsRef = (wb, action) => holdsRefOf(refDoc(wb), refAction(action));

const holdsRefOf = (wb, action) => (action.t === "ins" ? Boolean(wb.rows[action.row]) : cellsOf(action).length > 0 && cellsOf(action).every(([row, col, value]) => value !== "" && wb.rows[row]?.cells[col] === value));

function keepStep(done, id) {
  if (done.has(id)) return { applied: false, dup: true };
  done.add(id);
  return { applied: false, dup: false };
}

const filledRef = (row) => Object.fromEntries(Object.entries(row?.cells ?? {}).filter(([, value]) => value !== "" && value != null));

function unseen(wb, { action, seen }) {
  wb = refDoc(wb);
  action = refAction(action);
  if (action.t === "ins") return [];
  if (action.t === "del") {
    const now = filledRef(wb.rows[action.row]);
    if (!seen) return [[action.row, null, "", ""]];
    return Object.keys(seen)
      .sort()
      .filter((col) => (now[col] ?? "") !== seen[col])
      .map((col) => [action.row, col, now[col] ?? "", ""]);
  }
  return cellsOf(action).flatMap(([row, col, value]) => {
    const now = wb.rows[row]?.cells[col] ?? "";
    return seen && now === seen[`${row}/${col}`] ? [] : [[row, col, now, value]];
  });
}

function lateRef(wb, edit) {
  const changed = unseen(wb, edit);
  return changed.length ? changed : unseen(wb, { action: edit.action, seen: null });
}

function removedRef(wb, { action, seen }) {
  wb = refDoc(wb);
  action = refAction(action);
  if (action.t !== "del" || !seen) return [];
  return Object.entries(filledRef(wb.rows[action.row]))
    .filter(([col]) => !(col in seen))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([col, value]) => [action.row, col, value]);
}

function seenFrom(action, saw) {
  action = refAction(action);
  if (action.t === "ins" || !saw) return null;
  if (action.t === "del") return { ...saw };
  return Object.fromEntries(cellsOf(action).map(([row, col], at) => [`${row}/${col}`, saw[at]]));
}

function lookedRef({ action, seen }, cells) {
  action = refAction(action);
  if (action.t === "ins" || !seen) return null;
  const looked = { ...seen };
  for (const [row, col, now] of cells) {
    const key = action.t === "del" ? col : `${row}/${col}`;
    if (action.t === "del" && now === "") delete looked[key];
    else looked[key] = now;
  }
  return looked;
}

const lookedAt = (origin) => (origin.looked ? { how: "take", looked: origin.looked } : null);

const overUnseen = (wb, edit, choice) => {
  const clash = unseen(wb, edit);
  return clash.length && choice?.how === "take" && choice.looked && !unseen(wb, { action: edit.action, seen: choice.looked }).length ? [] : clash;
};

function sawAsSeen({ action, seen }, saw) {
  if (action.t === "ins") return saw == null;
  if (!saw || !seen) return false;
  if (action.t === "del") return JSON.stringify(Object.entries(saw).sort()) === JSON.stringify(Object.entries(seen).sort());
  return cellsOf(action).length === saw.length && cellsOf(action).every(([row, col], at) => saw[at] === seen[`${row}/${col}`]);
}

function newGenInfo(kind, parent, base, text, outcomes, room = null, turn = false) {
  return { kind, parent, base, room, turn, pre: [], ids: [null], who: [null], applied: [null], dup: [null], declined: [null], origin: [null], open: [false], bytes: [0], at: [text], work: fromCanon(text), kept: new Set(), taken: new Set(), removed: new Map(), done: new Set(outcomes.keys()), outcomes, result: new Map(outcomes), turned: new Map(), reopened: new Map() };
}

export function newOracle(world) {
  const text = canon(parse(world.host.body).state.wb);
  const oracle = {
    edits: new Map(),
    byValue: new Map(),
    sameValue: new Map(),
    delivered: new Map(),
    early: new Map(),
    answers: new Map(),
    decidedAnswers: new WeakSet(),
    waits: new Map(),
    jobs: new Map(),
    offered: new Set(),
    passing: new Map(),
    passedInRoom: new Map(),
    skippedListed: new Set(),
    facts: new Map(),
    jobCopy: new Map(),
    firstIn: new Map(),
    jobMade: new Map(),
    takeOf: new Map(),
    tookBy: new Map(),
    takes: new Map(),
    lateKept: new Set(),
    removalHeld: 0,
    rowWaits: { all: 0, turned: 0, earlier: 0 },
    gaveUp: new Map(),
    removedLists: new Set(),
    removedSeen: new Map(),
    removalChecked: 0,
    removalMissed: 0,
    savedThrough: new Map(),
    stopped: new Set(),
    returned: { judged: 0, kept: 0, sent: 0 },
    roomJudged: {},
    restored: { jobs: 0, edits: 0, applied: 0, kept: 0, misfit: 0, conflict: 0, saved: 0, replaced: 0, counted: 0, refused: 0, held: 0, left: 0 },
    decisions: { jobs: 0, take: 0, keep: 0, taken: 0, kept: 0, again: 0, moot: 0 },
    choices: new Map(),
    shown: new Map(),
    declined: new Set(),
    places: new Map(),
    placesOpen: 0,
    metItsValue: new Set(),
    keepSeen: new Set(),
    keptApart: new Set(),
    cuts: new Map(),
    whatIf: { take: newWhatIf(), keep: newWhatIf() },
    refused: new Map(),
    everRefused: new Map(),
    saved: new Map(),
    gens: new Map([[FIRST_GEN, newGenInfo("initial", null, null, text, new Map())]]),
    commits: new Map([[FIRST_COMMIT, { gen: FIRST_GEN, through: 0 }]]),
    live: FIRST_COMMIT,
    owed: new Map(),
    witnessed: new Set(),
    refusedTo: new Map(),
    backedUp: new Set(),
    recovered: new Map(),
    homeless: new Map(),
    adoptRefused: new Set(),
    applied: new Set(),
    backups: [],
    cutOut: new Set(),
    broughtBack: new Set(),
    built: new Map(),
    copies: new Map(),
    skippedFor: new Map(),
    stored: 0,
    unprovable: 0,
    replays: newTally(),
    atEnd: newTally(),
    maxRecordBytes: 0,
    maxLedger: 0,
    maxLedgerBytes: 0,
    maxRoomTail: 0,
    maxTailBytes: 0,
    maxRoomBytes: 0,
    adopted: 0,
    skipped: 0,
    priorOf(wb, action, tab = null) {
      const writer = (row, col) => {
        const value = wb.rows[row]?.cells[col];
        const ids = oracle.sameValue.get(value) ?? [];
        if (ids.length < 2 || !tab) return oracle.byValue.get(value) ?? null;
        const own = tab.pending.findLast((request) => ids.includes(request.id))?.id;
        const kept = tab.held.flatMap((held) => held.frames).findLast((frame) => ids.includes(frame.e))?.e;
        const filed = oracle.gens.has(tab.gen) ? linear(oracle, { gen: tab.gen, through: tab.a }).findLast(([id, applied]) => applied && ids.includes(id))?.[0] : null;
        return own ?? kept ?? filed ?? oracle.byValue.get(value);
      };
      if (action.t === "set") return writer(action.row, action.col);
      if (action.t === "paste") return Object.fromEntries(action.cells.map(([row, col]) => [`${row}/${col}`, writer(row, col)]));
      if (action.t === "del") return oracle.byValue.get(`row:${action.row}`) ?? null;
      return null;
    },
    seenOf(wb, action) {
      if (action.t === "ins") return null;
      if (action.t === "del") return filledRef(wb.rows[action.row]);
      return Object.fromEntries(cellsOf(action).map(([row, col]) => [`${row}/${col}`, wb.rows[row]?.cells[col] ?? ""]));
    },
    onEdit(_, tab, id, action, prior, seen) {
      oracle.edits.set(id, { id, by: tab.id, action, prior, seen, at: oracle.edits.size, c: tab.client, n: tab.n, b: tab.born, wired: false });
      for (const [, , value] of cellsOf(action)) {
        if (value === "") continue;
        oracle.byValue.set(value, id);
        if (!oracle.sameValue.has(value)) oracle.sameValue.set(value, []);
        oracle.sameValue.get(value).push(id);
      }
      if (action.t === "ins") oracle.byValue.set(`row:${action.row}`, id);
      if (oracle.early.has(id)) oracle.onWire(_, tab, oracle.early.get(id));
    },
    onRekey(_, tab) {
      for (const request of tab.pending) Object.assign(oracle.edits.get(request.id), { c: tab.client, n: request.n, b: tab.born });
    },
    onWire(_, tab, frame) {
      const edit = oracle.edits.get(frame.e);
      if (!edit) return oracle.early.set(frame.e, frame);
      if (edit.by !== tab.id || edit.c !== frame.c || edit.n !== frame.n || edit.b !== frame.b) throw new Error(`P7 ${tab.id} sent ${frame.e} as request ${frame.n} of ${frame.c} born in epoch ${frame.b}, and ${edit.by} made it request ${edit.n} of ${edit.c} born in epoch ${edit.b}`);
      edit.wired = true;
    },
    onRequest(_, tab, io) {
      if (oracle.refusedTo.get(tab.id)?.has(io.etag)) throw new Error(`L1 ${tab.id} sent a ${io.kind} with ETag ${io.etag}, which the host had already refused to it`);
    },
    onAnswer(_, tab, io, status) {
      if (status === 200) return;
      if (!oracle.refusedTo.has(tab.id)) oracle.refusedTo.set(tab.id, new Set());
      oracle.refusedTo.get(tab.id).add(io.etag);
    },
    onReceipt(_, room, frame) {
      if (frame.gen !== room.gen) throw new Error(`G1 a receipt of generation ${frame.gen} was accepted by the room on ${room.gen}`);
      const commit = oracle.commits.get(frame.commit);
      if (!commit || commit.gen !== room.gen || commit.through !== frame.through) {
        throw new Error(`P1 the room accepted a receipt for ${frame.commit} through ${frame.through}, and ${commit ? `that commit is ${commit.gen}#${commit.through}` : "the host never accepted that commit"}`);
      }
    },
    onOtherBytes(theWorld, room, gen) {
      const now = parse(theWorld.host.body).record.gen;
      if (now !== gen) throw new Error(`H3 a write that changed no table moved the file from ${gen} to ${now}`);
      if (room && theWorld.room !== room) throw new Error(`H3 a write that changed no table ended the room on ${room.gen}`);
    },
    onFrame(theWorld, room, frame) {
      const ops = frameOps(frame);
      if (ops > theWorld.limits.opsPerFrame) throw new Error(`F1 a ${frame.k} frame with ${ops} operations reached the room, over the cap of ${theWorld.limits.opsPerFrame}`);
    },
    onRoom(theWorld, room) {
      if (!oracle.gens.has(room.gen)) throw new Error(`G0 a room opened for ${room.gen}, which no accepted commit established`);
      const { record } = parse(theWorld.host.body);
      if (record.gen !== room.gen || record.room !== room.id) throw new Error(`H1 room instance ${room.id} opened ${room.gen}, and the host file is on ${record.gen} for instance ${record.room}`);
    },
    onOffer(theWorld, tab, frame) {
      const mark = verdict(theWorld.host, frame.e)?.kind ?? null;
      if (Boolean(frame.open) !== (mark === "open")) throw new Error(`R11 ${tab.id} offered ${frame.e} of recovery copy ${frame.copy} as ${frame.open ? "an edit that waits for a decision" : "an edit with no open decision"}, and the decision record ${mark ? `lists it as ${mark}` : "does not list it"}`);
      if (frame.listed && !mark) throw new Error(`R11 ${tab.id} offered ${frame.e} of recovery copy ${frame.copy} as an edit that the decision record lists, and the record does not list it: a room would count it as refused with no mark while its row could still come back (rules 129 and 134)`);
    },
    onMark(theWorld, tab, mark) {
      const about = `${tab.id} wrote the mark ${mark.kind} for ${mark.e} of recovery copy ${mark.copy}`;
      if (!theWorld.host.decisions.some((one) => one.copy === mark.copy && one.e === mark.e && one.kind === mark.kind)) throw new Error(`R11 ${about} and took it as stored, and the host does not hold it`);
      if (![...oracle.jobCopy].some(([job, copy]) => copy === mark.copy && oracle.jobs.get(job).some((entry) => entry.e === mark.e))) throw new Error(`R11 ${about}, and no restore of that copy held that edit`);
      const facts = oracle.facts.get(mark.e) ?? new Set();
      if (!facts.has(mark.kind)) throw new Error(`R11 ${about}, and ${mark.kind === "open" || mark.kind === "refused" ? "no room left that edit waiting for a restore of that tab" : "no room answered that for it"}`);
    },
    onTake(_, tab, id, job, target, saw) {
      const from = oracle.edits.get(target);
      const choice = oracle.choices.get(job)?.get(target);
      if (!from || choice?.how !== "take") throw new Error(`R11 ${tab.id} made ${id} to take ${target} from a recovery copy, and no person decided to take that edit in restore job ${job}`);
      oracle.onEdit(_, tab, id, from.action, null, seenFrom(from.action, saw));
      oracle.takeOf.set(id, { e: target, job });
      oracle.tookBy.set(`${job}/${target}`, id);
      if (!oracle.takes.has(target)) oracle.takes.set(target, new Set());
      oracle.takes.get(target).add(id);
    },
    onCopyJudged(theWorld, room, frame, judged, by) {
      const id = frame.e;
      const info = oracle.gens.get(room.gen);
      const about = `the room of ${room.gen} judged ${id} from recovery copy ${frame.copy}`;
      const entry = checkOffer(theWorld, oracle, frame, about);
      const choice = checkChoice(oracle, frame, about);
      const edit = oracle.edits.get(id);
      const { how } = judged;
      const late = Boolean(judged.late);
      const evidence = { how };
      if (late) evidence.late = true;
      const key = `${room.gen}/${frame.job}`;
      const passes = oracle.passing.get(key) ?? [];
      const counted = (room.state.seen[entry.c]?.[0] ?? 0) >= entry.n;
      const stands = Math.max(room.state.seen[entry.c]?.[0] ?? 0, ...passes.filter((one) => one.c === entry.c && one.passed && one.n < entry.n).map((one) => one.n));
      if ((how === "refused") !== (entry.out === "refused")) throw new Error(`R3 ${about} as ${how}, and the copy stores it as ${entry.out}`);
      const fits = fitsRef(info.work, edit.action);
      const coming = fits ? null : rowToComeRef(oracle, { record: { gen: room.gen, epoch: room.epoch }, state: room.state }, info.work, edit.action, oracle.jobMade.get(frame.job));
      if (how === "refused") checkRefusal(`${about} as refused`, entry, judged, fits);
      const settled = info.ids.some((one, seq) => one === id && !info.open[seq] && !info.dup[seq]) || info.kept.has(id) || info.taken.has(id);
      const placed = placedRef({ record: { gen: room.gen, through: room.seq }, state: room.state }, entry);
      const byPlace = placed && !info.kept.has(id);
      if (late && !(frame.open && (byPlace || (counted && !settled)))) throw new Error(`R11 ${about} without the ledger, and ${!counted && !placed ? "the ledger does not count it and no place in the room's history covers it" : settled ? "the history of that room holds it, or a person's decision to keep the current value in its place" : "its offer does not name it as an edit that waits for a decision"}`);
      if (!late && frame.open && counted && !settled && how !== "saved" && how !== "refused") throw new Error(`R11 ${about} as ${how} by the ledger, and the decision record lists it as an edit that a restore passed over and no person has decided`);
      if (!late && frame.open && byPlace && !settled && how === "saved") throw new Error(`R11 ${about} as covered by a file position, and the decision record lists it as an edit that a restore passed over and no person has decided: its place in a lost room does not show that its value was written (rule 111)`);
      const gone = oracle.cutOut.has(id) || oracle.backedUp.has(id);
      const applied = info.result.get(id) === true;
      const taken = kinOf(oracle, id).some((one) => info.result.get(one) === true);
      const buried = (oracle.passedInRoom.get(id) ?? []).some((later) => info.done.has(later) || oracle.cutOut.has(later) || oracle.backedUp.has(later));
      if (how === "saved" || how === "resolved" || how === "replaced") {
        if (!info.done.has(id) && !gone && !oracle.everRefused.has(id) && !buried) throw new Error(`R3 ${about} as ${how}, and it is in neither the history of that room nor a version that a restore replaced, and no restore passed over it`);
        if (how === "replaced" && applied) throw new Error(`R9 ${about} as removed by a version restore, and the history of that room holds it as applied`);
      }
      if (how === "saved" || how === "resolved") {
        const here = holdsRef(info.work, edit.action);
        const found = how === "saved" ? "covered by a file position" : "counted";
        if (Boolean(judged.shown) !== here) throw new Error(`R9 ${about} as ${found} with its value ${judged.shown ? "in" : "not in"} the sheet, and the sheet ${here ? "holds" : "does not hold"} that value`);
        if (here && !applied && !taken) throw new Error(`R9 ${about} as ${found} with its value in the sheet, and the history of that room holds neither that edit nor a person's take of it as applied`);
        evidence.shown = here;
      }
      if (how === "resolved" && !late) {
        const cut = oracle.cuts.get(room.state.cut?.[0]);
        const since = entry.org ? epochOf(entry.org[0]) : entry.b;
        if (cut?.ids.has(id) && (cut.low[entry.c]?.[0] ?? 0) < entry.n && since > room.state.floor && since >= room.epoch - W) throw new Error(`R9 ${about} as counted, and the version restore that replaced ${room.state.cut[0]} removed it: the cut record is checked before the ledger`);
      }
      if (!late && (how === "conflict" || how === "held")) {
        if (info.done.has(id)) throw new Error(`R3 ${about} as new, and the history of that room already holds it`);
        if (gone) throw new Error(`R3 ${about} as new, and it is in a version that a restore replaced`);
      }
      if (how === "unjudged" && !whyLeft({ record: { gen: room.gen, epoch: room.epoch }, state: room.state }, entry, stands)) throw new Error(`R11 ${about} as an edit that cannot be judged, and the count of ${entry.c} stands at ${stands}, one below it, with a whole ledger: each stored edit is judged on its own, also after an earlier edit of its author was left for a person`);
      const waits = waitsIn(oracle, room, frame);
      const open = how === "held" || how === "conflict" || late;
      const ahead = open ? aheadOf(info.work, edit.action, openWaits(waits, room.state.seen, frame.i)) : null;
      if (how === "held" && judged.row) {
        if (ahead) throw new Error(`R10 ${about} as waiting for its row ${judged.row}, and ${whyWaits(ahead)}`);
        if (judged.row !== coming) throw new Error(`R10 ${about} as waiting for its row ${judged.row}, and ${coming ? `the row it waits for is ${coming}` : "its rows are in the sheet, or no insert of a missing row waits for the ledger to count it, or the room that could bring the row back has closed and a save came after it (rule 106)"}`);
        evidence.behind = null;
        evidence.row = coming;
        oracle.rowWaits.all++;
        if (info.turn) oracle.rowWaits.turned++;
        if (nearRoom(oracle, room.gen, oracle.jobMade.get(frame.job)[coming].src[0]) === "earlier") oracle.rowWaits.earlier++;
      } else if (how === "held") {
        if (!ahead) throw new Error(`R10 ${about} as held, and no earlier edit of that copy that the room left waiting creates a row it needs or writes a cell it writes`);
        if (judged.behind !== ahead.e) throw new Error(`R10 ${about} as held behind ${judged.behind}, and the edit it waits for is ${ahead.e}`);
        evidence.behind = ahead.e;
      } else if (ahead) {
        throw new Error(`R10 ${about} as ${how}, and ${whyWaits(ahead)}`);
      }
      noteWait(waits, entry, edit.action, how, frame.i);
      if (late && how !== "held") {
        const here = holdsRef(info.work, edit.action);
        const agreed = choice?.how === "take" && choice.looked && !unseen(info.work, { action: edit.action, seen: choice.looked }).length;
        const due = here ? "resolved" : coming ? "held" : !fits ? "misfit" : choice?.how === "keep" ? "kept" : agreed ? "take" : "conflict";
        if (how !== due) throw new Error(`R11 ${about}, which a restore had passed over, as ${how}, and ${here ? "the sheet holds its value" : coming ? whyComing(coming) : !fits ? "its rows are not in the sheet" : choice ? `a person decided to ${choice.how} it${choice.how === "take" ? (agreed ? " and every cell still holds the value that person reviewed" : " and a cell no longer holds the value that person reviewed") : ""}` : "no person has decided it"}`);
        if (how === "conflict") {
          const cells = lateRef(info.work, edit);
          if (JSON.stringify(judged.cells) !== JSON.stringify(cells)) throw new Error(`R8 ${about} as a conflict with cells that are not the current value next to the copy's value`);
          evidence.cells = cells;
        }
        if (how === "kept") {
          oracle.lateKept.add(id);
          info.kept.add(id);
        }
        if (how === "misfit") noteStop(oracle, room, info.work, id, oracle.jobMade.get(frame.job));
      }
      if (!late && how === "conflict") {
        if (choice?.how === "keep") throw new Error(`R10 ${about} as a conflict again, though a person decided to keep the current value: that decision is counted and writes nothing`);
        const clash = fits ? unseen(info.work, edit) : [];
        if (!clash.length) throw new Error(`R8 ${about} as a conflict, and every cell it writes still holds the value its author saw`);
        if (JSON.stringify(judged.cells) !== JSON.stringify(clash)) throw new Error(`R8 ${about} as a conflict with cells that are not the current value next to the copy's value in each cell that changed`);
        if (choice && !overUnseen(info.work, edit, choice).length) throw new Error(`R8 ${about} as a conflict again, though every cell it writes still holds the value the person reviewed before choosing the copy's value`);
        evidence.cells = clash;
      }
      const waiting = !late && (how === "conflict" || how === "held");
      if ((how === "refused" && entry.src) || waiting) oracle.passing.set(key, [...passes, { ...entry, passed: waiting || Boolean(judged.passed || judged.blocks), listed: waiting || Boolean(judged.passed || judged.blocks) }]);
      const closed = (how === "saved" || how === "resolved") && judged.shown ? "saved" : how === "resolved" && choice?.how === "keep" ? "kept" : late && (how === "kept" || how === "misfit") ? how : null;
      const fact = waiting ? "open" : how === "refused" ? (judged.passed || judged.blocks ? "refused" : null) : closed;
      if (fact) note(oracle.facts, id, fact);
      noteAnswer(oracle, room, by, frame, evidence);
      oracle.roomJudged[how] = (oracle.roomJudged[how] ?? 0) + 1;
    },
    onRemoved(tab, frame, cells) {
      const due = oracle.gens.get(tab.gen).removed.get(frame.seq) ?? [];
      if (JSON.stringify(cells) !== JSON.stringify(due)) throw new Error(`R9 ${tab.id} shows that the restored delete ${frame.e} removed ${cells.length} values its author did not see, and it removed ${due.length} (rules 87 and 105)`);
      if (due.length) oracle.removedLists.add(`${tab.gen}#${frame.seq}`);
      oracle.removedSeen.set(`${tab.id}/${frame.e}`, due);
      if (due.length && !tab.notices.some((one) => one.kind === "removed" && one.by === frame.e && JSON.stringify(one.cells) === JSON.stringify(due))) throw new Error(`R9 ${tab.id} applied the restored delete ${frame.e}, which removed ${due.length} values its author did not see, and shows no notice that lists them (rule 105)`);
    },
    onRemoval(theWorld, tab, entry) {
      const [gen, seq] = entry.at;
      const info = oracle.gens.get(gen);
      const due = info?.removed.get(seq) ?? [];
      const about = `${tab.id} recorded that ${entry.by} at ${gen}#${seq} removed ${entry.cells.length} values`;
      if (info?.ids[seq] !== entry.by || !due.length || JSON.stringify(entry.cells) !== JSON.stringify(due)) throw new Error(`R12 ${about}, and that frame removed ${info?.ids[seq] === entry.by ? due.length : "no"} values that its author did not see (rule 109)`);
      if ((oracle.savedThrough.get(gen) ?? -1) < seq) throw new Error(`R12 ${about}, and no accepted file holds that frame (rule 109)`);
      oracle.removalChecked++;
    },
    onUnlisted(theWorld, room, frame) {
      const info = oracle.gens.get(room.gen);
      const made = oracle.jobMade.get(frame.job);
      const edit = oracle.edits.get(frame.e);
      const about = `the room of ${room.gen} sent back ${frame.e} of recovery copy ${frame.copy} for a mark in the decision record`;
      if (frame.open || frame.listed) throw new Error(`R11 ${about}, and the offer says that the record lists that edit (rule 129)`);
      if (!edit || !rowsRef(edit.action).some((row) => !info.work.rows[row] && made?.[row])) throw new Error(`R11 ${about}, and no row of that edit is missing from the sheet with an insert that the copy names (rule 129)`);
      note(oracle.facts, frame.e, "open");
    },
    onReturned(theWorld, room, frame, item) {
      const info = oracle.gens.get(room.gen);
      const origin = oracle.gens.get(frame.from)?.origin[item.n];
      const edit = oracle.edits.get(item.e);
      const about = `the room of ${room.gen} sent back the adopt of ${frame.from}#${item.n} (${item.e}) for a mark in the decision record`;
      if (!origin || origin.e !== item.e || origin.copy !== item.origin[0]) throw new Error(`G3 ${about}, and that frame did not come from recovery copy ${item.origin[0]} (rule 104)`);
      const changed = !info.done.has(item.e) && fitsRef(info.work, edit.action) ? overUnseen(info.work, edit, lookedAt(origin)) : [];
      if (!changed.length) throw new Error(`G3 ${about}, and every cell it writes still holds the value it was judged against (rule 104)`);
      note(oracle.facts, item.e, "open");
      oracle.returned.sent++;
    },
    onKeepSeen(tab, id) {
      if (!oracle.gens.get(tab.gen).open[tab.a]) oracle.keepSeen.add(`${tab.id}/${id}`);
    },
    onRestoreStart(theWorld, tab, job, copyId) {
      oracle.jobs.set(job, storedCopy(theWorld, copyId).edits);
      oracle.jobCopy.set(job, copyId);
      oracle.jobMade.set(job, storedCopy(theWorld, copyId).about.made);
    },
    onRestored(theWorld, tab, notice) {
      const stored = { edits: oracle.jobs.get(notice.job) };
      const answers = oracle.answers.get(`${tab.gen}/${notice.job}`) ?? new Map();
      const about = `the restore notice of ${tab.id} for recovery copy ${notice.copy}`;
      const claims = new Map();
      const claim = (id, how) => {
        if (claims.has(id)) throw new Error(`R9 ${about} lists ${id} twice`);
        claims.set(id, how);
      };
      for (const id of notice.applied) claim(id, "applied");
      for (const id of notice.kept) claim(id, "kept");
      for (const id of notice.misfit) claim(id, "misfit");
      for (const { e } of notice.conflicts) claim(e, "conflict");
      for (const id of notice.saved) claim(id, "saved");
      for (const id of notice.replaced) claim(id, "replaced");
      for (const id of notice.counted) claim(id, "counted");
      for (const id of notice.refused) claim(id, "refused");
      for (const { e } of notice.held) claim(e, "held");
      for (const id of notice.left) claim(id, "unjudged");
      const named = notice.held.find((one) => one.row);
      if (named) throw new Error(`R9 ${about} lists ${named.e} as waiting for its row ${named.row}: an edit that waits for a row waits quietly, with the edits that stay in the copy (rule 106)`);
      const at = oracle.commits.get(oracle.live);
      const final = outcomesAt(oracle, at);
      const sheet = fromCanon(textAt(oracle, at));
      const open = new Map();
      const choices = oracle.choices.get(notice.job) ?? new Map();
      const lines = { applied: 0, kept: 0, misfit: 0, conflict: 0, saved: 0, replaced: 0, counted: 0, refused: 0, held: 0, unjudged: 0 };
      for (const [index, entry] of stored.edits.entries()) {
        const id = entry.e;
        const how = claims.get(id);
        const took = oracle.tookBy.get(`${notice.job}/${id}`);
        const landed = took !== undefined && [took, ...takesUnder(oracle, took)].some((one) => final.get(one) === true);
        const was = landed && (how === "applied" || !answers.has(index)) ? { how: "applied", late: true, removed: oracle.removedSeen.get(`${tab.id}/${took}`) ?? [] } : answers.get(index) ?? {};
        const line = was?.how === "saved" || was?.how === "resolved" ? (was.shown ? "saved" : "counted") : was?.how === "held" && was.row ? "unjudged" : was?.how;
        if (how !== line) throw new Error(`R9 ${tab.id} reports ${id} of recovery copy ${notice.copy} as ${how ?? "nothing"}, and the room of ${tab.gen} answered ${line ?? "nothing"} for it`);
        lines[how]++;
        const { action } = oracle.edits.get(id);
        const gone = oracle.cutOut.has(id) || oracle.backedUp.has(id);
        if (!was.late && (how === "applied" || how === "misfit") && final.get(id) !== (how === "applied") && !gone) throw new Error(`R9 ${tab.id} reports ${id} of recovery copy ${notice.copy} as ${how === "applied" ? "restored" : "refused by the room"}, and no accepted file holds that`);
        if (!was.late && how === "kept" && !(final.get(id) === false && oracle.declined.has(id)) && !gone) throw new Error(`R9 ${tab.id} reports ${id} of recovery copy ${notice.copy} as counted with the current value kept, and no accepted file counts it that way`);
        if (was.late && how === "kept" && !oracle.lateKept.has(id)) throw new Error(`R9 ${tab.id} reports ${id} of recovery copy ${notice.copy} as kept by a person's decision, and no room answered that`);
        const told = notice.removed.find((one) => one.e === id)?.cells ?? [];
        if (JSON.stringify(told) !== JSON.stringify(was.removed ?? [])) throw new Error(`R9 ${tab.id} reports that the restored delete ${id} of recovery copy ${notice.copy} removed ${told.length} values its author did not see, and it removed ${(was.removed ?? []).length}: a person who filled a cell after the delete was made must be able to see that the restore removed it`);
        const inTake = kinOf(oracle, id).some((one) => final.get(one) === true);
        if (how === "saved" && final.get(id) !== true && !inTake) throw new Error(`R9 ${tab.id} reports ${id} of recovery copy ${notice.copy} as saved, and the history of the accepted file holds neither it nor a person's take of it as applied`);
        const buriedGone = (oracle.passedInRoom.get(id) ?? []).some((later) => oracle.cutOut.has(later) || oracle.backedUp.has(later));
        if (how === "replaced" && (final.get(id) === true || !(gone || oracle.everRefused.has(id) || buriedGone))) throw new Error(`R9 ${tab.id} reports ${id} of recovery copy ${notice.copy} as removed by a version restore, and ${final.get(id) === true ? "the accepted file holds it as applied" : "no version restore removed it"}`);
        if (how === "counted" && holdsRef(sheet, action) && !inTake) throw new Error(`R9 ${tab.id} reports ${id} of recovery copy ${notice.copy} as counted and not in the sheet, and the accepted file holds its value`);
        if (how === "conflict") {
          const { cells } = notice.conflicts.find((one) => one.e === id);
          if (JSON.stringify(cells) !== JSON.stringify(was.cells)) throw new Error(`R9 ${tab.id} shows the conflict of ${id} of recovery copy ${notice.copy} with cells that are not the current value next to the copy's value that the room of ${tab.gen} found`);
          open.set(id, was.cells);
        }
        if (how === "held" && notice.held.find((one) => one.e === id).behind !== was.behind) throw new Error(`R9 ${tab.id} shows ${id} of recovery copy ${notice.copy} as held behind an insert that is not the one the room of ${tab.gen} named`);
        const choice = choices.get(id);
        if (!choice) continue;
        if (how === "kept") oracle.decisions.kept++;
        else if (how === "applied" && choice.how === "take") oracle.decisions.taken++;
        else if (how === "conflict") oracle.decisions.again++;
        else oracle.decisions.moot++;
      }
      if (claims.size !== stored.edits.length) throw new Error(`R9 ${about} lists ${claims.size} edits, and the copy stores ${stored.edits.length}`);
      if (JSON.stringify(notice.decided) !== JSON.stringify([...choices].map(([e, choice]) => [e, choice.how]))) throw new Error(`R9 ${about} names decisions that are not the ones the person made`);
      oracle.shown.set(notice.job, open);
      oracle.restored.jobs++;
      oracle.restored.edits += stored.edits.length;
      oracle.restored.left += lines.unjudged;
      for (const key of Object.keys(lines)) if (key !== "unjudged") oracle.restored[key] += lines[key];
    },
    onDecide(_, tab, job, from, picks) {
      const open = from.startsWith(`${tab.id}#`) ? oracle.shown.get(from) : null;
      if (!open) throw new Error(`R10 ${tab.id} decided on restore notice ${from}, which it never showed`);
      const choices = new Map();
      for (const [e, how] of picks) {
        if (!open.has(e)) throw new Error(`R10 ${tab.id} decided to ${how} ${e}, which its restore notice ${from} does not show as a conflict`);
        choices.set(e, { how, cells: open.get(e), looked: lookedRef(oracle.edits.get(e), open.get(e)) });
        oracle.decisions[how]++;
      }
      oracle.choices.set(job, choices);
      oracle.decisions.jobs++;
    },
    onAdmit(theWorld, room, frame, result, sent, by) {
      const info = oracle.gens.get(room.gen);
      if (frame.seq !== info.ids.length) throw new Error(`G0 ${room.gen} admitted action ${frame.seq} after ${info.ids.length - 1}`);
      if (sent.gen !== room.gen) throw new Error(`G1 a frame of generation ${sent.gen} was admitted into ${room.gen}`);
      if (frame.k === "adopt" && !provable(oracle, frame.from[0], room.gen)) {
        throw new Error(`G2 an action of ${frame.from[0]} was adopted into ${room.gen} across a restore or past the lineage window`);
      }
      const id = frameId(frame);
      const lost = frame.k === "adopt" && result.applied ? oracle.gaveUp.get(id) : null;
      if (lost) throw new Error(`R10 the room of ${room.gen} adopted the insert ${id} of row ${lost.row} that a tab brought back, after the room of ${lost.gen} refused ${lost.id} from a recovery copy because that row could no longer come back: the value waits while the room still adopts the insert (rules 106 and 124)`);
      const source = frame.k === "adopt" ? oracle.gens.get(frame.from[0]) : null;
      let origin = source?.origin[frame.from[1]] ?? null;
      let removedBy = [];
      if (frame.take) {
        const took = oracle.takeOf.get(id);
        const edit = oracle.edits.get(id);
        if (!took || took.e !== frame.take[2] || frame.copy || frame.k !== "act") throw new Error(`R11 ${room.gen}#${frame.seq} carries ${id} as a person's take of ${frame.take[2]}, and no person made that take`);
        const clash = unseen(info.work, edit);
        if (frame.keep && !clash.length) throw new Error(`R8 ${room.gen}#${frame.seq} counted ${id}, a person's take of ${took.e}, without writing it, and every cell it writes still holds the value that person reviewed`);
        if (!frame.keep && clash.length) throw new Error(`R8 ${room.gen}#${frame.seq} wrote ${id}, a person's take of ${took.e}, into ${clash[0][0]}/${clash[0][1]} over ${JSON.stringify(clash[0][2])}, a value that person did not review`);
        if (!frame.keep && fitsRef(info.work, edit.action)) note(oracle.facts, took.e, "taken");
        if (!frame.keep && !result.dup && !frame.open) info.taken.add(took.e);
        origin = { copy: frame.take[0], e: took.e, looked: null };
        removedBy = !frame.keep && fitsRef(info.work, edit.action) ? removedRef(info.work, edit) : [];
        info.removed.set(frame.seq, removedBy);
      }
      if (frame.copy) {
        const about = `the room of ${room.gen} took ${id} from recovery copy ${frame.copy[0]} as new`;
        const entry = checkOffer(theWorld, oracle, sent, about);
        if (!kept(entry)) throw new Error(`R3 ${about}, and the copy stores it as ${entry.out}`);
        if (info.done.has(id)) throw new Error(`R3 ${about}, and the history of that room already holds it`);
        if (oracle.cutOut.has(id) || oracle.backedUp.has(id)) throw new Error(`R3 ${about}, and it is in a version that a restore replaced`);
        const places = chain(entry).filter(([gen, seq], at, all) => all.findIndex((one) => one[0] === gen && one[1] === seq) === at);
        if (JSON.stringify(chain(frame)) !== JSON.stringify([...places.slice(0, 1), ...places.slice(1).slice(-W)])) throw new Error(`R3 ${about} with places ${JSON.stringify(chain(frame))}, and the copy stores ${JSON.stringify(chain(entry))}`);
        const edit = oracle.edits.get(id);
        const choice = checkChoice(oracle, sent, about);
        const fits = fitsRef(info.work, edit.action);
        const coming = fits || frame.keep ? null : rowToComeRef(oracle, { record: { gen: room.gen, epoch: room.epoch }, state: room.state }, info.work, edit.action, oracle.jobMade.get(sent.job));
        if (coming) throw new Error(`R10 ${about} and counted it as refused, and ${whyComing(coming)}`);
        const far = !fits && !frame.keep && noteStop(oracle, room, info.work, id, oracle.jobMade.get(sent.job));
        if (far && !theWorld.host.decisions.some((mark) => mark.e === id)) throw new Error(`R11 ${about} and counted it as refused while its row could still come back, before the decision record lists ${id}: a tab that was away would read that count as saved once the row is back (rule 129)`);
        const ahead = aheadOf(info.work, edit.action, openWaits(waitsIn(oracle, room, sent), room.state.seen, sent.i));
        noteWait(waitsIn(oracle, room, sent), entry, edit.action, "counted", sent.i);
        if (ahead) throw new Error(`R10 ${about} and counted it, and ${whyWaits(ahead)}`);
        const passes = oracle.passing.get(`${room.gen}/${sent.job}`) ?? [];
        const unlisted = passes.find((one) => one.listed && one.c === frame.c && one.n < frame.n && !theWorld.host.decisions.some((mark) => mark.e === one.e));
        if (unlisted) throw new Error(`R11 ${about} and counted it past ${unlisted.e}, which this restore had passed over, before the decision record lists ${unlisted.e}: a tab that was away would read that count as saved`);
        removedBy = fits && !frame.keep ? removedRef(info.work, edit) : [];
        info.removed.set(frame.seq, removedBy);
        if (frame.keep && choice?.how !== "keep") throw new Error(`R10 ${about} and counted it without writing it, and no person decided to keep the current value in its place`);
        if (!frame.keep && choice?.how === "keep" && fits) throw new Error(`R10 ${about} and wrote it, though a person decided to keep the current value`);
        const [clash] = fits && !frame.keep ? overUnseen(info.work, edit, choice) : [];
        if (clash) throw new Error(`R8 ${about} and wrote it into ${clash[0]}/${clash[1]} over ${JSON.stringify(clash[2])}, a value ${choice ? "that neither its author saw nor the person who chose the copy's value reviewed" : "its author did not see"}`);
        noteAnswer(oracle, room, by, sent, { how: frame.keep ? "kept" : fits ? "applied" : "misfit", removed: removedBy });
        note(oracle.facts, id, frame.keep ? "kept" : fits ? "saved" : "misfit");
        if (!frame.keep && fits && oracle.takeOf.has(id)) note(oracle.facts, oracle.takeOf.get(id).e, "taken");
        oracle.offered.add(id);
        for (const passed of passes) {
          if (passed.c === frame.c && passed.n < frame.n) oracle.passedInRoom.set(passed.e, [...(oracle.passedInRoom.get(passed.e) ?? []), id]);
        }
        oracle.roomJudged.taken = (oracle.roomJudged.taken ?? 0) + 1;
        origin = { copy: frame.copy[0], e: id, looked: choice?.how === "take" ? choice.looked ?? null : null };
      }
      if (frame.keep && !frame.copy && !frame.take && frame.k !== "adopt") throw new Error(`R10 ${room.gen}#${frame.seq} counts ${id} without writing it, and it is not a person's decision on a stored edit`);
      const buried = result.dup && !info.done.has(id) && (oracle.passedInRoom.get(id) ?? []).some((later) => info.done.has(later));
      if (source && frame.action) {
        const about = `the adopt of ${frame.from[0]}#${frame.from[1]} (${id})`;
        const edit = oracle.edits.get(id);
        const was = Boolean(source.declined[frame.from[1]]);
        const want = origin ? [origin.copy, origin.e] : null;
        if (JSON.stringify(frame.origin ?? null) !== JSON.stringify(want)) throw new Error(`G3 ${about} ${want ? `lost its origin, recovery copy ${want[0]}` : "names a recovery copy as its origin, and the frame it brings back did not come from one"}: a frame from a backup or a take keeps its origin when it returns from a lost room (rule 104)`);
        const again = Boolean(origin) && !was && !buried && !info.done.has(id);
        const skipped = again && planted("oracle-skips-returned-frames");
        const taken = again && origin.e !== id;
        const changed = !again || skipped ? [] : taken ? unseen(info.work, edit) : fitsRef(info.work, edit.action) ? overUnseen(info.work, edit, lookedAt(origin)) : [];
        const reopened = changed.length > 0 && !taken;
        if (again && !skipped) oracle.returned.judged++;
        if (changed.length) oracle.returned.kept++;
        if (!skipped && Boolean(frame.keep) !== (was || changed.length > 0)) {
          if (frame.keep) throw new Error(`G3 ${about} carries the mark of a decision to keep the current value, and no person declined it and every cell it was judged against still holds that value`);
          if (was) throw new Error(`G3 ${about} lost the mark of a person's decision to keep the current value`);
          throw new Error(`R8 ${about}, which recovery copy ${origin.copy} brought into a room that was lost before a save, was written into ${changed[0][0]}/${changed[0][1]} over ${JSON.stringify(changed[0][2])}, a value that ${taken ? "the person who took it did not review" : "neither its author saw nor a person reviewed"}: a frame from a backup or a take is judged again when it returns (rule 104)`);
        }
        if (reopened && !theWorld.host.decisions.some((mark) => mark.e === id && mark.kind !== "refused")) throw new Error(`R11 ${about} was counted without writing it, because a cell it was judged against has changed, before the decision record lists ${id}: a tab that was away would read that count as saved (rule 104)`);
        if (!skipped && Boolean(frame.open) !== (reopened || (was && Boolean(source.open[frame.from[1]])))) throw new Error(`G3 ${about} ${frame.open ? "is named" : "is not named"} as an edit that waits for a person's decision, and ${reopened ? "a cell it was judged against has changed" : "it did not return to a changed cell"}`);
        if (reopened) note(oracle.facts, id, "open");
        if (origin && !was && !buried && !info.done.has(id)) {
          removedBy = !frame.keep && fitsRef(info.work, edit.action) ? removedRef(info.work, edit) : [];
          info.removed.set(frame.seq, removedBy);
        }
      }
      if (frame.k === "act" && !frame.copy && sent.p < frame.n - 1) {
        const open = new Set(authorOf(theWorld, oracle.edits.get(id)).pending?.map((request) => request.id));
        for (const edit of oracle.edits.values()) {
          if (edit.c !== frame.c || edit.n <= sent.p || edit.n >= frame.n) continue;
          if (open.has(edit.id)) throw new Error(`R5 the room of ${room.gen} admitted request ${frame.n} of ${frame.c} after request ${sent.p}, and ${edit.id} in between is still an open request of its tab: the tab skipped it`);
          const refused = oracle.everRefused.has(edit.id);
          if (!refused && !verdict(theWorld.host, edit.id)) continue;
          if (!refused) oracle.skippedListed.add(edit.id);
          oracle.passedInRoom.set(edit.id, [...(oracle.passedInRoom.get(edit.id) ?? []), id]);
        }
      }
      const first = frame.k === "adopt" ? oracle.gens.get(frame.from[0])?.who[frame.from[1]] : frame.copy ? [sent.c, sent.n] : [oracle.edits.get(id)?.c, oracle.edits.get(id)?.n];
      if (first?.[0] !== frame.c || first[1] !== frame.n) throw new Error(`P7 ${room.gen}#${frame.seq} carries ${id} as request ${frame.n} of ${frame.c}, and ${frame.k === "adopt" ? `the room of ${frame.from[0]} admitted it` : "its tab made it"} as request ${first?.[1]} of ${first?.[0]}`);
      if (frame.action) {
        if (JSON.stringify(refAction(frame.action)) !== JSON.stringify(oracle.edits.get(id)?.action)) throw new Error(`P7 ${room.gen}#${frame.seq} carries an action that differs from the one ${id} authored`);
        if (actionBytes(frame.action) > theWorld.limits.actionBytes) throw new Error(`M4 ${id} is ${actionBytes(frame.action)} bytes, over the action cap of ${theWorld.limits.actionBytes}, and the room admitted it`);
        if (!sawAsSeen(oracle.edits.get(id), frame.saw)) throw new Error(`P7 ${room.gen}#${frame.seq} carries seen values for ${id} that differ from what its author's tab showed when the edit was made`);
      }
      if (frame.b !== undefined) throw new Error(`M1 ${room.gen}#${frame.seq} carries the birth epoch of its client to every tab: only a request and a stored own edit need it`);
      info.bytes.push(frameBytes(frame.action, frame));
      if (frame.k === "adopt" && !frame.action && !oracle.gens.get(frame.from[0]).dup[frame.from[1]]) {
        throw new Error(`G3 the adopt of ${frame.from[0]}#${frame.from[1]} (${id}) carried no action, and the reference did not skip that action as a duplicate`);
      }
      const step = !frame.action || buried ? { applied: false, dup: true } : frame.keep ? keepStep(info.done, id) : refStep(info.work, info.done, id, frame.action);
      info.ids.push(id);
      info.who.push([frame.c, frame.n]);
      info.applied.push(step.applied);
      info.dup.push(step.dup);
      info.declined.push(Boolean(frame.keep));
      info.origin.push(origin);
      info.open.push(Boolean(frame.open));
      if (!step.dup) info.result.set(id, step.applied);
      if (frame.keep && !step.dup) oracle.declined.add(id);
      if (step.applied) oracle.places.set(id, [...(oracle.places.get(id) ?? []), { at: [room.gen, frame.seq], c: frame.c, n: frame.n, saw: frame.saw ?? null }]);
      if (frame.keep && !step.dup && oracle.takeOf.has(id) && holdsRef(info.work, oracle.edits.get(id).action)) oracle.metItsValue.add(id);
      if (step.applied && oracle.takeOf.has(id)) for (const one of takesOf(oracle, id)) if (oracle.declined.has(one) && (!oracle.places.has(one) || info.result.get(one) === false)) oracle.metItsValue.add(one);
      info.at.push(canon(info.work));
      oracle.maxRoomTail = Math.max(oracle.maxRoomTail, room.seq - room.base.through);
      measureRoom(theWorld, oracle, room);
      if (step.applied !== result.applied || step.dup !== result.dup) {
        throw new Error(`P5 ${room.gen}#${frame.seq} ${id}: the reducer ${result.dup ? "skipped" : result.applied ? "applied" : "refused"} it, the reference ${step.dup ? "skips" : step.applied ? "applies" : "refuses"} it`);
      }
      if (step.dup) {
        oracle.skipped++;
        return;
      }
      if (frame.k === "adopt") oracle.adopted++;
      if (!step.applied && (frame.copy || frame.k === "adopt") && !frame.open) info.turned.set(id, frame.seq);
      if (frame.k === "adopt" && frame.open) info.reopened.set(id, frame.seq);
      const ownerTab = theWorld.tabs.find((tab) => tab.clients.has(frame.c));
      const shown = ownerTab ? ownerTab.edits.get(id).state : "pending";
      if (frame.k === "act" && !frame.copy && shown !== "pending") throw new Error(`R5 ${id} entered ${room.gen} as a new request while its tab shows it as ${shown}`);
      if (oracle.backedUp.has(id) || oracle.cutOut.has(id)) throw new Error(`R6 ${id} was in the room or the file that a restore replaced, and it entered ${room.gen} again`);
      if (step.applied) oracle.refused.delete(id);
      else oracle.refused.set(id, { gen: room.gen, seq: frame.seq });
      if (!step.applied) oracle.everRefused.set(id, { gen: room.gen, seq: frame.seq });
      if (step.applied) oracle.applied.add(id);
      oracle.delivered.set(id, { gen: room.gen, seq: frame.seq });
      if (!oracle.firstIn.has(id)) oracle.firstIn.set(id, room.gen);
      oracle.owed.delete(id);
    },
    onAccept(theWorld, body, kind) {
      const { record, state } = parse(body);
      const found = canon(state.wb);
      const before = oracle.commits.get(oracle.live);
      measureRecord(theWorld, oracle, record, state);
      if (kind === "establish") {
        const ledger = ledgerBytes(state.seen);
        if (ledger > ledgerMarks(theWorld.limits.ledgerCap).rotate) throw new Error(`M3 establishing commit ${record.commit} left a ledger of ${ledger} bytes, over the rotation mark`);
        if (record.parent !== oracle.live) throw new Error(`P2 establishing commit ${record.commit} extends ${record.parent}, and the live file is ${oracle.live}`);
        if (found !== textAt(oracle, before)) throw new Error(`P4 establishing commit ${record.commit} changed the tables`);
        oracle.gens.set(record.gen, newGenInfo("establish", before.gen, before, found, outcomesAt(oracle, before), record.room, oracle.gens.get(before.gen).room === record.room));
        oracle.commits.set(record.commit, { gen: record.gen, through: 0 });
        oracle.live = record.commit;
        return;
      }
      const info = oracle.gens.get(record.gen);
      if (!info || record.through >= info.ids.length) throw new Error(`P4 commit ${record.commit} names ${record.gen}#${record.through}, which was never admitted`);
      if (found !== info.at[record.through]) throw new Error(`P4 file ${record.commit} is not the workbook after ${record.through} actions of ${record.gen}`);
      if (before.gen !== record.gen || record.through < before.through) {
        throw new Error(`P2 commit ${record.commit} (${record.gen}#${record.through}) replaced the live file (${before.gen}#${before.through})`);
      }
      oracle.commits.set(record.commit, { gen: record.gen, through: record.through });
      oracle.live = record.commit;
      oracle.savedThrough.set(record.gen, record.through);
      for (let seq = 1; seq <= record.through; seq++) {
        const id = info.ids[seq];
        if (info.dup[seq] || oracle.saved.has(id)) continue;
        oracle.saved.set(id, record.commit);
        oracle.owed.delete(id);
      }
    },
    onBackup(theWorld, commit, room) {
      const info = oracle.gens.get(room.gen);
      oracle.backups.push({ commit, gen: room.gen, through: room.seq });
      checkBackup(theWorld, oracle, oracle.backups.at(-1));
      const { record } = storedVersion(theWorld, commit);
      oracle.commits.set(record.commit, { gen: room.gen, through: room.seq });
      for (let seq = 1; seq <= room.seq; seq++) if (!info.dup[seq] && !oracle.saved.has(info.ids[seq])) oracle.backedUp.add(info.ids[seq]);
    },
    onRestore(theWorld, body, { source, room, dirty, backup, patch }) {
      const { record, state } = parse(body);
      measureRecord(theWorld, oracle, record, state);
      const from = oracle.commits.get(source);
      const expected = fromCanon(textAt(oracle, from));
      let patched = null;
      if (patch) {
        const prior = oracle.priorOf(expected, patch.action);
        patched = refStep(expected, new Set(), patch.id, patch.action).applied;
        oracle.onEdit(theWorld, OUTSIDE, patch.id, patch.action, prior);
      }
      if (canon(state.wb) !== canon(expected)) throw new Error(`P4 outside write ${record.commit} is not version ${source}${patch ? ` with ${patch.id}` : ""}`);
      if (room && dirty && !backup) {
        const info = oracle.gens.get(room.gen);
        const lost = info.ids.filter((id, seq) => seq > 0 && info.applied[seq] && !oracle.saved.has(id));
        if (lost.length) throw new Error(`R1 restore discarded ${lost.length} shared edits (${lost.slice(0, 4).join(", ")}) with no backup`);
      }
      const kept = outcomesAt(oracle, from);
      const before = outcomesAt(oracle, oracle.commits.get(oracle.live));
      for (const [id, applied] of kept) if (applied && before.get(id) !== true && shownRefused(theWorld, oracle, id)) oracle.broughtBack.add(id);
      const removed = new Set();
      for (const id of outcomesAt(oracle, oracle.commits.get(oracle.live)).keys()) if (!kept.has(id)) removed.add(id);
      for (const id of removed) oracle.cutOut.add(id);
      if (room) for (const id of oracle.gens.get(room.gen).ids.slice(1)) if (!kept.has(id)) removed.add(id);
      oracle.cuts.set(room?.gen ?? oracle.commits.get(oracle.live).gen, { ids: removed, low: storedVersion(theWorld, source).state.seen });
      for (const id of kept.keys()) {
        if (!oracle.saved.has(id)) oracle.saved.set(id, record.commit);
        oracle.owed.delete(id);
      }
      if (patch) {
        kept.set(patch.id, patched);
        oracle.saved.set(patch.id, record.commit);
        if (patched) oracle.applied.add(patch.id);
      }
      const info = newGenInfo("restore", null, from, canon(state.wb), kept, record.room);
      if (patch) info.pre.push([patch.id, patched]);
      oracle.gens.set(record.gen, info);
      oracle.commits.set(record.commit, { gen: record.gen, through: 0 });
      oracle.live = record.commit;
    },
    onRoomLoss(theWorld, room, why) {
      const info = oracle.gens.get(room.gen);
      for (let seq = 1; seq < info.ids.length; seq++) {
        const id = info.ids[seq];
        if (info.dup[seq] || !info.applied[seq] || oracle.saved.has(id) || oracle.backedUp.has(id)) continue;
        if (oracle.delivered.get(id)?.gen !== room.gen) continue;
        if (why === "expired") throw new Error(`H2 the host expired room ${room.id} on ${room.gen} while it held ${id}, which is in no accepted file`);
        const holders = theWorld.tabs.filter((tab) => tab.alive && (holds(oracle, tab, id) || shows(oracle, tab, id)));
        if (holders.length) oracle.owed.set(id, new Set(holders));
        else oracle.witnessed.add(id);
      }
    },
    onCopyWrite(_, tab, copyId) {
      if (oracle.copies.has(copyId)) throw new Error(`R4 ${tab.id} wrote recovery copy ${copyId} again after its bytes were confirmed: a stored copy is never overwritten`);
    },
    onRecoveryCopy(theWorld, tab, copyId, ids, refused) {
      const stored = storedCopy(theWorld, copyId);
      if (!stored) throw new Error(`R4 ${tab.id} shows a notice for recovery copy ${copyId}, and the host holds no such copy`);
      const built = oracle.built.get(copyId);
      if (provable(oracle, stored.from, built.now) && !(stored.reason === "retired" && retiredFor(stored, built))) {
        throw new Error(`R2 ${tab.id} wrote recovery copy ${copyId} (${stored.reason}), though its generation ${stored.from} is in the lineage of ${built.now}`);
      }
      const known = oracle.copies.get(copyId) ?? { id: copyId, by: stored.by, reason: stored.reason, from: stored.from, listed: [], edits: [] };
      known.listed.push(...ids);
      oracle.copies.set(copyId, known);
      const apart = ids.filter((id) => stored.edits.some((entry) => entry.e === id && !kept(entry)));
      const missing = apart.filter((id) => !refused.includes(id));
      const closed = (id) => ["kept", "misfit", "refused"].some((kind) => oracle.facts.get(id)?.has(kind));
      const extra = refused.filter((id) => !apart.includes(id) && !oracle.everRefused.has(id) && !oracle.keptApart.has(id) && !closed(id));
      for (const id of apart) oracle.keptApart.add(id);
      if (missing.length || extra.length) throw new Error(`R3 the notice of ${tab.id} for recovery copy ${copyId} labels ${refused.length} of its edits as refused, and ${missing.length ? `the stored copy holds ${missing.slice(0, 3).join(", ")} as refused too: a restore never applies those` : `no room refused ${extra.slice(0, 3).join(", ")} and the copy stores it as an edit a restore can apply`}`);
      for (const id of ids) {
        const state = tab.edits.get(id)?.state;
        if (state === (refused.includes(id) ? "recovered" : "kept-refused")) throw new Error(`R3 ${tab.id} shows ${id} as ${state}, and its notice for recovery copy ${copyId} lists it as ${refused.includes(id) ? "refused" : "an edit a restore can apply"}`);
      }
      if (!oracle.commits.has(stored.onto)) throw new Error(`R3 recovery copy ${copyId} names file ${stored.onto}, which the host never accepted`);
      checkCopy(theWorld, oracle, known);
      const file = storedVersion(theWorld, stored.onto);
      const history = outcomesAt(oracle, oracle.commits.get(stored.onto));
      for (const entry of stored.edits) {
        if (known.edits.includes(entry.e)) continue;
        known.edits.push(entry.e);
        oracle.stored++;
        const at = kept(entry) ? coveredIn(file, entry) : null;
        if (at) throw new Error(`R7 recovery copy ${copyId} stores ${entry.e}, and the lineage of the file it was judged against (${stored.onto}) already covers ${at[0]}#${at[1]}, where a room admitted that edit`);
        if (kept(entry) && history.get(entry.e)) oracle.unprovable++;
        if (kept(entry) || stored.reason === "restore-misfit") oracle.recovered.set(entry.e, copyId);
        oracle.owed.delete(entry.e);
      }
      checkReplay(theWorld, oracle, known, stored.onto, oracle.replays, (id) => built.replaced.has(id), true);
    },
    onJudgeHeld(_, tab) {
      const skipped = new Set();
      for (const held of tab.held) {
        const info = oracle.gens.get(held.gen);
        const here = new Set();
        for (const frame of held.frames) {
          const id = info.ids[frame.seq];
          if (info.dup[frame.seq] && !here.has(id)) skipped.add(id);
          here.add(id);
        }
      }
      oracle.skippedFor.set(tab.id, skipped);
    },
    onCopyBuilt(theWorld, tab, about) {
      const now = theWorld.room?.gen ?? oracle.commits.get(oracle.live).gen;
      oracle.built.set(about.recovery, { now, state: parse(theWorld.host.body).state, adoptRefused: new Set(oracle.adoptRefused), replaced: new Set([...oracle.cutOut, ...oracle.backedUp]) });
      for (const entry of about.edits) {
        if (!entry.src || entry.out === "refused") continue;
        const from = `${entry.e} of ${entry.src[0]}#${entry.src[1]} in recovery copy ${about.recovery}`;
        if (oracle.skippedFor.get(tab.id)?.has(entry.e)) throw new Error(`R7 ${tab.id} stores ${from}, though a later generation it holds had skipped that edit as already resolved`);
        if (entry.src[0] !== tab.gen && (tab.state.seen[entry.c]?.[0] ?? 0) >= entry.n) throw new Error(`R7 ${tab.id} stores ${from}, though its own generation ${tab.gen} had already resolved that request`);
      }
    },
    onReturnCount(theWorld, kind) {
      theWorld.returned[kind]++;
    },
    onAdoptRefused(_, room, frame, item) {
      if (item.c in room.state.seen || room.state.floor <= epochOf(frame.from)) throw new Error(`G2 ${room.gen} refused the adopt of ${frame.from}#${item.n} as retired, and its ledger can still judge it`);
      oracle.adoptRefused.add(`${frame.from}>${room.gen}`);
    },
    onHomeless(_, tab, id) {
      const edit = oracle.edits.get(id);
      const rows = cellsOf(edit.action).map(([row]) => row);
      if (!rows.some((row) => removed(oracle, row))) throw new Error(`R3 ${tab.id} dropped ${id} as an edit with no row left, and no admitted action deleted a row it writes (${rows.slice(0, 4).join(", ")})`);
      const notice = tab.notices.findLast((one) => one.kind === "refused" && one.edits.includes(id));
      if (!notice || JSON.stringify(refAction(notice.action)) !== JSON.stringify(edit.action)) throw new Error(`R3 ${tab.id} dropped ${id} as an edit with no row left, with no notice that carries the action`);
      if (!oracle.homeless.has(id)) oracle.homeless.set(id, new Set());
      oracle.homeless.get(id).add(tab.id);
      oracle.owed.get(id)?.delete(tab);
    },
  };
  return oracle;
}

function storedCopy(world, copyId) {
  const stored = world.host.recoveries.find((one) => one.id === copyId);
  if (!stored) return null;
  if (!stored.body.endsWith("</script>")) throw new Error(`R4 the stored bytes of recovery copy ${copyId} are cut short`);
  const { record, wb } = readPage(stored.body);
  return { ...record, about: record, edits: record.edits ?? [], preview: wb };
}

function storedVersion(world, commit) {
  const stored = world.host.versions.find((version) => version.commit === commit);
  if (!stored) throw new Error(`R1 the host holds no version ${commit}`);
  return parse(stored.body);
}

function checkBackup(world, oracle, backup) {
  const { state } = storedVersion(world, backup.commit);
  if (canon(state.wb) !== oracle.gens.get(backup.gen).at[backup.through]) throw new Error(`R1 the stored backup ${backup.commit} is not the room's workbook at ${backup.gen}#${backup.through}`);
}

function retiredFor(stored, { now, state, adoptRefused }) {
  if (adoptRefused.has(`${stored.from}>${now}`)) return true;
  const { client, born } = stored.about;
  return client !== undefined && !(client in state.seen) && born <= state.floor;
}

function measureRecord(world, oracle, record, state) {
  const bytes = recordBytes(record, state);
  const budget = recordBudget(world.limits.ledgerCap, W);
  oracle.maxRecordBytes = Math.max(oracle.maxRecordBytes, bytes);
  oracle.maxLedger = Math.max(oracle.maxLedger, Object.keys(state.seen).length);
  if (bytes > budget) throw new Error(`M2 commit record ${record.commit} is ${bytes} bytes, over its budget of ${budget}`);
  const ledger = ledgerBytes(state.seen);
  oracle.maxLedgerBytes = Math.max(oracle.maxLedgerBytes, ledger);
  if (ledger > world.limits.ledgerCap) throw new Error(`M2 the request ledger in ${record.commit} is ${ledger} bytes, over its cap of ${world.limits.ledgerCap}`);
}

const removed = (oracle, row) => [...oracle.applied].some((id) => oracle.edits.get(id)?.action.t === "del" && oracle.edits.get(id).action.row === row);

function measureRoom(world, oracle, room) {
  const info = oracle.gens.get(room.gen);
  const reserve = stateReserve(world.limits);
  let tail = 0;
  for (let seq = room.base.through + 1; seq <= room.seq; seq++) tail += info.bytes[seq];
  let extra = 0;
  for (const stage of room.staging.values()) extra += stage.size;
  for (const waiting of room.wait.values()) for (const entry of waiting.values()) extra += frameBytes(entry.frame.action, { saw: entry.frame.saw });
  oracle.maxTailBytes = Math.max(oracle.maxTailBytes, tail);
  oracle.maxRoomBytes = Math.max(oracle.maxRoomBytes, reserve + tail + extra);
  if (reserve + tail > world.limits.storeBytes) throw new Error(`M1 the room store holds ${reserve + tail} bytes (${room.seq - room.base.through} unsaved actions), over its cap of ${world.limits.storeBytes}`);
  if (reserve + tail + extra > world.limits.roomBytes) throw new Error(`M1 the room holds ${reserve + tail + extra} bytes with its staged and waiting frames, over its cap of ${world.limits.roomBytes}`);
}

const chain = (entry) => [entry.org, ...(entry.via ?? []), entry.src].filter(Boolean);

const kept = (entry) => entry.out !== "refused" && entry.out !== "counted";

const coveredIn = ({ record, state }, entry) =>
  chain(entry).find(([gen, seq]) => (record.gen === gen ? record.through : state.lineage.find(([one]) => one === gen)?.[1] ?? -1) >= seq) ?? null;

const outcomeAt = (oracle, [gen, seq]) => {
  const info = oracle.gens.get(gen);
  return info?.ids[seq] === undefined ? null : info.dup[seq] ? "skipped" : info.applied[seq] ? "applied" : "refused";
};

function checkCopy(world, oracle, known) {
  const stored = storedCopy(world, known.id);
  if (!stored) throw new Error(`R4 the host no longer holds recovery copy ${known.id}`);
  const ids = new Set();
  const last = new Map();
  const ordered = stored.reason !== "restore-misfit";
  let newest = Infinity;
  let own = false;
  for (const entry of stored.edits) {
    const edit = oracle.edits.get(entry.e);
    if (!edit) throw new Error(`R3 the stored recovery copy ${known.id} holds ${entry.e}, which no tab authored`);
    if (ids.has(entry.e)) throw new Error(`R3 the stored recovery copy ${known.id} holds ${entry.e} twice`);
    ids.add(entry.e);
    if (JSON.stringify(refAction(entry.action)) !== JSON.stringify(edit.action)) throw new Error(`R3 the stored recovery copy ${known.id} holds an action for ${entry.e} that differs from the one its tab authored`);
    if (!sawAsSeen(edit, entry.saw)) throw new Error(`R3 the stored recovery copy ${known.id} stores seen values for ${entry.e} that differ from what its author's tab showed when the edit was made`);
    const name = world.tabs.find((tab) => tab.id === edit.by)?.name ?? null;
    if (entry.c in (stored.about.names ?? {}) ? stored.about.names[entry.c] !== name : name !== null) throw new Error(`R3 the stored recovery copy ${known.id} names ${JSON.stringify(stored.about.names?.[entry.c])} as the author of ${entry.e}, and ${edit.by} made it as ${JSON.stringify(name)}`);
    for (const [gen, seq] of chain(entry)) {
      if (oracle.gens.get(gen)?.ids[seq] !== entry.e) throw new Error(`R3 the stored recovery copy ${known.id} names ${gen}#${seq} as a source of ${entry.e}, and the room did not admit that edit there`);
    }
    const about = `the stored recovery copy ${known.id} stores ${entry.e} as request ${entry.n} of ${entry.c}`;
    if (entry.src) {
      const [gen, seq] = entry.src;
      const [c, n] = oracle.gens.get(gen).who[seq];
      if (entry.c !== c || entry.n !== n) throw new Error(`R3 ${about}, and the room admitted it at ${gen}#${seq} as request ${n} of ${c}`);
      const was = outcomeAt(oracle, entry.src);
      if (entry.out !== was) throw new Error(`R3 the stored recovery copy ${known.id} stores ${entry.e} as ${entry.out} at ${gen}#${seq}, and the room ${was} it there`);
      if (seq <= (last.get(gen) ?? 0)) throw new Error(`R3 the stored recovery copy ${known.id} stores ${entry.e} of ${gen}#${seq} after action ${last.get(gen)} of that generation`);
      last.set(gen, seq);
      if (ordered && (own || epochOf(gen) > newest)) throw new Error(`R3 the stored recovery copy ${known.id} stores ${entry.e} of ${gen}#${seq} after ${own ? "an edit that no room admitted" : "an edit of an older generation"}`);
      if (ordered) newest = epochOf(gen);
    } else if (edit.by !== stored.by || entry.c !== edit.c || entry.n !== edit.n || entry.b !== edit.b) {
      throw new Error(`R3 ${about} born in epoch ${entry.b} with no source, and ${edit.by} made it request ${edit.n} of ${edit.c} born in epoch ${edit.b}`);
    } else if ((entry.out === "unsent") === edit.wired) {
      throw new Error(`R3 ${about} as ${entry.out}, and its tab ${edit.wired ? "sent it to a room" : "never sent it"}`);
    } else if (entry.out === "unsent") {
      own = true;
      if (oracle.delivered.has(entry.e) && !oracle.offered.has(entry.e)) throw new Error(`R3 the stored recovery copy ${known.id} stores ${entry.e} as never sent, and ${oracle.delivered.get(entry.e).gen} admitted it`);
    } else if (entry.out === "counted") {
      if (!oracle.commits.has(entry.file)) throw new Error(`R3 the stored recovery copy ${known.id} stores ${entry.e} as counted by file ${entry.file}, which the host never accepted`);
      const at = oracle.commits.get(entry.file);
      const outcomes = outcomesAt(oracle, at);
      const resolved = outcomes.has(entry.e) || (oracle.passedInRoom.get(entry.e) ?? []).some((later) => outcomes.has(later));
      const fits = cellsOf(edit.action).every(([row]) => fromCanon(textAt(oracle, at)).rows[row]);
      if (!resolved || fits) throw new Error(`R3 the stored recovery copy ${known.id} stores ${entry.e} as counted by file ${entry.file}, and that file ${resolved ? "has room for it" : "never resolved it"}`);
    } else if (entry.out !== "unanswered") {
      throw new Error(`R3 the stored recovery copy ${known.id} stores ${entry.e} as ${entry.out} with no source`);
    } else {
      own = true;
    }
  }
  for (const id of known.listed) if (!ids.has(id)) throw new Error(`R3 the stored recovery copy ${known.id} does not hold ${id}, which a notice lists`);
  const apart = stored.edits.filter((entry) => !kept(entry)).map((entry) => entry.e);
  if (JSON.stringify(stored.about.refused) !== JSON.stringify(apart)) throw new Error(`R3 the stored recovery copy ${known.id} labels ${stored.about.refused?.length} edits as stored refused, and it holds ${apart.length} such edits`);
  const base = oracle.gens.get(stored.at?.[0])?.at[stored.at[1]];
  if (base === undefined) throw new Error(`R3 the stored recovery copy ${known.id} names a base document that no room ever had`);
  const expected = fromCanon(base);
  for (const entry of stored.edits) if (kept(entry)) refStep(expected, new Set(), entry.e, oracle.edits.get(entry.e).action);
  if (canon(stored.preview) !== canon(expected)) throw new Error(`R3 the preview of stored recovery copy ${known.id} is not the document at ${stored.at[0]}#${stored.at[1]} with its stored edits`);
  for (const [row, one] of Object.entries(stored.about.made ?? {})) {
    const edit = oracle.edits.get(one.e);
    if (edit?.action.t !== "ins" || edit.action.row !== row || edit.c !== one.c || oracle.gens.get(one.src[0])?.ids[one.src[1]] !== one.e) throw new Error(`R3 the stored recovery copy ${known.id} names ${one.e} at ${one.src.join("#")} as the insert of its row ${row}, and the room admitted no such insert there`);
  }
  return stored;
}

function checkOffer(world, oracle, frame, about) {
  const entry = oracle.jobs.get(frame.job)?.[frame.i];
  const same = entry && JSON.stringify(frame.made ?? null) === JSON.stringify(madeOf(oracle.jobMade.get(frame.job), entry.action)) && ["e", "c", "n", "out"].every((key) => entry[key] === frame[key]) && ["action", "saw", "src", "org", "via"].every((key) => JSON.stringify(entry[key] ?? null) === JSON.stringify(frame[key] ?? null));
  if (!same) throw new Error(`R3 ${about}, and the stored copy does not hold that edit in place ${frame.i} with that identity, action and seen values`);
  return entry;
}

function checkChoice(oracle, frame, about) {
  const made = oracle.choices.get(frame.job)?.get(frame.e) ?? null;
  const failed = !frame.decide && made?.how === "take" && oracle.tookBy.has(`${frame.job}/${frame.e}`);
  const choice = failed ? null : made;
  if ((frame.decide ?? null) !== (choice?.how ?? null)) throw new Error(`R10 ${about} with ${frame.decide ? `a decision to ${frame.decide}` : "no decision"}, and the person ${choice ? `decided to ${choice.how}` : "made no decision on it"}`);
  return choice;
}

function checkRefusal(about, entry, judged, fits) {
  if (judged.passed && fits) throw new Error(`R10 ${about} and passed over it, and its rows are in the sheet: a room would not refuse it now, so the refusal of a lost room is not a fact about this file`);
  if (judged.blocks && !(entry.src && fits)) throw new Error(`R10 ${about} and left its author waiting behind it, and ${entry.src ? "a room would refuse it now as well" : "the copy stores no place for that refusal"}`);
}

function waitsIn(oracle, room, frame) {
  const key = `${room.gen}/${frame.job}`;
  if (!oracle.waits.has(key)) oracle.waits.set(key, newWaits());
  return oracle.waits.get(key);
}

function noteAnswer(oracle, room, by, frame, evidence) {
  const key = `${room.gen}/${frame.job}`;
  if (!frame.job.startsWith(`${by}#`)) throw new Error(`R9 ${by} sent an edit of restore job ${frame.job}, which is not its own`);
  if (!oracle.answers.has(key)) oracle.answers.set(key, new Map());
  const answers = oracle.answers.get(key);
  const was = answers.get(frame.i);
  if (!was || was.how === "take" || (oracle.decidedAnswers.has(was) && !frame.decide)) answers.set(frame.i, evidence);
  if (frame.decide) oracle.decidedAnswers.add(evidence);
}

const sameLedger = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

const sortedMarks = (marks) => JSON.stringify([...marks].sort(([a], [b]) => (a < b ? -1 : 1)));

function checkHeld(about, id, decision, ahead, coming, view, tally) {
  if (decision.row) {
    if (ahead) throw new Error(`R10 ${about} left ${id} waiting for its row ${decision.row}, and ${whyWaits(ahead)}`);
    if (decision.row !== coming) throw new Error(`R10 ${about} left ${id} waiting for its row ${decision.row}, and ${coming ? `the row it waits for is ${coming}` : "its rows are in the sheet, or no insert of a missing row waits for the ledger to count it"}`);
    tally.row++;
    return;
  }
  if (!ahead) throw new Error(`R10 ${about} held ${id}, and no earlier edit of the copy that the replay left waiting creates a row it needs or writes a cell it writes`);
  if (decision.behind !== ahead.e) throw new Error(`R10 ${about} held ${id} behind ${decision.behind}, and the edit it waits for is ${ahead.e}`);
  if (!ahead.row) tally.order++;
}

const placedRef = ({ record, state }, entry) => [entry.org, ...(entry.via ?? []), entry.src].some((at) => at && (record.gen === at[0] ? record.through : state.lineage.find(([gen]) => gen === at[0])?.[1] ?? -1) >= at[1]);

function foldReplay(oracle, about, copy, file, ctx, tally, choices = null, marks = new Map()) {
  const offered = choices && new Map([...choices].map(([e, choice]) => [e, choice.how === "take" ? { decide: "take", reviewed: reviewed(codecAction(oracle.edits.get(e).action), copy.edits.find((entry) => entry.e === e).saw, choice.cells) } : { decide: "keep" }]));
  const result = replay(codecFile(file), copy, offered, marks);
  const expected = { wb: fromCanon(canon(file.state.wb)), seen: structuredClone(file.state.seen) };
  const { held, gone, before, writers } = ctx;
  const passed = new Map();
  const waits = newWaits();
  const record = new Map(marks);
  const clashes = new Map();
  const took = [];
  const write = (id, action) => {
    refStep(expected.wb, new Set(), id, action);
    if (action.t === "del") for (const key of [...writers.keys()]) if (key.startsWith(`${action.row}/`)) writers.delete(key);
  };
  for (const [index, decision] of result.decisions.entries()) {
    const { e: id, how } = decision;
    const entry = copy.edits[index];
    const { c, n, out, src } = entry;
    const edit = oracle.edits.get(id);
    const { action } = edit;
    const choice = choices?.get(id) ?? null;
    const late = Boolean(decision.late);
    tally[how]++;
    if (late) tally.late++;
    const replaced = gone(id);
    const counted = (expected.seen[c]?.[0] ?? 0) >= n;
    const stands = Math.max(expected.seen[c]?.[0] ?? 0, passed.get(c) ?? 0);
    const fits = fitsRef(expected.wb, action);
    const target = { record: file.record, state: { floor: file.state.floor, lineage: file.state.lineage, seen: expected.seen } };
    const later = fits ? null : rowToComeRef(oracle, target, expected.wb, action, copy.made, () => false);
    const coming = decision.row && decision.row === later ? later : fits ? null : rowToComeRef(oracle, target, expected.wb, action, copy.made, gone);
    const open = record.get(id) === "open";
    const placed = placedRef(file, entry);
    if (late && !((counted || placed) && open)) throw new Error(`R11 ${about} judged ${id} without the ledger, and ${counted || placed ? "the decision record does not list it as open" : "the ledger does not count it and no file position covers it"}`);
    if (!late && open && how === "saved") throw new Error(`R11 ${about} reports ${id} as covered by a file position, and the decision record lists it as an edit that a restore passed over and no person has decided: its place in a lost room does not show that its value was written (rule 111)`);
    if (!late && counted && open && how !== "saved" && how !== "refused") throw new Error(`R11 ${about} reports ${id} as ${how} by the ledger, and the decision record lists it as an edit that a restore passed over and no person has decided`);
    if (how === "refused") {
      checkRefusal(`${about} skipped ${id} as refused`, entry, decision, fits);
      before.refused.add(id);
      if (src && stands === n - 1 && wholeRef(file, entry)) {
        passed.set(c, n);
        if (!record.has(id)) record.set(id, "refused");
      }
    }
    if (how === "unjudged" && !whyLeft(file, entry, stands)) throw new Error(`R11 ${about} left ${id} as an edit that cannot be judged, and the count of ${c} stands at ${stands}, one below it, with a whole ledger: each stored edit is judged on its own, also after an earlier edit of its author was left for a person`);
    const judged = how === "applied" || how === "misfit" || how === "conflict" || how === "held" || how === "kept";
    const ahead = judged || late ? aheadOf(expected.wb, action, openWaits(waits, expected.seen, index)) : null;
    noteWait(waits, { e: id, c, n }, action, how, index);
    if (late) {
      if (how === "held") {
        checkHeld(about, id, decision, ahead, coming, copy.at, tally);
        continue;
      }
      if (ahead) throw new Error(`R10 ${about} judged ${id} as ${how}, and ${whyWaits(ahead)}`);
      const here = holdsRef(expected.wb, action);
      const agreed = choice?.how === "take" && choice.looked && !unseen(expected.wb, { action, seen: choice.looked }).length;
      const due = here ? "resolved" : coming ? "held" : !fits ? "misfit" : choice?.how === "keep" ? "kept" : agreed ? "applied" : "conflict";
      if (how !== due) throw new Error(`R11 ${about} reports ${id}, which a restore had passed over, as ${how}, and it is due as ${due}`);
      if (how === "conflict") {
        const cells = lateRef(expected.wb, edit);
        if (JSON.stringify(decision.cells) !== JSON.stringify(cells)) throw new Error(`R8 ${about} reports the conflict of ${id} with cells that are not the current value next to the copy's value`);
        clashes.set(id, cells);
        continue;
      }
      record.set(id, how === "applied" ? "taken" : how === "resolved" ? "saved" : how);
      before.closed.add(id);
      if (how === "applied") {
        write(id, action);
        for (const [at, col, value] of cellsOf(action)) writers.set(`${at}/${col}`, [id, value]);
      }
      if (how === "applied" || how === "kept") took.push([id, how === "applied" ? "taken" : "kept"]);
      continue;
    }
    if (how === "saved" || how === "resolved" || how === "replaced") {
      const passedBy = how !== "saved" && (before.closed.has(id) || before.passed.has(id) || (before.refused.has(id) && (before.taken.get(c) ?? 0) > n) || (oracle.passedInRoom.get(id) ?? []).some((later) => held.has(later) || gone(later)));
      const closed = how === "saved" && ["saved", "kept", "misfit", "taken"].includes(record.get(id));
      if (!held.has(id) && !replaced && !passedBy && !closed) throw new Error(`R3 ${about} skipped ${id} as ${how}, and it is in neither that file's history nor a version that a restore replaced, and no room or restore took a later request of ${c} after it passed over ${id}, and the decision record does not list it as closed`);
      if (how !== "replaced" && Boolean(decision.shown) !== holdsRef(expected.wb, action)) throw new Error(`R9 ${about} reports ${id} as ${how === "saved" ? "covered by a file position" : "counted"} with its value ${decision.shown ? "in" : "not in"} the sheet, and that is not what the document holds`);
      if (how === "resolved" && decision.shown) tally.shown++;
      continue;
    }
    if (!judged) continue;
    if (held.has(id)) throw new Error(`R3 ${about} took ${id} as new, and that file's history already holds it`);
    if (replaced) throw new Error(`R3 ${about} took ${id} as new, and it is in a version that a restore replaced`);
    if (stands !== n - 1) throw new Error(`R3 ${about} took ${id} as request ${n} of ${c}, and the count of ${c} stood at ${stands}`);
    if (how === "held" || how === "conflict") {
      if (how === "held") {
        checkHeld(about, id, decision, ahead, coming, copy.at, tally);
      } else {
        if (ahead) throw new Error(`R10 ${about} judged ${id} as a conflict, and ${whyWaits(ahead)}`);
        if (choice?.how === "keep") throw new Error(`R10 ${about} left ${id} as a conflict again, though a person decided to keep the current value: that decision is counted and writes nothing`);
        const clash = fits ? unseen(expected.wb, edit) : [];
        if (!clash.length) throw new Error(`R8 ${about} left ${id} for a person as a conflict, and every cell it writes still holds the value its author saw`);
        if (JSON.stringify(decision.cells) !== JSON.stringify(clash)) throw new Error(`R8 ${about} reports the conflict of ${id} with cells that are not the current value next to the copy's value in each cell that changed`);
        if (choice && !overUnseen(expected.wb, edit, choice).length) throw new Error(`R8 ${about} left ${id} as a conflict again, though every cell it writes still holds the value the person reviewed before choosing the copy's value`);
        clashes.set(id, clash);
      }
      passed.set(c, n);
      before.passed.add(id);
      if (!record.has(id)) record.set(id, "open");
      continue;
    }
    if (ahead) throw new Error(`R10 ${about} ${how === "misfit" ? `counted ${id} as refused` : `judged ${id} as ${how}`}, and ${whyWaits(ahead)}`);
    if (how === "misfit" && coming) throw new Error(`R10 ${about} counted ${id} as refused, and ${whyComing(coming)}`);
    held.add(id);
    took.push([id, how]);
    before.taken.set(c, Math.max(before.taken.get(c) ?? 0, n));
    delete expected.seen[c];
    expected.seen[c] = [n, file.record.epoch];
    if (open) record.set(id, how === "applied" ? "saved" : how);
    if (how === "kept") {
      if (choice?.how !== "keep") throw new Error(`R10 ${about} counted ${id} without writing it, and no person decided to keep the current value in its place`);
      if (!fits) throw new Error(`R3 ${about} reports ${id} as counted with the current value kept, and its rows are not in that document`);
      continue;
    }
    if (choice?.how === "keep" && fits) throw new Error(`R10 ${about} wrote ${id}, though a person decided to keep the current value`);
    if (fits !== (how === "applied")) throw new Error(`R3 ${about} reports ${id} as ${how === "applied" ? "applied, and its rows are not in that document" : "an edit that no longer fits, and that document has room for it"}`);
    if (how !== "applied") continue;
    const [clash] = overUnseen(expected.wb, edit, choice);
    if (clash) throw new Error(`R8 ${about} wrote ${id} into ${clash[0]}/${clash[1]} over ${JSON.stringify(clash[2])}, a value ${choice ? "that neither its author saw nor the person who chose the copy's value reviewed" : "its author did not see"}`);
    const removed = removedRef(expected.wb, edit);
    if (JSON.stringify(decision.removed ?? []) !== JSON.stringify(removed)) throw new Error(`R9 ${about} applied the delete ${id} and reports ${(decision.removed ?? []).length} values it removed that its author did not see, and it removed ${removed.length}`);
    write(id, action);
    for (const [at, col, value] of cellsOf(action)) {
      const key = `${at}/${col}`;
      const [newer] = writers.get(key) ?? [];
      if (!choice && newer && follows(oracle, newer, id, key)) tally.back++;
      writers.set(key, [id, value]);
    }
  }
  const { state } = result.file;
  if (canon(state.wb) !== canon(expected.wb)) throw new Error(`R3 ${about} returned a document that is not that file with the edits the replay reports as applied`);
  if (!sameLedger(state.seen, expected.seen)) throw new Error(`R3 ${about} returned a ledger that does not count exactly the requests the replay reports as taken`);
  if (JSON.stringify([state.lineage, state.cut, state.floor]) !== JSON.stringify([file.state.lineage, file.state.cut, file.state.floor]) || result.file.record !== file.record) throw new Error(`R3 ${about} changed the lineage, the cut record, the floor or the commit record of that file`);
  if (sortedMarks(result.marks) !== sortedMarks(record)) throw new Error(`R11 ${about} returned a decision record that does not list exactly the edits it passed over as open and the edits it settled as closed`);
  return { file: result.file, decisions: result.decisions, marks: result.marks, open: clashes, took };
}

const branch = ({ held, gone, before, writers }) => ({ held: new Set(held), gone, before: { refused: new Set(before.refused), closed: new Set(before.closed), passed: new Set(before.passed), taken: new Map(before.taken) }, writers: new Map(writers) });

const newContext = (oracle, at, gone) => ({ held: new Set(outcomesAt(oracle, at).keys()), gone, before: { refused: new Set(), closed: new Set(), passed: new Set(), taken: new Map() }, writers: lastWriters(oracle, at) });

function hostMarks(world) {
  const marks = new Map();
  for (const { e } of world.host.decisions) marks.set(e, verdict(world.host, e).kind);
  return marks;
}

function replayOnto(oracle, known, copy, file, ctx, tally, where, marks) {
  const about = `replaying recovery copy ${known.id} onto ${where}`;
  const first = foldReplay(oracle, about, copy, file, ctx, tally, null, marks);
  const second = foldReplay(oracle, `a second replay of recovery copy ${known.id} onto ${where}`, copy, first.file, branch(ctx), newTally(), null, first.marks);
  tally.again += second.took.length;
  return first;
}

function decideAll(oracle, known, copy, first, ctx, how, where) {
  const sums = oracle.whatIf[how];
  const about = `replaying recovery copy ${known.id} onto ${where} with a person's decision to ${how === "take" ? "take the copy's value" : "keep the current value"} for each conflict`;
  const state = branch(ctx);
  const decided = new Set();
  let last = first;
  let earliest = null;
  for (let round = 0; round < 3 && last.open.size; round++) {
    const choices = new Map([...last.open].map(([e, cells]) => [e, { how, cells, looked: lookedRef(oracle.edits.get(e), cells) }]));
    earliest ??= choices;
    for (const e of choices.keys()) decided.add(e);
    last = foldReplay(oracle, about, copy, last.file, state, newTally(), choices, last.marks);
    for (const [id, took] of last.took) {
      if (took === "misfit") sums.misfit++;
      else if (took === "kept") sums.kept++;
      else if (decided.has(id)) sums.chosen++;
      else sums.released++;
    }
  }
  sums.copies++;
  sums.edits += copy.edits.length;
  sums.auto += first.took.filter(([, took]) => took === "applied").length;
  sums.misfit += first.took.filter(([, took]) => took === "misfit").length;
  for (const { how: left } of last.decisions) {
    if (left === "conflict") sums.conflict++;
    else if (left === "held") sums.held++;
    else if (left === "unjudged") sums.left++;
  }
  if (earliest) foldReplay(oracle, `repeated ${about}`, copy, last.file, state, newTally(), earliest, last.marks);
}

const replacedNow = (oracle) => (id) => oracle.cutOut.has(id) || oracle.backedUp.has(id);

function checkReplay(world, oracle, known, commit, tally, gone = replacedNow(oracle), decide = false) {
  const at = oracle.commits.get(commit);
  const ctx = newContext(oracle, at, gone);
  const stored = storedCopy(world, known.id);
  const copy = { ...stored.about, preview: codecDoc(stored.preview) };
  const first = replayOnto(oracle, known, copy, storedVersion(world, commit), ctx, tally, commit, hostMarks(world));
  if (decide) for (const how of ["take", "keep"]) decideAll(oracle, known, copy, first, ctx, how, commit);
}

function checkPlaces(world, oracle) {
  const file = storedVersion(world, oracle.live);
  const marks = hostMarks(world);
  for (const [id, places] of oracle.places) {
    if (marks.get(id) !== "open") continue;
    for (const { at, c, n, saw } of places) {
      if (!placedRef(file, { src: at })) continue;
      const entry = { e: id, c, n, b: null, src: at, org: at, via: [], out: "applied", action: codecAction(oracle.edits.get(id).action), saw };
      const [line] = replay(codecFile(file), { edits: [entry] }, null, marks).decisions;
      oracle.placesOpen++;
      if (line.how === "saved") throw new Error(`R11 a copy that lists ${id} by its place ${at[0]}#${at[1]} is replayed onto the final file as covered by a file position, and the decision record lists ${id} as an edit that no person has decided: its place in a lost room does not show that its value was written (rule 111)`);
    }
  }
}

function recheckStorage(world, oracle) {
  checkPlaces(world, oracle);
  for (const backup of oracle.backups) checkBackup(world, oracle, backup);
  for (const known of oracle.copies.values()) {
    checkCopy(world, oracle, known);
    checkReplay(world, oracle, known, oracle.live, oracle.atEnd);
  }
  const at = oracle.commits.get(oracle.live);
  const made = [...oracle.copies.values()];
  for (const [row, others] of [[made, "before"], [made.toReversed(), "after"]]) {
    const ctx = newContext(oracle, at, replacedNow(oracle));
    let file = storedVersion(world, oracle.live);
    let marks = hostMarks(world);
    for (const known of row) ({ file, marks } = replayOnto(oracle, known, storedCopy(world, known.id).about, file, ctx, { ...oracle.atEnd }, `${oracle.live} after the copies made ${others} it`, marks));
  }
}

const took = (oracle, gen, frame, id) => frameId(frame) === id && oracle.gens.get(gen)?.applied[frame.seq] === true;

const holds = (oracle, tab, id) =>
  tab.tail.some((frame) => took(oracle, tab.gen, frame, id)) ||
  tab.held.some((held) => held.frames.some((frame) => took(oracle, held.gen, frame, id))) ||
  tab.pending.some((request) => request.id === id);

function shows(oracle, tab, id) {
  if (!tab.state) return false;
  const { action } = oracle.edits.get(id);
  const wb = view(tab);
  if (action.t === "ins") return Boolean(wb.rows[action.row]);
  return cellsOf(action).some(([row, col, value]) => {
    const shown = wb.rows[row]?.cells[col];
    if (shown === undefined || value === "") return false;
    const by = oracle.byValue.get(shown);
    return shown === value || (Boolean(by) && follows(oracle, by, id, `${row}/${col}`));
  });
}

function provable(oracle, from, to) {
  let gen = to;
  for (let hops = 0; hops <= W; hops++) {
    if (gen === from) return true;
    const info = oracle.gens.get(gen);
    if (!info || !info.parent) return false;
    gen = info.parent;
  }
  return false;
}

const textAt = (oracle, { gen, through }) => oracle.gens.get(gen).at[through];

function outcomesAt(oracle, { gen, through }) {
  const info = oracle.gens.get(gen);
  const outcomes = new Map(info.outcomes);
  for (let seq = 1; seq <= through; seq++) if (!info.dup[seq]) outcomes.set(info.ids[seq], info.applied[seq]);
  return outcomes;
}

const priorAt = (edit, key) => (edit?.action.t === "paste" ? edit.prior?.[key] ?? null : edit?.prior ?? null);

function follows(oracle, id, target, key) {
  let at = priorAt(oracle.edits.get(id), key);
  for (let n = 0; at && n < 100000; n++) {
    if (at === target) return true;
    at = priorAt(oracle.edits.get(at), key);
  }
  return false;
}

function linear(oracle, { gen, through }) {
  const info = oracle.gens.get(gen);
  const list = info.base ? linear(oracle, info.base) : [];
  list.push(...info.pre);
  for (let seq = 1; seq <= through; seq++) if (!info.dup[seq]) list.push([info.ids[seq], info.applied[seq], Boolean(info.origin[seq])]);
  return list;
}

function lastWriters(oracle, at) {
  const writers = new Map();
  for (const [id, applied, restored] of linear(oracle, at)) {
    if (!applied) continue;
    const { action } = oracle.edits.get(id);
    if (action.t === "del") for (const key of [...writers.keys()]) if (key.startsWith(`${action.row}/`)) writers.delete(key);
    for (const [row, col, value] of cellsOf(action)) writers.set(`${row}/${col}`, [id, value, restored]);
  }
  return writers;
}

function checkHostFile(world, oracle) {
  if (oracle.checkedEtag === world.host.etag) return;
  const { record, state } = parse(world.host.body);
  if (record.commit !== oracle.live) throw new Error(`P2 the host file is ${record.commit}, and the last accepted commit is ${oracle.live}`);
  if (canon(state.wb) !== textAt(oracle, oracle.commits.get(oracle.live))) throw new Error(`P4 the host file ${record.commit} is not the reference workbook at ${record.gen}#${record.through}`);
  oracle.checkedEtag = world.host.etag;
}

const passedInFile = (oracle, id) => !cellsOf(oracle.edits.get(id).action).length && !oracle.skippedListed.has(id) && (oracle.passedInRoom.get(id) ?? []).some((later) => oracle.saved.has(later));

function rootOf(oracle, id) {
  let at = id;
  while (oracle.takeOf.has(at)) at = oracle.takeOf.get(at).e;
  return at;
}

const takesUnder = (oracle, id) => [...(oracle.takes.get(id) ?? [])].flatMap((take) => [take, ...takesUnder(oracle, take)]);

const takesOf = (oracle, id) => takesUnder(oracle, rootOf(oracle, id)).filter((one) => one !== id);

const kinOf = (oracle, id) => [rootOf(oracle, id), ...takesOf(oracle, id)].filter((one) => one !== id);

const takenInFile = (oracle, id) => kinOf(oracle, id).some((one) => oracle.saved.has(one));

const writtenInFile = (oracle, id) => oracle.saved.has(id) && outcomesAt(oracle, oracle.commits.get(oracle.saved.get(id))).get(id) === true;

const listed = (world, oracle, id, orTaken) => Boolean(verdict(world.host, id) ?? (orTaken && oracle.takeOf.has(id) ? verdict(world.host, oracle.takeOf.get(id).e) : null));

function checkRemovals(world, oracle, tabs) {
  const kept = world.host.removals;
  for (const [gen, info] of oracle.gens) {
    for (const [seq, cells] of info.removed) {
      if (!cells.length || (oracle.savedThrough.get(gen) ?? -1) < seq) continue;
      oracle.removalHeld++;
      if (kept.some((one) => one.by === info.ids[seq] && one.at[0] === gen && one.at[1] === seq)) continue;
      oracle.removalMissed++;
      throw new Error(`R12 ${info.ids[seq]} at ${gen}#${seq} removed values that its author did not see, an accepted file holds that frame, and the record of removed values does not list it: the entry goes with the save that first holds the delete (rules 109 and 125)`);
    }
  }
  for (const entry of kept) {
    for (const tab of tabs) {
      const shown = tab.notices.some((one) => one.kind === "removed" && one.by === entry.by && JSON.stringify(one.cells) === JSON.stringify(entry.cells));
      if (!shown) throw new Error(`R12 ${tab.id} is open and shows no notice for the ${entry.cells.length} values that ${entry.by} removed, which the record of removed values lists (rule 109)`);
    }
  }
}

const toldRefused = (oracle, tab, id) => [...oracle.gens.values()].some((info) => info.turned.has(id)) && tab.notices.some((notice) => notice.kind === "refused" && notice.edits.includes(id) && JSON.stringify(refAction(notice.action)) === JSON.stringify(oracle.edits.get(id).action));

export function checkStep(world) {
  const { oracle } = world;
  checkHostFile(world, oracle);
  if (world.returned.judged !== oracle.returned.judged) throw new Error(`G3 the room judged ${world.returned.judged} frames again that a backup or a take had brought into a lost room, and the oracle checked ${oracle.returned.judged} of them (rule 104)`);
  for (const tab of world.tabs) {
    if (!tab.alive) continue;
    const info = tab.state && oracle.gens.get(tab.gen);
    for (const [id, one] of tab.edits) {
      if (one.state === "saved" && !oracle.saved.has(id) && !passedInFile(oracle, id) && !takenInFile(oracle, id)) throw new Error(`P1 ${tab.id} shows ${id} as saved, and no accepted file holds it or a person's take of it`);
      if (one.state === "recovered" && info?.turned.has(id) && tab.tail.some((frame) => frame.seq === info.turned.get(id))) throw new Error(`R3 ${tab.id} shows ${id} as recovered after it saw the room of ${tab.gen} count and refuse it`);
      if (one.state === "dropped" && info?.reopened.has(id) && tab.tail.some((frame) => frame.seq === info.reopened.get(id)) && !oracle.keepSeen.has(`${tab.id}/${id}`) && verdict(world.host, id)?.kind === "open" && !toldRefused(oracle, tab, id)) throw new Error(`R3 ${tab.id} shows ${id} as dropped after it saw the room of ${tab.gen} count its returned edit without writing it, and the decision record lists that edit as open for a person's decision (rule 104)`);
    }
    if (info && canon(tab.state.wb) !== info.at[tab.a]) throw new Error(`P5 ${tab.id} at ${tab.gen}#${tab.a} differs from the reference workbook`);
    const room = world.room;
    if (attached(world, tab) && tab.cursor === room.log.length && !tab.inbox.size && tab.a !== room.seq) {
      throw new Error(`P5 ${tab.id} has read the whole room stream and is at ${tab.gen}#${tab.a}, and the room is at #${room.seq}`);
    }
  }
  if (world.room?.gen) {
    measureRoom(world, oracle, world.room);
    const info = oracle.gens.get(world.room.gen);
    if (canon(world.room.state.wb) !== info.at[world.room.seq]) throw new Error(`P5 the room at ${world.room.gen}#${world.room.seq} differs from the reference workbook`);
  }
}

function checkKept(oracle, wb, final, deleted, writers, id, edit, author) {
  const { action } = edit;
  const mine = author.edits.get(id);
  const cells = cellsOf(action);
  if (!final.get(id)) {
    if (action.t === "set" && wb.rows[action.row] && !oracle.declined.has(id) && !oracle.stopped.has(id)) throw new Error(`P6 ${id} was refused, and its row ${action.row} is in the final file`);
    if (!author.alive || !cells.length) return;
    if (mine.state === "saved" && oracle.takeOf.has(id) && (oracle.metItsValue.has(id) ? takenInFile(oracle, id) : holdsRef(wb, action) && kinOf(oracle, id).some((one) => final.get(one) === true))) return;
    if (mine.state === "saved" && !oracle.takeOf.has(id) && takenInFile(oracle, id)) return;
    const told = author.notices.some((notice) => notice.edits.includes(id));
    if (!told) throw new Error(`P6 ${id} of open tab ${author.id} was refused with no notice`);
    if (mine.state === "saved" && takenInFile(oracle, id)) return;
    if (!["dropped", "recovered", "kept-refused"].includes(mine.state)) throw new Error(`P6 ${id} was refused, and ${author.id} shows it as ${mine.state}`);
    return;
  }
  if (action.t === "del") {
    if (wb.rows[action.row]) throw new Error(`I3 ${id} deleted row ${action.row}, and the row is in the final file`);
    return;
  }
  for (const row of action.t === "ins" ? [action.row] : cells.map(([at]) => at)) {
    if (!wb.rows[row] && !deleted.has(row)) throw new Error(`I3 ${id}: row ${row} is gone with no recorded delete`);
  }
  for (const [row, col] of cells) {
    if (!wb.rows[row]) continue;
    const key = `${row}/${col}`;
    const [shown, value, restored] = writers.get(key) ?? [];
    if (!shown) throw new Error(`I3 ${id}: no applied action is the last writer of ${key}`);
    const found = wb.rows[row].cells[col] ?? "";
    if (found !== value) throw new Error(`I3 ${key} holds ${JSON.stringify(found)}, and its last applied write ${shown} wrote ${JSON.stringify(value)}`);
    if (shown !== id && !restored && follows(oracle, id, shown, key)) throw new Error(`I3 ${id} was built on ${shown}, and the final file holds ${shown}`);
  }
}

function checkTakenDelete(world, oracle, wb, final, id, { action }, author) {
  const { state } = author.edits.get(id);
  const about = `P6 ${id} of open tab ${author.id}, a person's take of the row delete ${oracle.takeOf.get(id).e},`;
  const fromRecord = ["kept", "misfit"].includes(verdict(world.host, id)?.kind);
  const refused = state === "dropped" || (state === "kept-refused" && !fromRecord);
  if (refused && final.get(id) === true && !wb.rows[action.row] && !oracle.everRefused.has(id) && !oracle.broughtBack.has(id)) throw new Error(`${about} removed row ${action.row} in the final file's history and no room refused it, and the tab shows it as ${state}: a take of a row delete is labelled by whether the row is gone (rule 132)`);
  const putBack = [...oracle.cutOut, ...oracle.backedUp].some((one) => oracle.edits.get(one)?.action.t === "del" && oracle.edits.get(one).action.row === action.row);
  if (state === "saved" && wb.rows[action.row] && !putBack) throw new Error(`${about} shows as saved, and row ${action.row} is in the final file, and no version restore replaced a delete of that row: a take of a row delete is labelled by whether the row is gone (rule 132)`);
}

export function checkEnd(world, join) {
  const { oracle } = world;
  const room = world.room;
  const file = get(world.host);
  const tabs = world.tabs.filter((tab) => tab.alive);
  if (!room?.gen || file.record.gen !== room.gen || file.record.through !== room.seq) {
    throw new Error(`I8 unsaved work is left: file ${file.record.gen}#${file.record.through}, room ${room?.gen ? `${room.gen}#${room.seq}` : "none"}`);
  }
  if (oracle.live !== file.record.commit) throw new Error(`P2 the host file is ${file.record.commit}, and the last accepted commit is ${oracle.live}`);
  for (const tab of tabs) {
    if (!attached(world, tab) || tab.pending.length || tab.held.length || tab.io || tab.unknown || tab.limbo.length || tab.unstored.length || tab.marks.length || tab.removals.length || tab.job || tab.a !== room.seq) {
      throw new Error(`I8 ${tab.id} is not settled`);
    }
  }
  checkStep(world);
  for (const stage of room.staging.values()) if (!world.tabs.find((tab) => tab.id === stage.by)?.alive) throw new Error(`M5 the room holds ${stage.size} staged bytes for ${stage.by}, a tab that has closed`);
  const text = canon(file.state.wb);
  for (const tab of tabs) if (canon(view(tab)) !== text) throw new Error(`P5 ${tab.id} differs from the saved file`);
  const fresh = join(world);
  if (!attached(world, fresh) || canon(view(fresh)) !== text) throw new Error("P5 a fresh tab differs from the saved file");
  if (world.removals) checkRemovals(world, oracle, [...tabs, fresh]);
  fresh.alive = false;
  fresh.connected = false;
  const final = outcomesAt(oracle, oracle.commits.get(oracle.live));
  const writers = lastWriters(oracle, oracle.commits.get(oracle.live));
  const wb = refDoc(file.state.wb);
  const deleted = new Set();
  for (const [id, applied] of final) if (applied && oracle.edits.get(id)?.action.t === "del") deleted.add(oracle.edits.get(id).action.row);
  for (const [id, edit] of oracle.edits) {
    const author = authorOf(world, edit);
    const mine = author.edits.get(id);
    if (author.alive && !["saved", "dropped", "recovered", "kept-refused"].includes(mine.state)) throw new Error(`P6 ${id} of open tab ${author.id} ended as ${mine.state}`);
    if (author.alive && edit.action.t === "del" && oracle.takeOf.has(id)) checkTakenDelete(world, oracle, wb, final, id, edit, author);
    if (final.has(id)) {
      checkKept(oracle, wb, final, deleted, writers, id, edit, author);
      continue;
    }
    const inVersion = oracle.cutOut.has(id) || oracle.backedUp.has(id);
    if (!inVersion && oracle.saved.has(id)) throw new Error(`P2 ${id} was saved in ${oracle.saved.get(id)}, and the final file's history does not hold it`);
    if (oracle.recovered.has(id)) continue;
    if (oracle.homeless.get(id)?.has(author.id)) {
      const shown = author.notices.some((notice) => notice.kind === "refused" && notice.edits.includes(id) && JSON.stringify(refAction(notice.action)) === JSON.stringify(edit.action));
      if (author.alive && (!shown || mine.state !== "dropped")) throw new Error(`P6 ${id} had no row left in ${author.id}'s recovery copy, and the tab shows ${mine.state} with ${shown ? "a" : "no"} notice`);
      continue;
    }
    const owed = oracle.owed.get(id);
    if (!inVersion && owed && [...owed].some((tab) => tab.alive) && !listed(world, oracle, id, true)) throw new Error(`P3 ${id} was shared, a tab that held it stayed open, and it is neither saved nor in a recovery copy, and the decision record does not list it`);
    if (!author.alive) continue;
    const told = author.notices.some((notice) => notice.edits.includes(id) && (notice.kind !== "refused" || JSON.stringify(refAction(notice.action)) === JSON.stringify(edit.action)));
    if (oracle.refused.has(id)) {
      if (!cellsOf(edit.action).length || (mine.state === "saved" && (oracle.metItsValue.has(id) || !oracle.takeOf.has(id)) && takenInFile(oracle, id))) continue;
      const held = author.notices.some((notice) => notice.edits.includes(id) && JSON.stringify(refAction(notice.kind === "refused" ? notice.action : notice.actions?.[id])) === JSON.stringify(edit.action));
      if (!held || mine.state === "saved") throw new Error(`P6 ${id} of open tab ${author.id} was refused, and the tab shows ${mine.state} with ${held ? "a" : "no"} notice that holds it`);
      continue;
    }
    if (!inVersion) {
      const refusal = oracle.everRefused.get(id);
      const held = author.notices.some((notice) => notice.kind === "refused" && notice.edits.includes(id) && JSON.stringify(refAction(notice.action)) === JSON.stringify(edit.action));
      const passed = listed(world, oracle, id, false) && ["recovered", "kept-refused"].includes(mine.state) && author.notices.some((notice) => notice.edits.includes(id) && JSON.stringify(refAction(notice.actions?.[id])) === JSON.stringify(edit.action));
      if (listed(world, oracle, id, false) && (!refusal || passed)) continue;
      if (refusal && mine.state === "saved" && !oracle.takeOf.has(id) && kinOf(oracle, id).some((one) => writtenInFile(oracle, one))) continue;
      if (!refusal) throw new Error(`P6 ${id} of open tab ${author.id} ended as ${mine.state}, with no saved file, no recovery copy and no refusal, and the decision record does not list it`);
      if (!held || mine.state !== "dropped") throw new Error(`P6 ${id} of open tab ${author.id} was refused at ${refusal.gen}#${refusal.seq} and is in no file and no recovery copy, and the tab shows ${mine.state} with ${held ? "a" : "no"} refusal notice that holds its action`);
      continue;
    }
    if (mine.state !== "saved" && !told) throw new Error(`P6 ${id} of open tab ${author.id} is only in a version a restore replaced, and the tab shows ${mine.state} with no notice`);
  }
  for (const tab of tabs) {
    for (const notice of tab.notices) {
      if (notice.copy && !world.host.recoveries.some((one) => one.id === notice.copy)) throw new Error(`R4 ${tab.id} shows a notice for ${notice.copy}, and the host holds no such copy`);
      if (notice.kind === "waiting" || (notice.kind !== "restored" && notice.row)) throw new Error(`R9 ${tab.id} shows a notice that an edit waits for its row ${notice.row}: an edit that waits for a row waits quietly (rule 106)`);
    }
  }
  recheckStorage(world, oracle);
}

export function account(world) {
  const { oracle } = world;
  const final = outcomesAt(oracle, oracle.commits.get(oracle.live));
  const counts = { saved: 0, refused: 0, copy: 0, version: 0, closed: 0 };
  for (const id of oracle.edits.keys()) {
    if (final.has(id)) counts[final.get(id) ? "saved" : "refused"]++;
    else if (oracle.recovered.has(id)) counts.copy++;
    else if (oracle.homeless.has(id) || oracle.refused.has(id)) counts.refused++;
    else if (oracle.cutOut.has(id) || oracle.backedUp.has(id)) counts.version++;
    else if (oracle.everRefused.has(id) && authorOf(world, oracle.edits.get(id)).edits.get(id)?.state === "dropped") counts.refused++;
    else counts.closed++;
  }
  return counts;
}
