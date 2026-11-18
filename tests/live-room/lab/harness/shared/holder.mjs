export function newHolder() {
  return { facts: new Map(), first: new Map(), saved: new Set(), volatile: new Set(), holders: new Map(), ordinal: 0 };
}

export function authored(reading, id, field, value, prior) {
  if (reading.facts.has(id)) return;
  const fact = { id, field, value, prior, at: ++reading.ordinal };
  reading.facts.set(id, fact);
  if (!reading.first.has(value)) reading.first.set(value, fact);
}

export function admitted(reading, id) {
  if (reading.facts.has(id)) reading.volatile.add(id);
}

export function saved(reading, id) {
  if (reading.facts.has(id)) reading.saved.add(id);
}

export function follows(reading, value, target) {
  const seen = new Set();
  while (value != null && !seen.has(value)) {
    if (value === target) return true;
    seen.add(value);
    value = reading.first.get(value)?.prior;
  }
  return false;
}

export function roomGone(reading, tabs, carried = new Set()) {
  for (const id of reading.volatile) {
    if (carried.has(id)) continue;
    const fact = reading.facts.get(id);
    const holders = reading.holders.get(id) ?? new Set();
    for (const tab of tabs) if (tab.alive && follows(reading, tab.cells[fact.field], fact.value)) holders.add(tab.id);
    reading.holders.set(id, holders);
    reading.volatile.delete(id);
  }
}

export function judge(reading, { alive, file, copies }) {
  const required = new Set([...reading.saved, ...reading.volatile]);
  for (const [id, holders] of reading.holders) if ([...holders].some((tab) => alive.has(tab))) required.add(id);
  const findings = [];
  const read = (fact, views) => {
    const shown = views.map((cells) => cells[fact.field]).filter((value) => value != null);
    if (!shown.length) return "H3";
    return shown.some((value) => value === fact.value || !follows(reading, fact.value, value)) ? null : "H9";
  };
  for (const id of required) {
    const fact = reading.facts.get(id);
    const rule = read(fact, [file]);
    if (rule) findings.push({ rule, id, field: fact.field, value: fact.value, shown: file[fact.field] ?? null, kept: !read(fact, [file, ...copies]) });
  }
  return { findings, required: required.size };
}
