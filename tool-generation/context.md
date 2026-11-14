# Page tool artifacts

A `page-tool/1` result contains an artifact and initial JSON state. An artifact has exactly six string fields: `title`, `html`, `css`, `javascript`, `fallbackHtml`, and `summary`. Its encoded JSON must fit 24,576 bytes. State must be plain JSON and fit 8,192 bytes. The saved page uses `fallbackHtml`; generated JavaScript runs only in an open editor or reader.

The script defines `mount(tool)` and may return a cleanup function. `tool` supplies `root`, `mode`, `state`, `on("change", fn)`, `on("tables", fn)`, `table(id)`, `tables()`, and tracked `schedule(fn, ms)`. State paths are arrays. A reader gets a local state copy. CSS is scoped to the tool block. Tool code runs with page authority and is not a sandbox.

## Countdown

```json
{
  "title": "Countdown",
  "html": "<strong class=\"count\"></strong>",
  "css": ".count { font-size: 2rem; }",
  "javascript": "function mount(tool) { const count = tool.root.querySelector('.count'); const draw = () => { count.textContent = String(tool.state.data.remaining ?? 0); }; const tick = () => { tool.state.set(['remaining'], Math.max(0, (tool.state.data.remaining ?? 0) - 1)); draw(); if (tool.state.data.remaining > 0) tool.schedule(tick, 1000); }; draw(); if (tool.state.data.remaining > 0) tool.schedule(tick, 1000); return tool.on('change', draw); }",
  "fallbackHtml": "<p>Countdown</p>",
  "summary": "Shows a countdown from the stored remaining seconds."
}
```

## Tally

```json
{
  "title": "Tally",
  "html": "<button type=\"button\">Add one</button><output></output>",
  "css": "button, output { font-size: 1.5rem; }",
  "javascript": "function mount(tool) { const button = tool.root.querySelector('button'); const output = tool.root.querySelector('output'); const draw = () => { output.textContent = String(tool.state.data.count ?? 0); }; const click = () => tool.state.add(['count'], 1); button.addEventListener('click', click); const off = tool.on('change', draw); draw(); return () => { button.removeEventListener('click', click); off(); }; }",
  "fallbackHtml": "<p>Tally</p>",
  "summary": "Counts button presses with the live store add operation."
}
```

## Big number from a table

```json
{
  "title": "Big number",
  "html": "<output class=\"number\"></output>",
  "css": ".number { font-size: 3rem; }",
  "javascript": "function mount(tool) { const output = tool.root.querySelector('output'); const draw = () => { const table = tool.table('revenue'); const values = table?.rows?.map(row => Number(row.cells?.amount)).filter(Number.isFinite) ?? []; output.textContent = String(values.reduce((sum, value) => sum + value, 0)); }; const off = tool.on('tables', draw); draw(); return off; }",
  "fallbackHtml": "<p>Revenue total</p>",
  "summary": "Shows the sum of the amount column in the revenue table."
}
```

# Page tool cookbook

Four extra worked artifacts. They are frozen: hand-authored once before the run and never tuned afterwards.

## Star rating

```json
{
  "title": "Star rating",
  "html": "<div class=\"stars\" role=\"group\" aria-label=\"Star rating\"><button type=\"button\" data-value=\"1\" aria-label=\"1 star\">★</button><button type=\"button\" data-value=\"2\" aria-label=\"2 stars\">★</button><button type=\"button\" data-value=\"3\" aria-label=\"3 stars\">★</button><button type=\"button\" data-value=\"4\" aria-label=\"4 stars\">★</button><button type=\"button\" data-value=\"5\" aria-label=\"5 stars\">★</button></div><output class=\"verdict\"></output>",
  "css": ".stars { display: flex; gap: 0.25rem; } .stars button { font-size: 2rem; line-height: 1; background: none; border: 0; padding: 0.25rem; cursor: pointer; color: #c9c9c9; } .stars button.on { color: #e8a33d; } .verdict { display: block; margin-top: 0.5rem; }",
  "javascript": "function mount(tool) { const buttons = Array.from(tool.root.querySelectorAll('button')); const output = tool.root.querySelector('output'); const draw = () => { const rating = Number(tool.state.data.rating) || 0; for (const button of buttons) { const value = Number(button.dataset.value); button.classList.toggle('on', value <= rating); button.setAttribute('aria-pressed', String(value === rating)); } output.textContent = rating ? rating + ' of 5' : 'No rating yet'; }; const click = (event) => { const value = Number(event.currentTarget.dataset.value); const current = Number(tool.state.data.rating) || 0; tool.state.set(['rating'], current === value ? 0 : value); }; for (const button of buttons) button.addEventListener('click', click); const off = tool.on('change', draw); draw(); return () => { for (const button of buttons) button.removeEventListener('click', click); off(); }; }",
  "fallbackHtml": "<p>Star rating. Open this page in an editor to rate.</p>",
  "summary": "Five stars; clicking one saves the rating in tool state."
}
```

## Poll

