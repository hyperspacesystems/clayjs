const ENTITIES = { quot: '"', gt: ">", lt: "<", amp: "&" };

const plain = (text) => text.replace(/&(quot|gt|lt|amp);/g, (_, name) => ENTITIES[name]);

function attribute(tag, name) {
  const from = tag.indexOf(` ${name}="`) + name.length + 3;
  return plain(tag.slice(from, tag.indexOf('"', from)));
}

export function readPage(body) {
  const mark = '<script type="application/json" id="commit">';
  const script = body.lastIndexOf(mark);
  const record = JSON.parse(body.slice(script + mark.length, body.indexOf("</script>", script)));
  const rows = {};
  for (let at = body.indexOf("<tr "); at >= 0 && at < script; at = body.indexOf("<tr ", at + 1)) {
    const head = body.indexOf(">", at);
    const stop = body.indexOf("</tr>", head);
    const cells = {};
    for (let td = body.indexOf("<td ", head); td >= 0 && td < stop; td = body.indexOf("<td ", td + 1)) {
      const open = body.indexOf(">", td);
      cells[attribute(body.slice(td, open), "data-col")] = plain(body.slice(open + 1, body.indexOf("</td>", open)));
    }
    rows[attribute(body.slice(at, head), "data-id")] = { pos: attribute(body.slice(at, head), "data-pos"), cells };
  }
  return { record, wb: { rows } };
}

export function parse(body) {
  const { record, wb } = readPage(body);
  const { lineage, cut, floor, opened, seen, ...header } = record;
  return { record: header, state: { wb, seen, lineage, cut, floor, ...(opened === undefined ? {} : { opened }) } };
}
