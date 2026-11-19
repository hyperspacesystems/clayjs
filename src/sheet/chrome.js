import {
  bevelBox,
  bevelButton,
  bevelIconButton,
  bevelInput,
  bevelSurface,
  bevelText,
  protectIcon,
  setShown,
} from "../ui/bevel-controls.js";
import { FONT_MONO, FONT_SANS, RULES, TOKENS } from "../ui/bevel.js";
import { resolveTheme } from "../ui/theme.js";
import { mountEditorUI } from "../ui/editor-ui.js";

const LONG_PRESS_MS = 420;

const ICONS = {
  undo: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M224,128a96,96,0,0,1-94.71,96H128A95.38,95.38,0,0,1,62.1,197.8a8,8,0,0,1,11-11.63A80,80,0,1,0,71.43,71.39l-.26.25L44.59,96H72a8,8,0,0,1,0,16H24a8,8,0,0,1-8-8V56a8,8,0,0,1,16,0V85.8L60.25,60A96,96,0,0,1,224,128Z"/></svg>',
  redo: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M240,56v48a8,8,0,0,1-8,8H184a8,8,0,0,1,0-16H211.4L184.81,71.64l-.25-.24a80,80,0,1,0-1.67,114.78,8,8,0,0,1,11,11.63A95.44,95.44,0,0,1,128,224h-1.32A96,96,0,1,1,195.75,60L224,85.8V56a8,8,0,1,1,16,0Z"/></svg>',
  bold: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M178.48,115.7A44,44,0,0,0,148,40H80a8,8,0,0,0-8,8V200a8,8,0,0,0,8,8h80a48,48,0,0,0,18.48-92.3ZM88,56h60a28,28,0,0,1,0,56H88Zm72,136H88V128h72a32,32,0,0,1,0,64Z"/></svg>',
  italic: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M200,56a8,8,0,0,1-8,8H157.77L115.1,192H144a8,8,0,0,1,0,16H64a8,8,0,0,1,0-16H98.23L140.9,64H112a8,8,0,0,1,0-16h80A8,8,0,0,1,200,56Z"/></svg>',
  strike: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M224,128a8,8,0,0,1-8,8H175.93c9.19,7.11,16.07,17.2,16.07,32,0,13.34-7,25.7-19.75,34.79C160.33,211.31,144.61,216,128,216s-32.33-4.69-44.25-13.21C71,193.7,64,181.34,64,168a8,8,0,0,1,16,0c0,17.35,22,32,48,32s48-14.65,48-32c0-14.85-10.54-23.58-38.77-32H40a8,8,0,0,1,0-16H216A8,8,0,0,1,224,128Z"/></svg>',
  fill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M10 12l8-8a2 2 0 0 1 3 3l-8 8ZM10 12c-3-1-5 1-5 4 0 2-2 4-2 4s5 1 8-1c2-1 3-3 2-4"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z"/></svg>',
  wrap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M19 3v12H5m5-5-5 5 5 5"/></svg>',
  filter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M3 5h18l-7 8v6l-4 2v-8Z"/></svg>',
  sort: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg>',
  checkCircle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M8 12l3 3 5-6"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M4 3v18M4 5h11v4.5H4M4 9.5h16V14H4M4 14h8v4.5H4"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M20 20l-4.5-4.5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0"/></svg>',
  close: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>',
  caret: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
};

const GROUPS = [
  {
    name: "history",
    items: [
      { id: "undo", label: "Undo", icon: "undo" },
      { id: "redo", label: "Redo", icon: "redo" },
    ],
  },
  {
    name: "number",
    items: [
      { id: "number-format", label: "Number format", text: "Automatic", caret: true, extra: ["min-width:88px", "justify-content:space-between"] },
      { id: "currency", label: "Format as currency", text: "$", mono: true, square: true },
      { id: "percent", label: "Format as percent", text: "%", mono: true, square: true },
      { id: "decimals-less", label: "Fewer decimal places", text: ".0", mono: true, extra: ["padding:0 8px", "font-size:11px"] },
      { id: "decimals-more", label: "More decimal places", text: ".00", mono: true, extra: ["padding:0 8px", "font-size:11px"] },
    ],
  },
  {
    name: "text",
    items: [
      { id: "bold", label: "Bold", icon: "bold" },
      { id: "italic", label: "Italic", icon: "italic" },
      { id: "strikethrough", label: "Strikethrough", icon: "strike" },
      { id: "text-color", label: "Text color", text: "A", extra: ["width:26px", "padding:0", "font-weight:700"] },
      { id: "fill-color", label: "Fill color", icon: "fill" },
      { id: "borders", label: "Borders", icon: "grid", caret: true },
      { id: "merge", label: "Merge cells", text: "Merge" },
      { id: "align", label: "Horizontal align", text: "Align", caret: true },
      { id: "wrap", label: "Text wrapping", icon: "wrap", text: "Wrap" },
    ],
  },
  {
    name: "data",
    items: [
      { id: "filter", label: "Filter", icon: "filter", text: "Filter" },
      { id: "sort", label: "Sort", icon: "sort", text: "Sort", caret: true },
      { id: "checkbox", label: "Insert checkbox", icon: "checkCircle", text: "Check" },
      { id: "chart", label: "Insert chart", icon: "chart", text: "Chart" },
      { id: "find", label: "Find and replace", icon: "search", text: "Find" },
    ],
  },
  {
    name: "trailing",
    trailing: true,
    items: [
      { id: "import", label: "Import or export", text: "Import / Export", caret: true },
    ],
  },
];