```json
{
  "title": "Poll",
  "html": "<p class=\"question\">Which one should we read next?</p><div class=\"options\"><button type=\"button\" data-choice=\"fiction\">Fiction</button><button type=\"button\" data-choice=\"nonfiction\">Non-fiction</button></div><ul class=\"results\"></ul>",
  "css": ".options { display: flex; gap: 0.5rem; flex-wrap: wrap; } button { padding: 0.5rem 0.75rem; } .results { list-style: none; padding: 0; max-width: 22rem; } .results li { display: flex; justify-content: space-between; gap: 1rem; padding: 0.15rem 0; }",
  "javascript": "function mount(tool) { const buttons = Array.from(tool.root.querySelectorAll('button')); const list = tool.root.querySelector('.results'); const labels = { fiction: 'Fiction', nonfiction: 'Non-fiction' }; const draw = () => { const counts = tool.state.data.counts || {}; let total = 0; for (const key of Object.keys(labels)) total += Number(counts[key]) || 0; list.textContent = ''; for (const key of Object.keys(labels)) { const count = Number(counts[key]) || 0; const share = total ? Math.round((count * 100) / total) : 0; const item = tool.root.ownerDocument.createElement('li'); const name = tool.root.ownerDocument.createElement('span'); name.textContent = labels[key] + ': ' + count; const percent = tool.root.ownerDocument.createElement('span'); percent.textContent = share + '%'; item.append(name, percent); list.append(item); } }; const click = (event) => { tool.state.add(['counts', event.currentTarget.dataset.choice], 1); }; for (const button of buttons) button.addEventListener('click', click); const off = tool.on('change', draw); draw(); return () => { for (const button of buttons) button.removeEventListener('click', click); off(); }; }",
  "fallbackHtml": "<p>Poll between two options. Open this page in an editor to vote.</p>",
  "summary": "Two clickable options; each click adds one vote and shows the share."
}
```

## Unit converter

```json
{
  "title": "Distance converter",
  "html": "<div class=\"field\"><label for=\"amount\">Amount</label><input id=\"amount\" type=\"number\" inputmode=\"decimal\" step=\"any\" value=\"0\"></div><div class=\"field\"><label for=\"unit\">Show in</label><select id=\"unit\"><option value=\"km\">kilometres</option><option value=\"mi\">miles</option></select></div><output class=\"result\"></output>",
  "css": ".field { display: flex; flex-direction: column; gap: 0.25rem; margin-bottom: 0.75rem; max-width: 12rem; } input, select { padding: 0.4rem; font-size: 1rem; } .result { display: block; font-size: 1.5rem; }",
  "javascript": "function mount(tool) { const amount = tool.root.querySelector('input'); const unit = tool.root.querySelector('select'); const output = tool.root.querySelector('output'); const draw = () => { const value = Number(tool.state.data.amount); amount.value = tool.state.data.amount === undefined ? '' : String(tool.state.data.amount); unit.value = tool.state.data.unit === 'mi' ? 'mi' : 'km'; if (tool.state.data.amount === undefined || tool.state.data.amount === '' || !Number.isFinite(value)) { output.textContent = 'Enter a number'; return; } const shown = unit.value === 'mi' ? value / 1.609344 : value * 1.609344; output.textContent = (Math.round(shown * 100) / 100) + ' ' + (unit.value === 'mi' ? 'miles' : 'kilometres'); }; const onInput = (event) => tool.state.set(['amount'], event.currentTarget.value); const onUnit = (event) => tool.state.set(['unit'], event.currentTarget.value); amount.addEventListener('input', onInput); unit.addEventListener('change', onUnit); const off = tool.on('change', draw); draw(); return () => { amount.removeEventListener('input', onInput); unit.removeEventListener('change', onUnit); off(); }; }",
  "fallbackHtml": "<p>Converts kilometres to miles and back.</p>",
  "summary": "Type kilometres, read miles, or switch the unit to go the other way."
}
```

## Word counter

```json
{
  "title": "Word counter",
  "html": "<label for=\"text\">Your text</label><textarea id=\"text\" rows=\"5\" placeholder=\"Start typing\"></textarea><output class=\"result\"></output>",
  "css": "textarea { width: 100%; max-width: 32rem; box-sizing: border-box; padding: 0.5rem; font: inherit; } .result { display: block; margin-top: 0.5rem; }",
  "javascript": "function mount(tool) { const text = tool.root.querySelector('textarea'); const output = tool.root.querySelector('output'); const draw = () => { const saved = typeof tool.state.data.text === 'string' ? tool.state.data.text : ''; if (text.value !== saved) text.value = saved; const words = saved.trim() ? saved.trim().split(/\\s+/).length : 0; output.textContent = words + (words === 1 ? ' word' : ' words') + ' · ' + saved.length + ' characters'; }; const onInput = (event) => tool.state.set(['text'], event.currentTarget.value); text.addEventListener('input', onInput); const off = tool.on('change', draw); draw(); return () => { text.removeEventListener('input', onInput); off(); }; }",
  "fallbackHtml": "<p>Counts the words in a text field.</p>",
  "summary": "Keeps the text in state and shows a live word and character count."
}
```
