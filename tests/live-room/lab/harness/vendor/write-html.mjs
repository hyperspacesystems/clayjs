// The writer: prints the saved file format of ARCHITECTURE.md section 1 byte for
// byte. Every choice here is fixed so two runs give the same string.

const textEscape = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const attrEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

const attr = (name, value) => ` ${name}="${attrEscape(value)}"`;

export function cellHtml(cell) {
  if (!cell) return "<td></td>";
  let attrs = "";
  if (cell.n) attrs += " n";
  if (cell.t) attrs += " t";
  if (cell.f !== undefined) attrs += attr("f", cell.f);
  if (cell.v !== undefined) attrs += attr("v", cell.v);
  if (cell.fmt !== undefined) attrs += attr("fmt", cell.fmt);
  if (cell.colspan !== undefined) attrs += attr("colspan", cell.colspan);
  if (cell.rowspan !== undefined) attrs += attr("rowspan", cell.rowspan);
  if (cell.hidden) attrs += " hidden";
  if (cell.style !== undefined) attrs += attr("style", cell.style);
  return `<td${attrs}>${textEscape(cell.text)}</td>`;
}

export function rowHtml(row) {
  const cells = [...row.cells];
  while (cells.length > 0 && cells[cells.length - 1] === null) cells.pop();
  const trAttrs =
    attr("data-id", row.id) +
    attr("data-pos", row.pos) +
    (row.style !== undefined ? attr("style", row.style) : "");
  return `<tr${trAttrs}>${cells.map(cellHtml).join("")}</tr>`;
}

export function colHtml(col) {
  let attrs = attr("data-id", col.id) + attr("data-pos", col.pos);
  if (col.fmt !== undefined) attrs += attr("fmt", col.fmt);
  if (col.width !== undefined) attrs += attr("style", `width:${col.width}px`);
  return `<col${attrs}>`;
}

export function tableHtml(sheet, { groupSize = 50, rowBreak = "\n" } = {}) {
  const cols = sheet.cols ?? [];
  const frozen = (sheet.rows ?? []).filter((row) => row.frozen);
  const data = (sheet.rows ?? []).filter((row) => !row.frozen);

  let html = `<table grid${sheet.freezeCols ? attr("freeze-cols", sheet.freezeCols) : ""}>`;
  html += `<colgroup>${cols.map(colHtml).join("")}</colgroup>${rowBreak}`;

  if (frozen.length > 0) {
    html += `<thead>${rowBreak}${frozen.map(rowHtml).join(rowBreak)}${rowBreak}</thead>`;
  }

  const groups = Math.max(1, Math.ceil(data.length / groupSize));
  for (let g = 0; g < groups; g++) {
    const group = data.slice(g * groupSize, (g + 1) * groupSize);
    html += `<tbody>${rowBreak}`;
    if (group.length > 0) html += group.map(rowHtml).join(rowBreak) + rowBreak;
    html += `</tbody>`;
  }

  return html + `</table>`;
}

function sectionHtml(sheet, options) {
  return (
    `<section item${attr("data-id", sheet.id)}${attr("data-pos", sheet.pos)}>` +
    `<h2 bind="name">${textEscape(sheet.name)}</h2>` +
    tableHtml(sheet, options) +
    `</section>`
  );
}

export function toHtml(workbook, { groupSize = 50, rowBreak = "\n", shell = true } = {}) {
  const sections = workbook.sheets.map((sheet) => sectionHtml(sheet, { groupSize, rowBreak }));
  if (!shell) return sections.join("\n");

  return (
    `<!DOCTYPE html>\n` +
    `<html lang="en">\n` +
    `<head>\n` +
    `<meta charset="utf-8">\n` +
    `<title>Sheet</title>\n` +
    `</head>\n` +
    `<body>\n` +
    `<main sap${attr("data-rev", workbook.rev)}>\n` +
    `<div items="sheets">\n` +
    sections.join("\n") +
    `\n</div>\n` +
    `</main>\n` +
    `<script type="application/json" merge="sheet" clay="live">${JSON.stringify(workbook.tag)}</script>\n` +
    `</body>\n` +
    `</html>\n`
  );
}
