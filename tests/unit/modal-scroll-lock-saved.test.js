import { jest } from "@jest/globals";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bodies = [];
let save, gate, themodal;

async function text(body) {
  if (typeof body === "string") return body;
  if (body && typeof body.text === "function") return body.text();
  return String(body);
}

beforeAll(async () => {
  window.clayEditMode = true;
  document.documentElement.setAttribute("autosave", "");
  document.body.innerHTML = '<div id="c">a</div>';
  global.fetch = jest.fn(async (url, options) => {
    bodies.push(await text(options?.body));
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ msg: "Saved" }) };
  });
  await import("../../src/core/autosave.js");
  save = await import("../../src/core/save.js");
  gate = await import("../../src/lib/dirty-gate.js");
  themodal = (await import("../../src/ui/modal.js")).default;
  document.body.appendChild(document.createElement("span"));
  for (let i = 0; i < 80 && !save.baselineSettled(); i++) await sleep(50);
  await save.savePage();
  await sleep(1300);
}, 30000);

test("owner edits, opens a dialog, autosave runs while it is open, then the dialog is cancelled", async () => {
  const lockedBody = (html) => /<body[^>]*overflow:\s*hidden/.test(html);
  bodies.length = 0;
  document.getElementById("c").textContent = "owner typed this";
  themodal.html = "Delete this row?";
  themodal.yes = "Delete";
  themodal.no = "Cancel";
  themodal.open();
  await sleep(0);
  const openOverflow = document.body.style.overflow;
  await sleep(3500);
  const whileOpen = bodies.slice();
  themodal.close();
  await sleep(0);
  const dirtyAfterClose = gate.pageMaybeDirty();
  await sleep(4500);
  const afterClose = bodies.slice(whileOpen.length);
  const last = bodies.at(-1) ?? "";
  process.stdout.write(`PROBE saved modal root ${last.includes("data-clay-modal")}; saved body tag ${(last.match(/<body[^>]*>/) || [""])[0]}\n`);
  process.stdout.write(`PROBE overflow while open ${JSON.stringify(openOverflow)}; saves while open ${whileOpen.length}, locked ${whileOpen.map(lockedBody)}; gate dirty after close ${dirtyAfterClose}; saves after close ${afterClose.length}; last saved body locked ${lockedBody(last)}; live overflow ${JSON.stringify(document.body.style.overflow)}\n`);
  expect(whileOpen.length).toBeGreaterThan(0);
  expect(lockedBody(last)).toBe(false);
}, 30000);
