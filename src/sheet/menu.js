import {
  bevelBox,
  bevelButton,
  bevelSurface,
  bevelText,
  protectIcon,
} from "../ui/bevel-controls.js";
import { bevelDialog, dismissOf } from "../ui/bevel-dialog.js";
import { FONT_MONO, FONT_SANS, TOKENS } from "../ui/bevel.js";
import { mountEditorUI } from "../ui/editor-ui.js";
import { resolveTheme } from "../ui/theme.js";

const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';

// 10 columns by 3 rows of off-value swatches derived from Bevel tokens (darkest #0B0C13, lightest #F6F7F9).
export const SWATCHES = [
  { hex: "#0B0C13", label: "Night ground" },
  { hex: "#141821", label: "Ledger ink" },
  { hex: "#2B241B", label: "Warm ink" },
  { hex: "#4A4033", label: "Umber" },
  { hex: "#7A2A1F", label: "Deep ox" },
  { hex: "#9A4E1C", label: "Rust" },
  { hex: "#8F6310", label: "Brass" },
  { hex: "#256056", label: "Teal" },
  { hex: "#1D5B79", label: "Ledger blue" },
  { hex: "#6E4076", label: "Plum" },

  { hex: "#323A49", label: "Slate" },
  { hex: "#5B6577", label: "Muted slate" },
  { hex: "#6B5942", label: "Muted warm" },
  { hex: "#8A94A6", label: "Faint slate" },
  { hex: "#A83A2C", label: "Ox" },
  { hex: "#D8844F", label: "Ochre" },
  { hex: "#D9A445", label: "Gold" },
  { hex: "#63AE9E", label: "Sage" },
  { hex: "#5CA8CC", label: "Sky" },
  { hex: "#C388CE", label: "Orchid" },

  { hex: "#C5CCD8", label: "Cool line" },
  { hex: "#D8C8AF", label: "Warm line" },
  { hex: "#ECEFF4", label: "Sunk" },
  { hex: "#F6F7F9", label: "Light ground" },
  { hex: "#F6DED6", label: "Soft ox" },
  { hex: "#F6E6DA", label: "Soft ochre" },
  { hex: "#F0E4CC", label: "Soft brass" },
  { hex: "#DCEBE7", label: "Soft teal" },
  { hex: "#E5F0F6", label: "Soft sky" },
  { hex: "#F1E8F3", label: "Soft plum" },
];

function appendCheck(parent, shown, theme) {
  const box = bevelBox("span", [
    "display:inline-grid",
    "place-items:center",
    "width:14px",
    "height:14px",
    "flex:none",
    `color:${shown ? TOKENS.ink : "transparent"}`,
  ], { theme });
  if (shown) {
    box.innerHTML = CHECK_SVG;
    protectIcon(box.firstElementChild, 12);
  }
  parent.append(box);
}

