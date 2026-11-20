import { planted } from "../core/planted.mjs";
import { newHost, get, put, write, keepRecovery, fetchRecovery } from "./host.mjs";
import { serialize, parse, ledgerBytes } from "../core/record.mjs";
import { act as refAct, cellsOf as workbookCells } from "../codec-tiny/reducer.mjs";
import { act } from "../core/codec.mjs";
import { refAction, refDoc, codecAction, codecDoc } from "./lens.mjs";
import { resolved } from "../core/ledger.mjs";
import { preview, replay } from "../core/recover.mjs";
import { readPage, parse as readFile } from "./reader.mjs";
import { labLimits } from "../core/limits.mjs";
import { newTally, refStep as refFold } from "./oracle.mjs";
import { canon, tinyWorkbook } from "./lib.mjs";
import { nextCommit, nextGen, view as codecView, edit as codecEdit, refresh, push, save, deliver, outsideFold } from "../core/fileonly.mjs";

export { refresh, push, save, deliver } from "../core/fileonly.mjs";

export const view = (tab) => refDoc(codecView(tab));

export const edit = (world, tab, action) => codecEdit(world, tab, codecAction(action));

const cellsOf = (action) => workbookCells(refAction(action));

const codecFile = (file) => ({ ...file, state: { ...file.state, wb: codecDoc(file.state.wb) } });

export function newFileWorld(options = {}) {
  const world = {
    host: newHost(options.workbook ?? tinyWorkbook()),
    tabs: [],
    ids: 0,
    commits: 0,
    nonce: 0,
    copies: 0,
    patches: 0,
    values: 0,
    rows: 0,
    inflight: [],
    answers: [],
    pushes: [],
    pushing: Boolean(options.pushing),
    limits: labLimits({ ledgerCap: options.ledgerCap }),
    accepted: 0,
    refused: 0,
    replaced: 0,
  };
  world.oracle = newFileOracle(world);
  world.observer = world.oracle;
  world.port = filePort(world);
  return world;
}

function filePort(world) {
  return {
    read: () => get(world.host),
    etag: () => world.host.etag,
    keepRecovery: (copy) => keepRecovery(world.host, copy),
    fetchRecovery: (id) => fetchRecovery(world.host, id),
    send: (tab, io) => world.inflight.push({ tab, io }),
    takeAnswer: (at) => world.answers.splice(at, 1)[0],
    takePush: (tab) => {
      const at = world.pushes.findIndex((one) => one.tab === tab);
      return at < 0 ? null : world.pushes.splice(at, 1)[0];
    },
    next: (counter) => ++world[counter],
  };
}

export const alive = (world) => world.tabs.filter((tab) => tab.alive);

export function open(world) {
  const id = `f${++world.ids}`;
  const tab = { id, alive: true, client: id, clients: new Set([id]), born: null, n: 0, base: null, pending: [], io: null, unknown: null, unstored: [], judged: new Map(), edits: new Map(), notices: [] };
  world.tabs.push(tab);
  refresh(world, tab);
  return tab;
}

export function close(world, tab) {
  tab.alive = false;
}

function announce(world, sender) {
  if (!world.pushing) return;
  const { etag, body } = world.host;
  for (const tab of alive(world)) if (tab !== sender) world.pushes.push({ tab, etag, body });
}

export function hostTake(world, at = 0, lost = false) {
  const [sent] = world.inflight.splice(at, 1);
  if (!sent) return false;
  let answer = { status: 0, etag: null };
  if (!lost) {
    answer = put(world.host, sent.io.body, sent.io.etag, "save");
    if (answer.status === 200) {
      world.accepted++;
      world.oracle.onAccept(world, sent.tab, sent.io);
      announce(world, sent.tab);
    }
  }
  world.answers.push({ ...sent, ...answer });
  return true;
}

