import { planted } from "./planted.mjs";
import { resolved, covered, epochOf, W } from "./ledger.mjs";
import { act, codec } from "./codec.mjs";
import { clone } from "./lib.mjs";
import { fitsNow, waitsFor, marksOf, stillOpen, holds, conflicts, lateCells, unseenBy, rowsOf, createsOf, removesOf, has } from "./conflict.mjs";

export const COPY_VERSION = 4;

export const CLOSING = ["taken", "saved", "kept", "misfit"];

const same = ([gen, seq], [otherGen, otherSeq]) => gen === otherGen && seq === otherSeq;

export function positions(entry) {
  const all = [];
  for (const at of [entry.org, ...(entry.via ?? []), entry.src]) if (at && !all.some((one) => same(one, at))) all.push(at);
  return all;
}

const through = ({ record, state }, gen) => (record.gen === gen ? record.through : covered(state, gen)?.[1] ?? -1);

export const inFile = (file, entry) => positions(entry).some(([gen, seq]) => through(file, gen) >= seq);

export function accounted(file, entry) {
  const { cut } = file.state;
  if (inFile(file, entry)) return "saved";
  const [low, high] = cut?.[2][entry.c] ?? [0, 0];
  if (entry.n > low && entry.n <= high && unbroken(file, counted(entry)) && !planted("ledger-before-cut")) return "replaced";
  if (resolved(file.state, entry.c) >= entry.n) return "resolved";
  return positions(entry).some(([gen, seq]) => cut?.[0] === gen && seq <= cut[1]) ? "replaced" : null;
}

export const taken = (entry) => entry.out !== "refused" && entry.out !== "counted";

export const preview = (wb, edits) => codec().preview(wb, edits.filter(taken).map((entry) => entry.action));

const unbroken = (file, since) => since !== null && since !== undefined && since > file.state.floor && since >= file.record.epoch - W;

const dropped = (file, client, born) => !(client in file.state.seen) && !unbroken(file, born);

const counted = (entry) => (entry.org ? epochOf(entry.org[0]) : entry.b);

const whole = (file, entry) => (planted("replay-trusts-a-returned-count") ? !dropped(file, entry.c, entry.b) : unbroken(file, counted(entry)));

const next = (file, entry, known) => whole(file, entry) && (known === entry.n - 1 || planted("replay-over-a-gap"));

function judge(file, entry, known) {
  if (entry.out === "refused") return "refused";
  if (planted("restore-skips-ledger") || (entry.decide && planted("decision-applies-twice"))) return "new";
  const found = accounted(file, entry);
  if (found) return found;
  if (entry.out === "counted") return "unjudged";
  if (entry.out === "unsent" && planted("replay-unsent-out-of-order")) return "new";
  return next(file, entry, known) ? "new" : "unjudged";
}

export const newMemory = () => ({ turned: new Map(), waiting: new Map() });

function stillWaiting(file, memory, at) {
  const open = new Map();
  const earlier = (ahead) => ahead.i < at;
  for (const ahead of [...memory.waiting.values()].sort((a, b) => a.i - b.i)) {
    const waits = ahead.how !== "unjudged" || resolved(file.state, ahead.c) < ahead.n;
    if (earlier(ahead) && waits) for (const mark of marksOf(ahead.action)) open.set(mark, ahead);
  }
  return open;
}

export function madeFor(made, action) {
  const rows = rowsOf(action).filter((row) => made?.[row]);
  return rows.length ? Object.fromEntries(rows.map((row) => [row, made[row]])) : undefined;
}

function reach(file) {
  const [own, before] = file.state.opened ?? [file.record.epoch, file.record.epoch];
  if (planted("ledger-turn-ends-the-row-wait")) return file.record.epoch - 1;
  if (planted("row-wait-counts-from-the-insert")) return own - 1;
  return planted("row-wait-ends-a-room-early") ? own : before;
}

const inReach = (file, insert) => epochOf(insert.src[0]) >= reach(file) || planted("edit-waits-for-its-row-forever");

