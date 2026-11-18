import * as S from "./oracle.mjs";
import * as H from "./holder.mjs";

export async function unionDesign(holder, rules) {
  process.env.UNION = rules === "union" ? "1" : "0";
  process.env.STRICT_ACK = "1";
  const P = await import(`../union/union-probe.mjs?rules=${rules}`);
  const oracle = S.newShared(holder);
  const reading = H.newHolder();
  const world = { host: { file: { rev: P.ZERO, recs: [], cells: {}, origin: {}, tag: P.emptyStore() }, version: 0 }, room: null, tabs: [], ids: 0, edits: new Map(), acked: new Set(), durable: new Set(), inflight: [], refetches: 0, accepted: 0, refused: 0, losses: 0 };
  const live = () => world.tabs.filter((tab) => tab.alive);
  const counts = (tab) => tab.alive && (holder === "open" || tab.connected);
  const holdersOf = (stamp) => world.tabs.filter((tab) => counts(tab) && tab.applied.has(stamp)).map((tab) => tab.id);
  const facts = () => {
    for (const [stamp, edit] of world.edits) H.authored(reading, stamp, edit.field, edit.value, world.edits.get(edit.prior)?.value ?? null);
  };
  const shown = () => world.tabs.map((tab) => ({ id: tab.id, alive: tab.alive, cells: tab.cells }));
  world.hooks = {
    shared(stamp) {
      facts();
      S.shared(oracle, stamp);
      H.admitted(reading, stamp);
    },
    durable(stamp) {
      facts();
      S.durable(oracle, stamp);
      H.saved(reading, stamp);
    },
    roomGone(carried) {
      facts();
      S.roomGone(oracle, new Set(carried), holdersOf);
      H.roomGone(reading, shown(), new Set(carried));
    },
  };
  const byName = (id) => world.tabs.find((tab) => tab.id === id);
  return {
    name: rules,
    world,
    live: () => live().map((tab) => tab.id),
    join: () => P.join(world).id,
    edit: (id, field, value) => P.edit(world, byName(id), field, value),
    toRoom: (id) => P.toRoom(world, byName(id)),
    toTab: (id) => P.toTab(world, byName(id)),
    toggle(id) {
      const tab = byName(id);
      if (tab.connected) tab.connected = false;
      else {
        tab.connected = true;
        P.resync(world, tab);
      }
    },
    checkpoint(flushFirst) {
      const tab = live().find((one) => one.connected);
      if (!tab) return;
      if (flushFirst) {
        while (P.toRoom(world, tab));
        while (P.toTab(world, tab));
      }
      P.checkpoint(world, tab);
    },
    answer(refuse) {
      if (world.inflight.length) P.hostAnswer(world, world.inflight.shift(), refuse ? false : undefined);
    },
    close(id) {
      const tab = byName(id);
      tab.alive = false;
      tab.connected = false;
    },
    endRoom(id, save) {
      const tab = byName(id);
      while (P.toRoom(world, tab));
      tab.alive = false;
      tab.connected = false;
      if (save) {
        world.host.file = { ...world.host.file, tag: P.clone(world.room.S) };
        world.host.version++;
      }
      const carried = Object.keys(world.host.file.tag.patches);
      S.roomGone(oracle, new Set(carried), () => []);
      facts();
      H.roomGone(reading, shown(), new Set(carried));
      world.acked = new Set([...world.durable, ...carried]);
      world.room = null;
    },
    roomLoss: () => P.roomLoss(world),
    check(step) {
      for (const tab of world.tabs) P.checkOne(world, tab, `step ${step}`);
    },
    finish() {
      P.settle(world);
      const alive = new Set(live().map((tab) => tab.id));
      let native = null;
      try {
        P.verdict(world);
      } catch (error) {
        native = error.message.slice(0, 200);
      }
      const tabs = live();
      const views = tabs.map((tab) => tab.cells);
      const origin = {};
      for (const [field, stamp] of Object.entries(tabs[0].origin)) if (tabs[0].cells[field] != null) origin[field] = stamp;
      const edits = new Map([...world.edits].map(([stamp, edit]) => [stamp, { field: edit.field, value: edit.value, prior: edit.prior }]));
      const result = S.judge(oracle, { edits, alive, views, origin, kept: new Set() });
      facts();
      const second = H.judge(reading, { alive, file: views[0], copies: [] });
      const notices = world.tabs.reduce((sum, tab) => sum + tab.notices, 0);
      return { ...result, holder: second, cells: views[0], native, edits: edits.size, accepted: world.accepted, refused: world.refused, losses: oracle.losses, notices, copies: 0, meta: { compactPadded: world.maxCompact ?? 0, padded: world.maxMetaPadded ?? 0, stamps: world.maxStamps ?? 0 } };
    },
  };
}