export function outside(world, at, action, raw = false) {
  const version = at === "live" ? world.host : world.host.versions[at];
  if (!version) return false;
  const current = get(world.host);
  const source = parse(version.body);
  const patch = action ? { id: `x${++world.patches}`, action } : null;
  if (patch) act(source.state.wb, codecAction(action));
  world.replaced++;
  if (raw) {
    const body = serialize(source.record, source.state);
    world.oracle.onOutside(world, body, at, patch, true);
    write(world.host, body, "raw");
    announce(world);
    return true;
  }
  const { body } = outsideFold(world, source, current);
  world.oracle.onOutside(world, body, at, patch, false);
  write(world.host, body, "outside");
  announce(world);
  return true;
}

const calm = (tab) => !tab.pending.length && !tab.io && !tab.unknown && !tab.unstored.length;

export function settleAll(world) {
  if (!alive(world).length) open(world);
  for (let round = 0; round < 60; round++) {
    while (world.inflight.length || world.answers.length) world.inflight.length ? hostTake(world) : deliver(world);
    while (world.pushes.length) push(world, world.pushes[0].tab);
    for (const tab of alive(world)) if (tab.unknown || tab.unstored.length) refresh(world, tab);
    for (const tab of alive(world)) save(world, tab);
    if (!world.inflight.length && !world.pushes.length && alive(world).every(calm)) {
      for (const tab of alive(world)) refresh(world, tab);
      return world;
    }
  }
  throw new Error("F8 stuck: the tabs did not finish saving");
}

function refStep(wb, action) {
  return refAct(wb, refAction(action));
}

