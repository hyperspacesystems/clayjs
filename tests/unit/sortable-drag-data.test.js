/**
 * @jest-environment jsdom
 */

/**
 * A reorder is not a text drag.
 *
 * SortableJS writes the item's text onto the native drag by default, so a rich text field
 * under the drop pastes it in: a block of links doubles inside itself, and dropping a "PDF"
 * link onto a title writes "PDF" into the title. ClayJS's sortable gives the vendor its own
 * setData, which empties the drag and marks it with a private type no field reads.
 *
 * The module is the real one, booted in edit mode the way sortable-editor-ui.test.js boots it.
 */

const FIXTURE = `
  <ul id="list" sortable>
    <li id="one">One</li>
    <li id="two">PDF</li>
  </ul>
`;

let sortable;

beforeAll(async () => {
  window.clayEditMode = true;
  document.body.innerHTML = FIXTURE;
  sortable = await import("../../src/plugins/sortable.js");
  await sortable.ready;
}, 15000);

afterAll(() => {
  delete window.clayEditMode;
});

test("a drag carries no text", () => {
  const list = document.getElementById("list");
  const instance = window.Sortable.get(list);
  expect(instance).toBeTruthy();
  expect(typeof instance.options.setData).toBe("function");

  const transfer = {
    types: ["text/plain", "text/html"],
    data: { "text/plain": "x", "text/html": "<a>x</a>" },
    clearData() { this.data = {}; this.types = []; },
    setData(type, value) { this.data[type] = value; this.types.push(type); },
  };

  instance.options.setData(transfer, document.getElementById("one"));

  expect(transfer.types).toEqual(["application/x-clay-sortable"]);
  expect(transfer.data).not.toHaveProperty("text/plain");
  expect(transfer.data).not.toHaveProperty("Text");
  expect(transfer.data).not.toHaveProperty("text/html");
});