export function createMenu({ container, theme = resolveTheme(), getReturnFocus = () => null } = {}) {
  const doc = container.ownerDocument ?? document;
  const win = doc.defaultView ?? window;
  let active = null;

  function close({ restoreFocus = false } = {}) {
    if (!active) return;
    const { surface, anchor, cleanup, onClose } = active;
    active = null;
    cleanup();
    if (anchor) anchor.removeAttribute("aria-expanded");
    surface.remove();
    onClose?.();
    if (restoreFocus) getReturnFocus()?.focus?.();
  }

  function open({ items = [], anchor = null, x = 0, y = 0, label = "", onClose = null } = {}) {
    if (active && anchor && active.anchor === anchor) {
      close({ restoreFocus: true });
      return null;
    }
    close({ restoreFocus: false });

    const rect = anchor ? anchor.getBoundingClientRect() : null;
    const rawLeft = rect ? rect.left : x;
    const rawTop = rect ? rect.bottom + 2 : y;
    const maxW = win.innerWidth || 0;
    const maxH = win.innerHeight || 0;
    const left = maxW > 220 ? Math.max(4, Math.min(rawLeft, maxW - 200)) : Math.max(0, rawLeft);
    const top = maxH > 160 ? Math.max(4, Math.min(rawTop, maxH - 120)) : Math.max(0, rawTop);

    const surface = bevelSurface("div", [
      "position:fixed",
      `left:${left}px`,
      `top:${top}px`,
      "z-index:2147483000",
      "display:flex",
      "flex-direction:column",
      "gap:2px",
      "min-width:176px",
      "padding:4px",
      `color-scheme:${theme.scheme}`,
      `box-shadow:6px 6px 0 color-mix(in srgb, ${TOKENS.ink} 10%, transparent)`,
    ], { theme });
    surface.setAttribute("role", "menu");
    if (label) surface.setAttribute("aria-label", label);
    surface.tabIndex = -1;

    const entries = [];
    const hasRadio = items.some((it) => typeof it?.checked === "boolean");

    const choose = (fn) => {
      close({ restoreFocus: true });
      fn?.();
    };

    for (const item of items) {
      if (!item) continue;
      if (item.type === "separator") {
        const sep = bevelBox("div", [
          "height:1px",
          "margin:3px 2px",
          `background:${TOKENS["line-2"]}`,
        ], { theme });
        sep.setAttribute("role", "separator");
        surface.append(sep);
        continue;
      }
      if (item.type === "swatches") {
        const palette = item.colors ?? SWATCHES;
        const current = (item.current ?? "").toLowerCase();
        const cols = 10;
        const grid = bevelBox("div", [
          "display:grid",
          `grid-template-columns:repeat(${cols}, 20px)`,
          "gap:3px",
          "padding:4px",
        ], { theme });
        grid.setAttribute("role", "group");
        if (item.label) grid.setAttribute("aria-label", item.label);
        palette.forEach((swatch, idx) => {
          const checked = current === swatch.hex.toLowerCase();
          const sw = bevelButton("", {
            small: true,
            onClick: () => choose(() => item.onSelect?.(swatch.hex)),
            theme,
            extra: [
              "width:20px",
              "min-width:20px",
              "height:20px",
              "min-height:20px",
              "padding:0",
              `background:${swatch.hex}`,
              `border:${checked ? `2px solid ${TOKENS.brass}` : `1px solid ${TOKENS["line-3"]}`}`,
            ],
          });
          sw.setAttribute("role", "menuitemradio");
          sw.setAttribute("aria-label", swatch.label);
          sw.setAttribute("aria-checked", checked ? "true" : "false");
          sw.setAttribute("data-swatch", swatch.hex);
          sw.tabIndex = -1;
          entries.push({ el: sw, disabled: false, checked, swatchCols: cols, swatchIdx: idx, onSelect: () => item.onSelect?.(swatch.hex) });
          grid.append(sw);
        });
        surface.append(grid);
        continue;
      }

      const isRadio = typeof item.checked === "boolean";
      const btn = bevelButton(item.label ?? "", {
        small: true,
        variant: "quiet",
        onClick: () => choose(item.onSelect),
        theme,
        extra: [
          "width:100%",
          "height:28px",
          "min-height:28px",
          "padding:0 10px",
          "justify-content:space-between",
          `font:${isRadio && item.checked ? "600" : "500"} 12.5px/1.25 ${FONT_SANS}`,
          `color:${item.danger ? TOKENS.ox : TOKENS.ink}`,
        ],
        labelExtra: [
          "display:inline-flex",
          "align-items:center",
          "justify-content:space-between",
          "gap:14px",
          "width:100%",
        ],
      });
      const span = btn.firstChild;
      span.textContent = "";
      const leftPart = bevelBox("span", ["display:inline-flex", "align-items:center", "gap:6px"], { theme });
      if (hasRadio) appendCheck(leftPart, Boolean(item.checked), theme);
      const mainText = bevelText("span", ["font:inherit", "color:inherit"], item.label ?? "", { theme, role: null });
      leftPart.append(mainText);
      span.append(leftPart);
      if (item.detail) {
        const detail = bevelText("span", [
          `font:400 11.5px/1 ${FONT_MONO}`,
          "font-variant-numeric:tabular-nums",
          `color:${TOKENS.muted}`,
        ], item.detail, { theme, role: "mutedText" });
        detail.setAttribute("data-menu-detail", "");
        span.append(detail);
      }
      btn.setAttribute("role", isRadio ? "menuitemradio" : "menuitem");
      if (isRadio) btn.setAttribute("aria-checked", item.checked ? "true" : "false");
      if (item.id) btn.setAttribute("data-menu-item", item.id);
      if (item.disabled) btn.setDisabled(true);
      btn.tabIndex = -1;
      entries.push({ el: btn, disabled: Boolean(item.disabled), checked: Boolean(item.checked), onSelect: item.onSelect });
      surface.append(btn);
    }

    const enabled = entries.filter((e) => !e.disabled);
    let focusIdx = Math.max(0, enabled.findIndex((e) => e.checked));

    function setFocus(nextIdx) {
      if (enabled.length === 0) {
        surface.focus();
        return;
      }
      focusIdx = ((nextIdx % enabled.length) + enabled.length) % enabled.length;
      enabled.forEach((e, i) => {
        e.el.tabIndex = i === focusIdx ? 0 : -1;
      });
      enabled[focusIdx].el.focus();
    }

    function onKeyDown(event) {
      const key = event.key;
      if (key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close({ restoreFocus: true });
        return;
      }
      if (key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        close({ restoreFocus: true });
        return;
      }
      if (enabled.length === 0) return;
      const cur = enabled[focusIdx];
      if (key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        if (cur?.swatchCols) {
          const afterGrid = enabled.findIndex((e, i) => i > focusIdx && !e.swatchCols);
          const next = focusIdx + cur.swatchCols < enabled.length
            ? focusIdx + cur.swatchCols
            : afterGrid !== -1
              ? afterGrid
              : (focusIdx + cur.swatchCols) % enabled.length;
          setFocus(next);
        } else {
          setFocus(focusIdx + 1);
        }
        return;
      }
      if (key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setFocus(cur?.swatchCols ? (focusIdx >= cur.swatchCols ? focusIdx - cur.swatchCols : enabled.length - 1) : focusIdx - 1);
        return;
      }
      if (key === "ArrowRight" && cur?.swatchCols) {
        event.preventDefault();
        event.stopPropagation();
        setFocus(focusIdx + 1);
        return;
      }
      if (key === "ArrowLeft" && cur?.swatchCols) {
        event.preventDefault();
        event.stopPropagation();
        setFocus(focusIdx - 1);
        return;
      }
      if (key === "Home") {
        event.preventDefault();
        event.stopPropagation();
        setFocus(0);
        return;
      }
      if (key === "End") {
        event.preventDefault();
        event.stopPropagation();
        setFocus(enabled.length - 1);
        return;
      }
      if (key === "Enter" || key === " ") {
        event.preventDefault();
        event.stopPropagation();
        const chosen = enabled[focusIdx];
        if (chosen) choose(chosen.onSelect);
      }
    }

    function onDocMouseDown(event) {
      const path = event.composedPath?.() ?? [event.target];
      if (path.includes(surface)) return;
      if (anchor && path.includes(anchor)) return;
      close({ restoreFocus: true });
    }

    surface.addEventListener("keydown", onKeyDown);
    doc.addEventListener("mousedown", onDocMouseDown, true);

    if (anchor) anchor.setAttribute("aria-expanded", "true");
    container.append(surface);

    active = {
      surface,
      anchor,
      onClose,
      cleanup() {
        surface.removeEventListener("keydown", onKeyDown);
        doc.removeEventListener("mousedown", onDocMouseDown, true);
      },
    };

    setFocus(focusIdx);
    return surface;
  }

  return {
    open,
    close,
    get isOpen() {
      return active !== null;
    },
    get surface() {
      return active?.surface ?? null;
    },
    dispose() {
      close({ restoreFocus: false });
    },
  };
}