const adopts = (file, insert) => file.state.lineage.some(([gen]) => (planted("row-wait-ends-at-the-named-place") ? gen === insert.src[0] : epochOf(gen) >= epochOf(insert.src[0])) && (insert.c in file.state.seen || epochOf(gen) >= file.state.floor));

const returnable = (file, insert) => insert.src[0] === file.record.gen || adopts(file, insert);

const pending = (file, insert) => Boolean(insert) && !accounted(file, insert) && (planted("row-wait-ends-at-the-ledger-floor") || planted("oracle-trusts-the-ledger-floor") ? whole(file, insert) : returnable(file, insert)) && inReach(file, insert);

export function rowToCome(file, { action, made }) {
  const missing = rowsOf(action).filter((row) => !has(file.state.wb, row));
  if (planted("waits-for-a-row-that-cannot-come-back")) return missing[0] ?? null;
  return missing.find((row) => pending(file, made?.[row])) ?? null;
}

const mayCome = (file, insert) => !accounted(file, insert) && (whole(file, insert) || returnable(file, insert) || Boolean(covered(file.state, insert.src[0])));

const anyOrEvery = (rows, test) => (planted("row-may-return-needs-every-row") ? rows.every(test) : rows.some(test));

export const rowMayReturn = (file, { action }, made) => rowsOf(action).length > 0 && anyOrEvery(rowsOf(action), (row) => !has(file.state.wb, row) && made?.[row] && mayCome(file, made[row]));

export function weigh(file, entry, memory = newMemory(), at = 0, blind = false) {
  const { wb } = file.state;
  const { action } = entry;
  const known = Math.max(resolved(file.state, entry.c), Math.min(memory.turned.get(entry.c) ?? 0, entry.n - 1));
  const how = judge(file, entry, known);
  const inTurn = next(file, entry, known);
  if (how === "refused") {
    const due = Boolean(entry.src) && inTurn;
    const fits = fitsNow(wb, action);
    return { how, passed: due && !fits, blocks: due && fits };
  }
  const placed = how === "saved" && !planted("place-closes-an-open-edit");
  const late = (how === "resolved" || how === "replaced" || placed) && Boolean(entry.open);
  if ((how === "saved" || how === "resolved") && !late) return { how, shown: (how === "saved" && planted("position-means-saved")) || holds(wb, action) };
  if (how !== "new" && !late) return { how };
  const ahead = waitsFor(wb, action, stillWaiting(file, memory, at));
  if (ahead && !planted(createsOf(ahead.action).length ? "restore-counts-a-waiting-row" : "restore-out-of-order")) return { how: "held", behind: ahead.e, late };
  if (late && holds(wb, action)) return { how: "resolved", shown: true, late };
  const row = fitsNow(wb, action) || planted("restore-refuses-a-row-that-may-return") ? null : rowToCome(file, entry);
  if (row) return { how: "held", behind: null, row, late };
  if (!fitsNow(wb, action)) return { how: "misfit", inTurn, late };
  if (entry.decide === "keep") return { how: "kept", inTurn, late };
  const taking = entry.decide === "take";
  if (late && planted("late-edit-written-by-itself") && !stillOpen(wb, action, entry.saw, null).length) return { how: "applied", inTurn, removed: unseenBy(wb, action, entry.saw) };
  if (late) return taking && entry.reviewed && !conflicts(wb, action, entry.reviewed).length ? { how: "take", late } : { how: "conflict", cells: lateCells(wb, action, entry.saw), late };
  const blindly = (taking && planted("decision-take-unchecked")) || (planted("delete-ignores-a-changed-seen-cell") && removesOf(action).length > 0);
  const open = blindly ? [] : stillOpen(wb, action, entry.saw, taking ? entry.reviewed : null);
  const cells = planted("restore-ignores-seen") || blind ? [] : open;
  return cells.length ? { how: "conflict", cells } : { how: "applied", inTurn, removed: unseenBy(wb, action, entry.saw) };
}

