// Samples for the codec laws (checkCodec in src/live-room/codec.js): a small list and actions
// on it, including items that are missing, items that already exist, empty texts and text that
// needs escaping. A list holds no empty field, because the reducer never keeps one.
const IDS = ["a1", "a2", "a3", "a4", "a5", 'a<6>"'];
const FIELDS = ["title", "note", "d&ue"];
const TEXTS = ["", "x", "y", "café 🐈", '</span><span data-field="note">&amp;', "</script>", "</li><li>"];

export function sample(random) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const filled = TEXTS.filter((text) => text !== "");
  const fields = (count) => Object.fromEntries(Array.from({ length: count }, () => [pick(FIELDS), pick(filled)]));
  const items = {};
  for (const id of IDS) if (random() < 0.6) items[id] = { at: String(Math.floor(random() * 9)), fields: fields(Math.floor(random() * 4)) };
  const action = () => {
    const kind = pick(["put", "put", "puts", "puts", "add", "cut"]);
    if (kind === "put") return { t: "put", id: pick(IDS), field: pick(FIELDS), text: pick(TEXTS) };
    if (kind === "puts") return { t: "puts", writes: Array.from({ length: Math.floor(random() * 11) }, () => [pick(IDS), pick(FIELDS), pick(TEXTS)]) };
    if (kind === "add") return { t: "add", id: pick(IDS), at: String(Math.floor(random() * 9)), fields: fields(Math.floor(random() * 3)) };
    return { t: "cut", id: pick(IDS) };
  };
  return { doc: { items }, record: { v: 2, doc: "doc0123456789abc", gen: "1.00000001", commit: "c<1" }, actions: Array.from({ length: 8 }, action) };
}