function appendSvg(parent, markup, size) {
  const holder = parent.ownerDocument.createElement("span");
  holder.innerHTML = markup;
  const svg = holder.firstElementChild;
  if (svg) {
    protectIcon(svg, size);
    parent.append(svg);
  }
}

function makeToolButton(spec, theme, onCommand) {
  const iconOnly = Boolean(spec.icon && !spec.text && !spec.caret);
  const baseExtra = iconOnly
    ? ["width:26px", "height:26px", "padding:0", "display:inline-grid", "place-items:center"]
    : [
        "height:26px",
        "padding:0 8px",
        "gap:4px",
        "font-size:12px",
        ...(spec.mono ? [`font-family:${FONT_MONO}`, "font-variant-numeric:tabular-nums"] : []),
        ...(spec.square ? ["width:26px", "padding:0"] : []),
        ...(spec.extra ?? []),
      ];
  const stateExtra = [...baseExtra];
  const btn = bevelButton(spec.text ?? "", {
    small: true,
    onClick: () => onCommand(spec.id),
    theme,
    parts: ["sheet.tool"],
    extra: stateExtra,
    labelExtra: iconOnly
      ? ["display:inline-grid", "width:12px", "height:12px"]
      : ["display:inline-flex", "align-items:center", "gap:4px"],
  });
  const span = btn.firstChild;
  span.textContent = "";
  let textEl = null;
  if (iconOnly) {
    span.innerHTML = ICONS[spec.icon];
    protectIcon(span.firstElementChild, 12);
  } else {
    if (spec.icon) appendSvg(span, ICONS[spec.icon], 14);
    if (spec.text) {
      textEl = bevelText("span", ["font:inherit", "color:inherit"], spec.text, { theme, role: null });
      span.append(textEl);
    }
    if (spec.caret) appendSvg(span, ICONS.caret, 11);
  }
  btn.setAttribute("aria-label", spec.label);
  btn.title = spec.label;
  btn.setAttribute("data-command", spec.id);
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  return { btn, textEl, baseExtra, stateExtra, pressed: false };
}

