import { newWorld, live, writer, join, userEdit, setConnected, close, roomLoss, endRoom, settle, view, toRoom, toTab, capture, answer, checkStep } from "../world.mjs";
import { checkEnd, account } from "../oracle.mjs";
import { parse } from "../../core/record.mjs";
import { frameId } from "../../core/tab.mjs";
import { readRecovery } from "../host.mjs";
import { cellsOf as written } from "../../codec-tiny/reducer.mjs";
import * as S from "./oracle.mjs";
import * as H from "./holder.mjs";

const emptyWorkbook = () => ({ rows: Object.fromEntries([1, 2, 3, 4].map((r) => [`r${r}`, { pos: `${r}`, cells: {} }])) });

const cellsOf = (wb) => {
  const cells = {};
  for (const [row, { cells: values }] of Object.entries(wb.rows)) for (const [col, value] of Object.entries(values)) cells[`${row}/${col}`] = value;
  return cells;
};

export function orderedDesign(holder, eager = false) {
  const oracle = S.newShared(holder);
  const reading = H.newHolder();
  const world = newWorld({ workbook: emptyWorkbook(), mode: "ordered" });
  const edits = new Map();
  const byValue = new Map();
  const admitted = new Map();
  const own = world.oracle;
  const { onAdmit, onAccept, onRoomLoss } = own;
  const counts = (tab) => tab.alive && (holder === "open" || tab.connected);
  const holdersOf = (id) =>
    world.tabs
      .filter((tab) => {
        if (!counts(tab)) return false;
        const mine = tab.edits.get(id);
        if (mine && (mine.state === "pending" || mine.state === "shared")) return true;
        const has = (frame) => !frame.noop && frameId(frame) === id;
        return tab.tail.some(has) || tab.held.some((held) => held.frames.some(has));
      })
      .map((tab) => tab.id);
  own.onAdmit = (theWorld, room, frame, result, sent, by) => {
    onAdmit(theWorld, room, frame, result, sent, by);
    if (!frame.action) return;
    if (!admitted.has(room.gen)) admitted.set(room.gen, []);
    admitted.get(room.gen).push([frame.seq, frameId(frame)]);
    S.shared(oracle, frameId(frame));
    H.admitted(reading, frameId(frame));
  };
  own.onAccept = (theWorld, body, kind) => {
    onAccept(theWorld, body, kind);
    const { record } = parse(body);
    for (const [seq, id] of admitted.get(record.gen) ?? []) {
      if (seq > record.through) continue;
      S.durable(oracle, id);
      H.saved(reading, id);
    }
  };
  own.onRoomLoss = (theWorld, room, why) => {
    onRoomLoss(theWorld, room, why);
    S.roomGone(oracle, new Set(), holdersOf);
    H.roomGone(reading, world.tabs.map((tab) => ({ id: tab.id, alive: tab.alive, cells: tab.state ? cellsOf(view(tab)) : {} })));
  };
  const byName = (id) => world.tabs.find((tab) => tab.id === id);
  return {
    name: "ordered",
    world,
    live: () => live(world).map((tab) => tab.id),
    join: () => join(world).id,
    edit(id, field, value) {
      const tab = byName(id);
      const [row, col] = field.split("/");
      const before = view(tab).rows[row].cells[col] ?? null;
      const prior = byValue.get(before) ?? null;
      const edit = userEdit(world, tab, { t: "set", row, col, value });
      edits.set(edit, { field, value, prior });
      H.authored(reading, edit, field, value, before);
      byValue.set(value, edit);
    },
    toRoom: (id) => toRoom(world, byName(id)),
    toTab: (id) => toTab(world, byName(id)),
    toggle(id) {
      const tab = byName(id);
      setConnected(world, tab, !tab.connected);
    },
    checkpoint(flushFirst) {
      const tab = writer(world);
      if (!tab) return;
      if (flushFirst) {
        while (toRoom(world, tab));
        while (toTab(world, tab));
      }
      capture(world, tab);
    },
    answer(refuse) {
      if (world.inflight.length) answer(world, refuse ? "refuse" : "ok", 0);
    },
    close: (id) => close(world, byName(id)),
    endRoom(id, save) {
      const tab = byName(id);
      while (toRoom(world, tab));
      endRoom(world, tab, save);
    },
    roomLoss: () => roomLoss(world),
    check() {
      for (let at; eager && !world.room?.gen && (at = world.inflight.findIndex((sent) => sent.io.kind === "establish")) >= 0; ) answer(world, "ok", at);
      checkStep(world);
    },
    finish() {
      settle(world);
      const alive = new Set(live(world).map((tab) => tab.id));
      let native = null;
      try {
        checkEnd(world, join);
      } catch (error) {
        native = error.message;
      }
      const views = live(world).map((tab) => cellsOf(view(tab)));
      const origin = {};
      for (const [field, value] of Object.entries(views[0])) origin[field] = byValue.get(value) ?? null;
      const kept = new Set(own.recovered.keys());
      const notices = world.tabs.reduce((sum, tab) => sum + tab.notices.length, 0);
      const result = S.judge(oracle, { edits, alive, views, origin, kept });
      const copies = world.host.recoveries.flatMap(({ id }) => {
        const copy = readRecovery(world.host, id);
        return [cellsOf(copy.preview), ...copy.edits.map((entry) => Object.fromEntries(written(entry.action).map(([row, col, value]) => [`${row}/${col}`, value])))];
      });
      const second = H.judge(reading, { alive, file: views[0], copies });
      const outcome = account(world);
      return { ...result, holder: second, cells: views[0], native, edits: edits.size, accepted: world.accepted, refused: world.refused, losses: oracle.losses, notices, copies: world.copies, outcome };
    },
  };
}