function mountSheetDialog(doc, shell, { title, confirmLabel, confirmVariant = "primary", onConfirm, onCancel, getReturnFocus, container = null }) {
  shell.root.setAttribute("sap-ignore", "");
  shell.heading.textContent = title;
  shell.panel.setAttribute("aria-label", title);

  const buttonOpts = { theme: shell.theme, parts: ["dialog.button"], labelParts: ["dialog.buttonLabel"] };
  const cancelBtn = bevelButton("Cancel", { ...buttonOpts, onClick: () => settle(false) });
  const confirmBtn = bevelButton(confirmLabel, { variant: confirmVariant, ...buttonOpts });
  confirmBtn.type = "submit";
  shell.footer.append(cancelBtn, confirmBtn);

  let done = false;
  let pressedBackdrop = false;

  const focusables = () =>
    [...shell.panel.querySelectorAll('input:not([disabled]), button:not([disabled])')].filter(
      (el) => !el.hidden && el.getAttribute("aria-disabled") !== "true",
    );

  function onKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      settle(false);
      return;
    }
    if (event.key === "Tab") {
      const nodes = focusables();
      if (!nodes.length) return;
      event.stopPropagation();
      const active = shell.panel.getRootNode()?.activeElement ?? doc.activeElement;
      const idx = nodes.indexOf(active);
      if (idx === -1) {
        event.preventDefault();
        nodes[0].focus();
      } else if (event.shiftKey && idx === 0) {
        event.preventDefault();
        nodes[nodes.length - 1].focus();
      } else if (!event.shiftKey && idx === nodes.length - 1) {
        event.preventDefault();
        nodes[0].focus();
      }
    }
  }

  let detach = null;
  function finish() {
    if (done) return false;
    done = true;
    doc.removeEventListener("keydown", onKeyDown, true);
    detach?.();
    detach = null;
    return true;
  }

  function settle(confirmed) {
    if (!finish()) return;
    getReturnFocus?.()?.focus?.();
    if (confirmed) onConfirm?.();
    else onCancel?.();
  }

  shell.close?.addEventListener("click", () => settle(false));
  shell.panel.addEventListener("submit", (event) => {
    event.preventDefault();
    settle(true);
  });
  shell.overlay.addEventListener("mousedown", (event) => {
    pressedBackdrop = event.target === shell.overlay;
  });
  shell.overlay.addEventListener("click", (event) => {
    if (pressedBackdrop && event.target === shell.overlay) settle(false);
    pressedBackdrop = false;
  });
  doc.addEventListener("keydown", onKeyDown, true);
  dismissOf.set(shell.root, () => settle(false));

  shell.root.setAttribute("aria-hidden", "false");
  if (container) {
    container.append(shell.root);
    detach = () => shell.root.remove();
  } else {
    const mounted = mountEditorUI({
      name: "sheet-dialog",
      content: shell.root,
      parent: doc.body,
      attributes: { "sap-ignore": "" },
    });
    detach = () => mounted.remove();
  }

  return { shell, confirmBtn, cancelBtn, close: () => settle(false) };
}