export function createChrome({
  scrollBox,
  commands = {},
  onSelectTab,
  onTabMenu,
  onRenameTab,
  onRenameTabStart,
  onCommit,
  onCancel,
} = {}) {
  const doc = scrollBox.ownerDocument ?? document;
  const parent = scrollBox.parentElement ?? doc.body;
  const theme = resolveTheme();
  const registry = new Map(Object.entries(commands));
  const buttons = new Map();
  const buttonMeta = new Map();
  let longPressTimer = null;

  const clearLongPress = () => {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };

  const topRoot = bevelBox("div", [
    "display:block",
    "width:100%",
    `color-scheme:${theme.scheme}`,
    `font:13px/1.4 ${FONT_SANS}`,
    `background:${TOKENS.ground}`,
    `color:${TOKENS.ink}`,
  ], { theme });

  const toolbar = bevelBox("div", [
    "display:flex",
    "align-items:center",
    "flex-wrap:wrap",
    "gap:4px",
    "min-height:36px",
    "padding:4px 10px",
    `background:${TOKENS.ground}`,
    `border-bottom:1px solid ${TOKENS["line-2"]}`,
  ], { theme, role: "well" });
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Formatting and sheet tools");

  GROUPS.forEach((group, gIdx) => {
    if (gIdx > 0 && !group.trailing) {
      const sep = bevelBox("span", [
        "display:inline-block",
        "width:1px",
        "height:18px",
        "margin:0 4px",
        "flex:none",
        `background:${TOKENS["line-2"]}`,
      ], { theme });
      sep.setAttribute("aria-hidden", "true");
      toolbar.append(sep);
    }
    const groupEl = bevelBox("div", [
      "display:inline-flex",
      "align-items:center",
      "gap:3px",
      ...(group.trailing ? ["margin-inline-start:auto"] : []),
    ], { theme });
    groupEl.setAttribute("data-toolbar-group", group.name);
    for (const spec of group.items) {
      const meta = makeToolButton(spec, theme, (id) => registry.get(id)?.());
      meta.btn.setDisabled(!registry.has(spec.id));
      buttons.set(spec.id, meta.btn);
      buttonMeta.set(spec.id, meta);
      groupEl.append(meta.btn);
    }
    toolbar.append(groupEl);
  });

  const formulaBar = bevelBox("div", [
    "display:flex",
    "align-items:center",
    "gap:6px",
    "height:30px",
    "padding:0 8px",
    `background:${TOKENS.surface}`,
    `border-bottom:1px solid ${TOKENS["line-2"]}`,
  ], { theme });

  const nameBox = bevelBox("div", [
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "min-width:66px",
    "height:22px",
    "padding:0 6px",
    `background:${TOKENS.sunk}`,
    `border:1px solid ${TOKENS["line-2"]}`,
    `font:600 12px/1 ${FONT_MONO}`,
    "font-variant-numeric:tabular-nums",
    `color:${TOKENS.ink}`,
  ], { theme, role: "well" });
  nameBox.setAttribute("data-sheet-name-box", "");
  nameBox.title = "Active cell";

  const fxActions = bevelBox("div", ["display:inline-flex", "align-items:center", "gap:2px"], { theme });
  const cancelBtn = bevelIconButton(ICONS.close, { label: "Cancel edit", onClick: () => onCancel?.(), theme });
  cancelBtn.addEventListener("mousedown", (e) => e.preventDefault());
  const commitBtn = bevelIconButton(ICONS.check, { label: "Commit edit", onClick: () => onCommit?.(), theme });
  commitBtn.addEventListener("mousedown", (e) => e.preventDefault());
  cancelBtn.setDisabled(true);
  commitBtn.setDisabled(true);
  fxActions.append(cancelBtn, commitBtn);

  const fxBadge = bevelText("span", [
    "display:inline-block",
    "padding:0 4px",
    `font:italic 600 13px/1 Georgia,serif`,
    `color:${TOKENS.muted}`,
    `border-right:1px solid ${TOKENS.line}`,
  ], "fx", { theme, role: "mutedText" });
  fxBadge.setAttribute("aria-hidden", "true");

  const monoTheme = {
    ...theme,
    parts: {
      ...theme.parts,
      "sheet.formulaInput": { ...theme.parts?.["sheet.formulaInput"], base: { ...theme.parts?.["sheet.formulaInput"]?.base, "font-family": FONT_MONO } },
    },
  };
  const formulaInput = bevelInput("textarea", {
    theme: monoTheme,
    rules: [
      "flex:1 1 auto",
      "min-width:0",
      "height:22px",
      "block-size:22px",
      "padding:0 8px",
      `font:400 12.5px/22px ${FONT_MONO}`,
      "font-variant-numeric:tabular-nums",
      "resize:none",
      "overflow:hidden",
      "white-space:pre",
    ],
    parts: ["sheet.formulaInput"],
  });
  formulaInput.rows = 1;
  formulaInput.spellcheck = false;
  formulaInput.setAttribute("autocomplete", "off");
  formulaInput.setAttribute("aria-label", "Formula bar");

  formulaBar.append(nameBox, fxActions, fxBadge, formulaInput);

  const noticeText = bevelText("span", ["flex:1 1 auto", `font:500 12.5px/1.4 ${FONT_SANS}`, `color:${TOKENS.ox}`], "", { theme });
  const noticeDismiss = bevelButton("Dismiss", {
    small: true,
    variant: "quiet",
    onClick: () => hideNotice(),
    theme,
  });
  noticeDismiss.addEventListener("mousedown", (e) => e.preventDefault());
  const noticeBar = bevelSurface("div", [
    "display:none",
    "align-items:center",
    "justify-content:space-between",
    "gap:10px",
    "padding:6px 10px",
    `background:${TOKENS["ox-soft"]}`,
    `border:1px solid ${TOKENS.ox}`,
    "box-shadow:none",
  ], { theme });
  noticeBar.setAttribute("role", "alert");
  noticeBar.setAttribute("data-sheet-notice", "");
  noticeBar.hidden = true;
  noticeBar.append(noticeText, noticeDismiss);

  topRoot.append(toolbar, formulaBar, noticeBar);

  const bottomRoot = bevelBox("div", [
    "display:flex",
    "align-items:stretch",
    "justify-content:space-between",
    "gap:8px",
    "min-height:30px",
    "padding:0 10px",
    `color-scheme:${theme.scheme}`,
    `background:${TOKENS.sunk}`,
    `border-top:1px solid ${TOKENS["line-2"]}`,
    `font:12px/1.3 ${FONT_SANS}`,
    `color:${TOKENS.ink}`,
  ], { theme, role: "well" });

  const tabStrip = bevelBox("div", [
    "display:flex",
    "align-items:stretch",
    "gap:2px",
    "overflow-x:auto",
  ], { theme });
  tabStrip.setAttribute("role", "tablist");
  tabStrip.setAttribute("aria-label", "Workbook sheets");

  const addTabBtn = bevelButton("+", {
    small: true,
    variant: "quiet",
    onClick: () => registry.get("add-tab")?.(),
    theme,
    extra: ["width:28px", "height:28px", "padding:0"],
  });
  addTabBtn.setAttribute("aria-label", "Add sheet");
  addTabBtn.setAttribute("data-command", "add-tab");
  addTabBtn.setDisabled(!registry.has("add-tab"));
  addTabBtn.addEventListener("mousedown", (e) => e.preventDefault());
  buttons.set("add-tab", addTabBtn);

  const tabsHolder = bevelBox("div", ["display:inline-flex", "align-items:center", "gap:2px"], { theme });
  tabStrip.append(addTabBtn, tabsHolder);

  const statusText = bevelText("div", [
    "display:inline-flex",
    "align-items:center",
    `font:500 11.5px/1 ${FONT_MONO}`,
    "font-variant-numeric:tabular-nums",
    `color:${TOKENS["ink-2"]}`,
  ], "", { theme, role: "mutedText" });
  statusText.setAttribute("data-sheet-status", "");

  bottomRoot.append(tabStrip, statusText);

  const topUI = mountEditorUI({
    name: "sheet-top",
    content: topRoot,
    parent,
    before: scrollBox,
    attributes: { "sap-ignore": "" },
  });
  const bottomUI = mountEditorUI({
    name: "sheet-bottom",
    content: bottomRoot,
    parent,
    before: scrollBox.nextSibling,
    attributes: { "sap-ignore": "" },
  });

  function showNotice(message) {
    noticeText.textContent = message;
    setShown(noticeBar, true, "flex");
  }

  function hideNotice() {
    noticeText.textContent = "";
    setShown(noticeBar, false, "flex");
  }

  function setEditing(editing) {
    cancelBtn.setDisabled(!editing);
    commitBtn.setDisabled(!editing);
  }

  function setCoord(area) {
    if (nameBox.textContent !== area) nameBox.textContent = area;
    const status = `Range: ${area}`;
    if (statusText.textContent !== status) statusText.textContent = status;
  }

  function setButtonPressed(id, pressed) {
    const meta = buttonMeta.get(id);
    if (!meta) return;
    const next = Boolean(pressed);
    const val = next ? "true" : "false";
    if (meta.btn.getAttribute("aria-pressed") === val && meta.pressed === next) return;
    meta.pressed = next;
    meta.btn.setAttribute("aria-pressed", val);
    meta.stateExtra.splice(0, meta.stateExtra.length, ...meta.baseExtra, ...(next ? RULES.recess : []));
    meta.btn.pin({});
  }

  function setButtonText(id, text, ariaLabel) {
    const meta = buttonMeta.get(id);
    if (!meta) return;
    if (meta.textEl && meta.textEl.textContent !== text) meta.textEl.textContent = text;
    if (ariaLabel && meta.btn.getAttribute("aria-label") !== ariaLabel) {
      meta.btn.setAttribute("aria-label", ariaLabel);
      meta.btn.title = ariaLabel;
    }
  }

  let lastTabsKey = "";
  let currentTabs = [];
  let currentActiveId = "";
  let renaming = null;

  function finishRenameUI() {
    if (!renaming) return;
    renaming = null;
    lastTabsKey = "";
    renderTabs(currentTabs, currentActiveId);
  }

  function startRenameTab(tabId) {
    const tab = currentTabs.find((t) => t.id === tabId);
    if (!tab) return null;
    if (renaming) {
      if (renaming.tabId === tabId) {
        renaming.input.focus();
        return renaming.input;
      }
      finishRenameUI();
    }
    const tabBtn = [...tabsHolder.children].find((el) => el.getAttribute("data-tab-id") === tabId);
    if (!tabBtn) return null;

    const input = bevelInput("input", {
      theme,
      rules: [
        "display:inline-block",
        "width:116px",
        "height:26px",
        "block-size:26px",
        "min-block-size:26px",
        "padding:0 8px",
        `font:500 12px/24px ${FONT_SANS}`,
      ],
    });
    input.value = tab.name;
    input.setAttribute("aria-label", "Rename sheet");
    input.setAttribute("data-tab-rename", tabId);

    let settled = false;
    const commit = () => {
      if (settled || renaming?.input !== input) return false;
      settled = true;
      if (onRenameTab?.(tabId, input.value) === false) {
        settled = false;
        input.focus();
        return false;
      }
      finishRenameUI();
      return true;
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        commit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        settled = true;
        finishRenameUI();
        onRenameTab?.(tabId, null);
      }
    });
    input.addEventListener("blur", () => {
      commit();
    });

    renaming = { tabId, input, commit };
    tabBtn.replaceWith(input);
    input.focus();
    input.select?.();
    return input;
  }

  function renderTabs(tabs, activeId) {
    currentTabs = tabs;
    currentActiveId = activeId;
    const key = `${activeId}\u0000${tabs.map((t) => `${t.id}:${t.name}`).join("\u0000")}`;
    if (key === lastTabsKey) return;
    renaming = null;
    lastTabsKey = key;
    tabsHolder.textContent = "";
    for (const tab of tabs) {
      const selected = tab.id === activeId;
      const btn = bevelButton(tab.name, {
        small: true,
        variant: selected ? "default" : "quiet",
        onClick: () => onSelectTab?.(tab.id),
        theme,
        parts: ["sheet.tab"],
        extra: [
          "height:28px",
          "padding:0 12px",
          "font-size:12px",
          ...(selected ? [`background:${TOKENS.surface}`, `color:${TOKENS.ink}`, "font-weight:600"] : []),
        ],
      });
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", selected ? "true" : "false");
      btn.setAttribute("data-tab-id", tab.id);
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("dblclick", (e) => {
        e.preventDefault();
        if (onRenameTabStart) onRenameTabStart(tab.id);
        else startRenameTab(tab.id);
      });
      btn.addEventListener("keydown", (e) => {
        if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
          e.preventDefault();
          onTabMenu?.(tab.id, btn, 0, 0);
        }
      });
      btn.addEventListener("contextmenu", (e) => {
        clearLongPress();
        e.preventDefault();
        e.stopPropagation();
        onTabMenu?.(tab.id, btn, e.clientX ?? 0, e.clientY ?? 0);
      });
      btn.addEventListener("pointerdown", (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        clearLongPress();
        const x = e.clientX ?? 0;
        const y = e.clientY ?? 0;
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          onTabMenu?.(tab.id, btn, x, y);
        }, LONG_PRESS_MS);
      });
      for (const evt of ["pointerup", "pointerleave", "pointercancel"]) {
        btn.addEventListener(evt, clearLongPress);
      }
      tabsHolder.append(btn);
    }
  }

  function registerCommand(id, fn) {
    if (typeof fn === "function") registry.set(id, fn);
    else registry.delete(id);
    buttons.get(id)?.setDisabled(!registry.has(id));
  }

  return {
    theme,
    topRoot,
    topHost: topUI.host,
    bottomHost: bottomUI.host,
    topShadow: topUI.shadow,
    bottomShadow: bottomUI.shadow,
    formulaInput,
    nameBox,
    noticeBar,
    tabStrip,
    statusText,
    showNotice,
    hideNotice,
    setEditing,
    setCoord,
    setButtonPressed,
    setButtonText,
    getButton: (id) => buttons.get(id) ?? null,
    startRenameTab,
    commitRename: () => renaming?.commit?.() ?? false,
    renderTabs,
    registerCommand,
    dispose() {
      clearLongPress();
      renaming = null;
      topUI.remove();
      bottomUI.remove();
    },
  };
}
