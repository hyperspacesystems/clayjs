export function newShared(holder) {
  return { holder, owed: new Map(), durable: new Set(), released: 0, losses: 0 };
}

export function shared(oracle, id) {
  if (!oracle.durable.has(id)) oracle.owed.set(id, null);
}

export function durable(oracle, id) {
  oracle.durable.add(id);
  oracle.owed.delete(id);
}

export function roomGone(oracle, carried, holdersOf) {
  oracle.losses++;
  for (const [id, before] of oracle.owed) {
    if (carried.has(id)) {
      oracle.owed.set(id, null);
      continue;
    }
    const holders = holdersOf(id);
    if (!holders.length) {
      oracle.owed.delete(id);
      oracle.released++;
      continue;
    }
    oracle.owed.set(id, new Set([...(before ?? []), ...holders]));
  }
}

const follows = (edits, edit, target) => {
  for (let prior = edit.prior, hops = 0; prior && hops < 100000; hops++) {
    if (prior === target) return true;
    prior = edits.get(prior)?.prior;
  }
  return false;
};

const sameCells = (a, b) => {
  const flat = (cells) => JSON.stringify(Object.entries(cells).filter(([, value]) => value != null && value !== "").sort());
  return flat(a) === flat(b);
};

export function judge(oracle, { edits, alive, views, origin, kept }) {
  const findings = [];
  for (const [id, holders] of oracle.owed) {
    if (holders && ![...holders].some((tab) => alive.has(tab))) {
      oracle.owed.delete(id);
      oracle.released++;
    }
  }
  for (const cells of views) {
    if (!sameCells(cells, views[0])) {
      findings.push({ rule: "S1", text: "two open tabs show different cells after the session settles" });
      break;
    }
  }
  const owed = [...oracle.durable, ...oracle.owed.keys()];
  for (const id of owed) {
    const edit = edits.get(id);
    if (!edit) continue;
    const final = origin[edit.field] ?? null;
    if (final === id) continue;
    const lost = !final ? "no edit is kept for the cell" : follows(edits, edit, final) ? `the cell shows ${final}, which this edit replaced` : null;
    if (!lost) continue;
    findings.push({ rule: oracle.durable.has(id) ? "S2" : "S3", id, field: edit.field, text: lost, kept: kept.has(id) });
  }
  return { findings, obligations: owed.length, released: oracle.released };
}