export function remember(memory, { e, c, n, action }, { how, passed, blocks, late }, at) {
  const open = how === "conflict" || how === "held";
  const passes = passed || blocks || (open && !late && !planted("later-edit-held-anyway"));
  if (passes) memory.turned.set(c, Math.max(memory.turned.get(c) ?? 0, n));
  const waits = open || (createsOf(action).length > 0 && how === "unjudged");
  if (waits) memory.waiting.set(at, { e, c, n, i: at, how, action });
  else memory.waiting.delete(at);
}

export const counts = ({ how, late }) => !late && (how === "applied" || how === "misfit" || how === "kept");

export function markFor({ how, shown, blocks, passed }, known) {
  if (how === "refused") return (blocks || (passed && !planted("refused-pass-without-record"))) && !known ? "refused" : null;
  if (how === "conflict" || how === "held") return known ? null : "open";
  if (known !== "open") return null;
  if (how === "take") return "taken";
  if (how === "applied" || ((how === "saved" || how === "resolved") && (shown || planted("place-closes-a-mark"))) || (how === "resolved" && planted("resolved-closes-a-mark"))) return "saved";
  return how === "kept" || how === "misfit" ? how : null;
}

function told(judged, e) {
  const { how, cells, behind, row, shown, blocks, late, removed } = judged;
  const line = how === "conflict" ? { e, how, cells } : how === "held" ? (row ? { e, how, behind, row } : { e, how, behind }) : how === "saved" || how === "resolved" ? { e, how, shown } : how === "take" ? { e, how: "applied" } : blocks ? { e, how, blocks } : { e, how };
  if (late) line.late = true;
  if (removed?.length && !planted("restored-delete-hides-removed-values")) line.removed = removed;
  return line;
}

function count(file, entry) {
  delete file.state.seen[entry.c];
  file.state.seen[entry.c] = [entry.n, file.record.epoch];
}

function write(wb, { action }) {
  if (planted("restore-reports-applied")) return;
  act(wb, planted("restore-half-paste") && action.t === "paste" ? { ...action, cells: action.cells.slice(0, 1) } : action);
  if (planted("restore-touches-another-cell")) {
    const [any] = Object.values(wb.rows);
    if (any) any.cells.stray = "not in any stored edit";
  }
}

function writeAround(wb, { action }, cells) {
  const clash = new Set(cells.map(([row, col]) => `${row}/${col}`));
  act(wb, { ...action, cells: action.cells.filter(([row, col]) => !clash.has(`${row}/${col}`)) });
}

export function replay(file, copy, choices = null, marks = new Map()) {
  const onto = { record: file.record, state: clone(file.state) };
  const memory = newMemory();
  const record = new Map(marks);
  let later = false;
  const decisions = copy.edits.map((stored, at) => {
    const chosen = choices?.has(stored.e) ? { ...stored, ...choices.get(stored.e) } : stored;
    const placed = { ...chosen, made: madeFor(copy.made, chosen.action) };
    const entry = record.get(stored.e) === "open" && !planted("restore-ignores-record") ? { ...placed, open: true } : placed;
    const judged = weigh(onto, entry, memory, at, later && planted("again-ignores-seen"));
    later ||= judged.how === "resolved";
    const { how, cells, inTurn } = judged;
    if (judged.passed && planted("replay-counts-a-refusal")) count(onto, entry);
    else remember(memory, entry, judged, at);
    const mark = markFor(judged, record.get(stored.e));
    if (mark && !planted("pass-without-record")) record.set(stored.e, mark);
    if (how === "conflict" && planted("conflict-per-cell") && entry.action.t === "paste") writeAround(onto.state.wb, entry, cells);
    if (how === "applied" || how === "take") write(onto.state.wb, entry);
    const lost = planted("replay-forgets-itself") || (how === "kept" && planted("decision-keep-not-counted"));
    if (counts(judged) && inTurn && !lost) count(onto, entry);
    return told(judged, entry.e);
  });
  return { file: onto, decisions, marks: record };
}