export function newFileOracle(world) {
  const first = parse(world.host.body);
  const oracle = {
    edits: new Map(),
    everSaved: new Set(),
    shownSaved: new Set(),
    cutOut: new Set(),
    rawLost: new Set(),
    recovered: new Map(),
    sent: new Map(),
    copies: new Map(),
    stored: 0,
    unprovable: 0,
    replays: newTally(),
    atEnd: newTally(),
    versions: [{ tables: canon(first.state.wb), history: new Set() }],
    live: first.record.commit,
    liveTables: canon(first.state.wb),
    inFile: new Set(),
    maxLedger: 0,
    onEdit(_, tab, id, action, shown) {
      oracle.edits.set(id, { id, by: tab.id, action: refAction(action), seen: seenOf(shown, action) });
    },
    onSend(_, tab, io, numbers) {
      for (const [id, n] of numbers) oracle.sent.set(id, { c: io.client, n, commit: io.commit, applied: io.outcomes.get(id) });
    },
    onAccept(theWorld, tab, io) {
      const { record, state } = parse(io.body);
      const expected = fromText(oracle.liveTables);
      for (const id of io.ids) {
        if (oracle.inFile.has(id)) throw new Error(`F3 ${id} is in the file, and ${tab.id} saved it a second time in ${record.commit}`);
        if (oracle.cutOut.has(id)) throw new Error(`F4 ${id} was in a file that an outside write replaced, and ${tab.id} saved it again in ${record.commit}`);
        if (oracle.shownSaved.has(id)) throw new Error(`F9 ${tab.id} showed ${id} as saved, and saved it again in ${record.commit}`);
        const applied = refStep(expected, oracle.edits.get(id).action);
        if (applied !== io.outcomes.get(id)) throw new Error(`F2 ${tab.id} judged ${id} as ${io.outcomes.get(id) ? "applied" : "refused"} in ${record.commit}, and on the live file it is ${applied ? "applied" : "refused"}`);
      }
      if (canon(state.wb) !== canon(expected)) throw new Error(`F2 file ${record.commit} is not the live file ${oracle.live} plus the edits of ${tab.id}: a saved edit of another tab was overwritten`);
      if (record.parent !== oracle.live) throw new Error(`F2 file ${record.commit} extends ${record.parent}, and the live file is ${oracle.live}`);
      if (resolved(state, io.client) < io.upto) throw new Error(`F5 file ${record.commit} does not record request ${io.upto} of ${io.client}`);
      const ledger = ledgerBytes(state.seen);
      oracle.maxLedger = Math.max(oracle.maxLedger, ledger);
      if (ledger > theWorld.limits.ledgerCap) throw new Error(`M2 the request ledger in ${record.commit} is ${ledger} bytes, over its cap of ${theWorld.limits.ledgerCap}`);
      for (const id of io.ids) {
        oracle.inFile.add(id);
        oracle.everSaved.add(id);
      }
      oracle.versions.push({ tables: canon(state.wb), history: new Set(oracle.inFile) });
      oracle.live = record.commit;
      oracle.liveTables = canon(state.wb);
    },
    onOutside(_, body, at, patch, raw) {
      const { record, state } = parse(body);
      const from = at === "live" ? oracle.versions.at(-1) : oracle.versions[at];
      const expected = fromText(from.tables);
      if (patch) {
        oracle.edits.set(patch.id, { id: patch.id, by: "outside", action: patch.action });
        refStep(expected, patch.action);
      }
      if (canon(state.wb) !== canon(expected)) throw new Error(`F2 outside write ${record.commit} is not version ${at}${patch ? ` with ${patch.id}` : ""}`);
      const kept = new Set(from.history);
      for (const id of oracle.inFile) if (!kept.has(id)) (raw ? oracle.rawLost : oracle.cutOut).add(id);
      if (raw) {
        for (const id of oracle.cutOut) oracle.rawLost.add(id);
        oracle.cutOut.clear();
      }
      if (patch) kept.add(patch.id);
      oracle.inFile = kept;
      oracle.versions.push({ tables: canon(state.wb), history: new Set(kept) });
      oracle.live = record.commit;
      oracle.liveTables = canon(state.wb);
    },
    onRefused(theWorld) {
      theWorld.refused++;
    },
    onCopyBuilt(theWorld, tab, about) {
      if (about.tag !== theWorld.host.etag) throw new Error(`R7 ${tab.id} made recovery copy ${about.recovery} from file ${about.onto}, which the host had already replaced: a tab gives up on a client only on a file it has just read`);
    },
    onCopy(theWorld, tab, copyId, ids) {
      const body = fetchStored(theWorld, copyId);
      if (body === null) throw new Error(`R4 ${tab.id} shows a notice for recovery copy ${copyId}, and the host holds no such copy`);
      const { record: copy, wb: shown } = readPage(body);
      for (const id of ids) if (!copy.edits.some((entry) => entry.e === id)) throw new Error(`R3 the stored recovery copy ${copyId} does not hold ${id}, which a notice lists`);
      const at = Number(String(copy.tag).slice(1));
      const version = theWorld.host.versions[at];
      if (!version || version.commit !== copy.onto) throw new Error(`R3 the stored recovery copy ${copyId} names file ${copy.onto} with ETag ${copy.tag}, which the host never held`);
      const onto = readFile(version.body);
      let last = 0;
      for (const entry of copy.edits) {
        const authored = oracle.edits.get(entry.e);
        const sent = oracle.sent.get(entry.e);
        const about = `the stored recovery copy ${copyId} stores ${entry.e}`;
        if (!ids.includes(entry.e)) throw new Error(`R3 ${about}, and no notice lists it`);
        if (!authored || authored.by !== tab.id || JSON.stringify(refAction(entry.action)) !== JSON.stringify(authored.action)) throw new Error(`R3 ${about} with an action that is not the one ${tab.id} authored`);
        if (JSON.stringify(seenOf(null, entry.action, entry.saw)) !== JSON.stringify(authored.seen)) throw new Error(`R3 ${about} with seen values that differ from what ${tab.id} showed when the edit was made`);
        if (!sent || sent.c !== entry.c || sent.n !== entry.n) throw new Error(`R3 ${about} as request ${entry.n} of ${entry.c}, and its tab last sent it as request ${sent?.n} of ${sent?.c}`);
        if (entry.out !== "unanswered" || entry.src || entry.sent?.[0] !== sent.commit || entry.sent?.[1] !== sent.applied) throw new Error(`R3 ${about} as ${entry.out} from ${entry.sent?.[0]}, and its tab sent it in ${sent.commit} and got no answer`);
        if (entry.n <= last) throw new Error(`R3 ${about} out of the order its tab made the edits in`);
        last = entry.n;
        if (resolved(onto.state, entry.c) >= entry.n) throw new Error(`R7 ${about}, and the ledger of the file it was judged against (${copy.onto}) already resolves that request`);
        oracle.stored++;
        if (oracle.versions[at].history.has(entry.e)) oracle.unprovable++;
        oracle.recovered.set(entry.e, copyId);
      }
      if (canon(shown) !== canon(preview(codecDoc(onto.state.wb), copy.edits))) throw new Error(`R3 the table of the stored recovery copy ${copyId} is not file ${copy.onto} with the stored edits on it`);
      oracle.copies.set(copyId, copy);
      checkFileReplay(oracle, copyId, copy, onto, oracle.versions[at].history, oracle.replays);
    },
  };
  return oracle;
}