export function openMergeKeepDialog({ doc = document, theme = resolveTheme(), items, totalCount, onConfirm, onCancel, getReturnFocus, container = null }) {
  const shell = bevelDialog({ zIndex: "2147483001", width: "420px", closable: true, titled: true, theme });
  const stack = bevelBox("div", ["display:flex", "flex-direction:column", "gap:10px"], { theme });
  const intro = bevelText("div", [
    `font:400 13.5px/1.45 ${FONT_SANS}`,
    `color:${TOKENS["ink-2"]}`,
  ], "Multiple cells contain values. Choose which value to keep in the merged cell:", { theme });
  stack.append(intro);

  const list = bevelBox("div", ["display:flex", "flex-direction:column", "gap:6px"], { theme });
  list.setAttribute("role", "radiogroup");
  const choices = [];
  let picked = 0;
  let handle = null;
  const paintChoice = (idx) => {
    picked = idx;
    choices.forEach((btn, i) => btn.setAttribute("aria-checked", i === idx ? "true" : "false"));
  };
  items.slice(0, 5).forEach((entry, idx) => {
    const row = bevelButton("", {
      small: true,
      variant: "quiet",
      theme,
      onClick: () => paintChoice(idx),
      extra: [
        "display:flex",
        "align-items:center",
        "gap:8px",
        "width:100%",
        "height:auto",
        "min-height:32px",
        "padding:6px 10px",
        "justify-content:flex-start",
        `background:${TOKENS.sunk}`,
        `border:1px solid ${TOKENS["line-2"]}`,
        `font:500 13px/1.35 ${FONT_SANS}`,
        `color:${TOKENS.ink}`,
      ],
      labelExtra: [
        "display:flex",
        "align-items:center",
        "gap:8px",
        "width:100%",
        "justify-content:flex-start",
      ],
    });
    row.setAttribute("role", "radio");
    row.setAttribute("aria-checked", idx === 0 ? "true" : "false");
    row.setAttribute("aria-label", `${entry.ref}, ${entry.text}`);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        paintChoice(idx);
        handle?.confirmBtn.click();
      } else if (event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        paintChoice(idx);
      } else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        choices[(idx + 1) % choices.length]?.focus();
      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        choices[(idx - 1 + choices.length) % choices.length]?.focus();
      }
    });
    const refBadge = bevelText("span", [
      `font:600 11.5px/1 ${FONT_MONO}`,
      "font-variant-numeric:tabular-nums",
      `color:${TOKENS.muted}`,
    ], entry.ref, { theme, role: "mutedText" });
    const valText = bevelText("span", [
      `font:500 13px/1.35 ${FONT_SANS}`,
      `color:${TOKENS.ink}`,
      "overflow:hidden",
      "text-overflow:ellipsis",
      "white-space:nowrap",
    ], entry.text, { theme });
    row.firstChild.append(refBadge, valText);
    choices.push(row);
    list.append(row);
  });
  stack.append(list);

  const extra = totalCount - Math.min(5, items.length);
  if (extra > 0) {
    const more = bevelText("div", [
      `font:400 12.5px/1.4 ${FONT_SANS}`,
      `color:${TOKENS.muted}`,
    ], `and ${extra} more`, { theme, role: "mutedText" });
    more.setAttribute("data-merge-more", "");
    stack.append(more);
  }
  shell.body.append(stack);

  handle = mountSheetDialog(doc, shell, {
    title: "Merge cells",
    confirmLabel: "Merge",
    confirmVariant: "primary",
    onConfirm: () => onConfirm?.(items[picked]),
    onCancel,
    getReturnFocus,
    container,
  });
  (choices[0] ?? handle.confirmBtn).focus();
  return handle;
}

export function openDeleteTabDialog({ doc = document, theme = resolveTheme(), tabName, onConfirm, onCancel, getReturnFocus, container = null }) {
  const shell = bevelDialog({ zIndex: "2147483001", width: "400px", closable: true, titled: true, theme });
  const msg = bevelText("div", [
    `font:400 13.5px/1.5 ${FONT_SANS}`,
    `color:${TOKENS["ink-2"]}`,
  ], `Delete "${tabName}" from this workbook?`, { theme });
  shell.body.append(msg);

  const handle = mountSheetDialog(doc, shell, {
    title: `Delete "${tabName}"?`,
    confirmLabel: "Delete",
    confirmVariant: "danger",
    onConfirm,
    onCancel,
    getReturnFocus,
    container,
  });
  handle.confirmBtn.focus();
  return handle;
}
