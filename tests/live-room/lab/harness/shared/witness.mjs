import { orderedDesign } from "./ordered.mjs";
import { unionDesign } from "./union.mjs";

const makers = {
  current: (holder) => unionDesign(holder, "current"),
  union: (holder) => unionDesign(holder, "union"),
  ordered: (holder) => orderedDesign(holder),
};

const flow = (design, ...tabs) => {
  for (let moved = true; moved; ) {
    moved = false;
    for (const tab of tabs) while (design.toRoom(tab)) moved = true;
    for (const tab of tabs) while (design.toTab(tab)) moved = true;
  }
};

async function boot(make) {
  const design = await make("connected");
  const a = design.join();
  const b = design.join();
  for (let i = 0; i < 4; i++) design.answer(false);
  flow(design, a, b);
  return { design, a, b };
}

const WITNESSES = {
  async "author closes, a holder stays, the room is lost"(make) {
    const { design, a, b } = await boot(make);
    design.edit(a, "r1/c1", "row");
    flow(design, a, b);
    design.edit(b, "r1/c2", "keep me");
    flow(design, a, b);
    design.close(a);
    design.roomLoss();
    const result = design.finish();
    const kept = result.cells["r1/c1"] === "row" && result.cells["r1/c2"] === "keep me";
    return { kept, cells: result.cells, findings: result.findings.length, native: result.native };
  },

  async "a holder that was offline at the loss comes back"(make) {
    const { design, a, b } = await boot(make);
    design.edit(a, "r2/c1", "held offline");
    flow(design, a, b);
    design.toggle(b);
    design.close(a);
    design.roomLoss();
    design.toggle(b);
    const result = design.finish();
    return { kept: result.cells["r2/c1"] === "held offline", cells: result.cells, findings: result.findings.length, native: result.native };
  },

  async "every tab closes, then the room is lost"(make) {
    const { design, a, b } = await boot(make);
    design.edit(a, "r3/c1", "nobody holds this");
    flow(design, a, b);
    design.close(a);
    design.endRoom(b, false);
    design.join();
    const result = design.finish();
    return { kept: result.cells["r3/c1"] === "nobody holds this", cells: result.cells, findings: result.findings.length, native: result.native };
  },
};

const rows = [];
for (const [name, play] of Object.entries(WITNESSES)) {
  const row = { witness: name };
  for (const [design, make] of Object.entries(makers)) row[design] = await play(make);
  rows.push(row);
}
console.log(JSON.stringify(rows));
for (const row of rows) console.log(`${row.witness}: ${Object.keys(makers).map((design) => `${design} ${row[design].kept ? "kept" : "lost"}${row[design].findings ? ` (${row[design].findings} oracle findings)` : ""}`).join(", ")}`);