const fetchStored = (world, copyId) => world.host.recoveries.find((copy) => copy.id === copyId)?.body ?? null;

function seenOf(wb, action, saw) {
  wb = refDoc(wb);
  action = refAction(action);
  if (action.t === "ins") return null;
  if (action.t === "del") return saw ?? Object.fromEntries(Object.entries(wb.rows[action.row]?.cells ?? {}).filter(([, value]) => value !== "" && value != null));
  return Object.fromEntries(cellsOf(action).map(([row, col], at) => [`${row}/${col}`, saw ? saw[at] : wb.rows[row]?.cells[col] ?? ""]));
}

const fitsRef = (wb, action) => fitsRefOf(refDoc(wb), refAction(action));

const fitsRefOf = (wb, action) => (action.t === "ins" ? !wb.rows[action.row] : action.t === "del" ? Boolean(wb.rows[action.row]) : cellsOf(action).every(([row]) => wb.rows[row]));

function unseen(wb, { action, seen }) {
  wb = refDoc(wb);
  action = refAction(action);
  if (action.t === "ins") return [];
  if (action.t === "del") {
    const now = seenOf(wb, action);
    return Object.keys(seen)
      .sort()
      .filter((col) => (now[col] ?? "") !== seen[col])
      .map((col) => [action.row, col, now[col] ?? "", ""]);
  }
  return cellsOf(action).flatMap(([row, col, value]) => {
    const now = wb.rows[row]?.cells[col] ?? "";
    return now === seen[`${row}/${col}`] ? [] : [[row, col, now, value]];
  });
}

function checkFileReplay(oracle, copyId, copy, file, history, tally) {
  const first = replay(codecFile(file), copy);
  const about = `replaying recovery copy ${copyId} onto ${file.record.commit}`;
  const expected = { wb: fromText(canon(file.state.wb)), seen: structuredClone(file.state.seen) };
  const passed = new Map();
  for (const [index, decision] of first.decisions.entries()) {
    const { e, how } = decision;
    const { c, n } = copy.edits[index];
    const edit = oracle.edits.get(e);
    tally[how]++;
    if (how !== "applied" && how !== "misfit" && how !== "conflict" && how !== "held") continue;
    const stands = Math.max(expected.seen[c]?.[0] ?? 0, passed.get(c) ?? 0);
    if (history.has(e) || oracle.cutOut.has(e)) throw new Error(`R3 ${about} took ${e} as new, and that file's history already holds it`);
    if (stands !== n - 1) throw new Error(`R3 ${about} took ${e} as request ${n} of ${c}, and the count of ${c} stood at ${stands}`);
    if (how === "conflict") {
      const clash = fitsRef(expected.wb, edit.action) ? unseen(expected.wb, edit) : [];
      if (!clash.length) throw new Error(`R8 ${about} left ${e} for a person as a conflict, and every cell it writes still holds the value its author saw`);
      if (JSON.stringify(decision.cells) !== JSON.stringify(clash)) throw new Error(`R8 ${about} reports the conflict of ${e} with cells that are not the current value next to the copy's value in each cell that changed`);
    }
    if (how === "conflict" || how === "held") {
      passed.set(c, n);
      continue;
    }
    delete expected.seen[c];
    expected.seen[c] = [n, file.record.epoch];
    if (fitsRef(expected.wb, edit.action) !== (how === "applied")) throw new Error(`R3 ${about} reports ${e} as ${how}, and that is not what the document says`);
    if (how !== "applied") continue;
    const [clash] = unseen(expected.wb, edit);
    if (clash) throw new Error(`R8 ${about} wrote ${e} into ${clash[0]}/${clash[1]} over ${JSON.stringify(clash[2])}, a value its author did not see`);
    refFold(expected.wb, new Set(), e, edit.action);
  }
  const { state } = first.file;
  if (canon(state.wb) !== canon(expected.wb)) throw new Error(`R3 ${about} returned a document that is not that file with the edits the replay reports as applied`);
  if (JSON.stringify(Object.entries(state.seen).sort()) !== JSON.stringify(Object.entries(expected.seen).sort())) throw new Error(`R3 ${about} returned a ledger that does not count exactly the requests the replay reports as taken`);
  for (const { how, late } of replay(first.file, copy, null, first.marks).decisions) if (!late && (how === "applied" || how === "misfit")) tally.again++;
}

