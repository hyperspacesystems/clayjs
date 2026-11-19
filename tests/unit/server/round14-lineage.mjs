import assert from "node:assert/strict";
import { createRooms } from "../../../src/server/rooms/index.js";
import { serializeLive, stampOf } from "../../../src/server/rooms/index.js";

const html = (value, by, epoch = "e1", seq = 1) => `<script type="application/json" merge="s" clay="live" live-at="${stampOf(epoch, seq, serializeLive(value))}" live-by="${by}">${serializeLive(value)}</script>`;
for (const peer of [false, true]) {
  const rooms = createRooms({ newEpoch: () => "e2" });
  const room = rooms.open("doc", html({ n: 1, m: 1 }, "v2|b:1||a:1"));
  if (peer) rooms.apply(room, "b", { name: "s", n: 1, epoch: "e2", ops: [{ op: "add", path: ["n"], n: 100 }] });
  rooms.fileWritten("doc", html({ n: 1, m: 5 }, "v2|b:1|a:1|a:2"));
  rooms.fileWritten("doc", html({ n: 1, m: 9 }, "v2|b:1|a:1-2|a:3"));
  assert.deepEqual(room.stores.get("s").value, { n: peer ? 101 : 1, m: 9 });
}
console.log("Old capture ancestry survives; old frame numbers do not retire new epoch frames.");