const fromText = (text) => ({ rows: Object.fromEntries(JSON.parse(text).map(([id, pos, cells]) => [id, { pos, cells: Object.fromEntries(cells) }])) });

export function checkFileStep(world) {
  const { oracle } = world;
  const file = get(world.host);
  if (canon(file.state.wb) !== oracle.liveTables) throw new Error(`F2 the host file ${file.record.commit} is not the reference workbook`);
  for (const tab of alive(world)) {
    for (const [id, one] of tab.edits) {
      if (one.state !== "saved") continue;
      if (!oracle.everSaved.has(id)) throw new Error(`F1 ${tab.id} shows ${id} as saved, and no accepted file holds it`);
      oracle.shownSaved.add(id);
    }
  }
}

export function checkFileEnd(world) {
  const { oracle } = world;
  checkFileStep(world);
  const text = oracle.liveTables;
  for (const tab of alive(world)) {
    if (tab.pending.length || tab.io || tab.unknown || tab.unstored.length) throw new Error(`F8 ${tab.id} is not settled`);
    if (canon(view(tab)) !== text) throw new Error(`F6 ${tab.id} differs from the saved file`);
    for (const [id, one] of tab.edits) {
      if (one.state === "saved") {
        if (!oracle.inFile.has(id) && !oracle.cutOut.has(id) && !oracle.rawLost.has(id)) throw new Error(`F7 ${tab.id} shows ${id} as saved, and it is in no file and no replaced version`);
      } else if (one.state === "dropped") {
        if (!tab.notices.some((notice) => notice.kind === "refused" && notice.edits.includes(id) && notice.action === one.action)) throw new Error(`F7 ${id} of ${tab.id} was refused with no notice that holds it`);
      } else if (one.state === "recovered") {
        if (!oracle.recovered.has(id)) throw new Error(`F7 ${id} of ${tab.id} shows a recovery copy that the oracle never read`);
        const body = fetchStored(world, oracle.recovered.get(id));
        const held = body !== null && readPage(body).record.edits.some((entry) => entry.e === id && JSON.stringify(refAction(entry.action)) === JSON.stringify(oracle.edits.get(id).action));
        if (!held) throw new Error(`F7 ${tab.id} shows ${id} as recovered, and no stored recovery copy holds its action`);
      } else {
        throw new Error(`F7 ${id} of open tab ${tab.id} ended as ${one.state}`);
      }
    }
  }
  const final = readFile(world.host.body);
  for (const [copyId, copy] of oracle.copies) checkFileReplay(oracle, copyId, copy, final, oracle.inFile, oracle.atEnd);
  const fresh = open(world);
  if (canon(view(fresh)) !== text) throw new Error("F6 a fresh tab differs from the saved file");
  fresh.alive = false;
  return world;
}

export function finish(world) {
  settleAll(world);
  return checkFileEnd(world);
}
