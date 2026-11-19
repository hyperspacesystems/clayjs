/**
 * @jest-environment jsdom
 */
import { afterEach, describe, expect, test } from "@jest/globals";
import { createMenu, SWATCHES } from "../../../src/sheet/menu.js";

function setupHost() {
  document.body.innerHTML = "";
  const textarea = document.createElement("textarea");
  document.body.append(textarea);
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });
  const container = document.createElement("div");
  shadow.append(container);
  document.body.append(host);
  const anchor = document.createElement("button");
  container.append(anchor);
  const menu = createMenu({ container, getReturnFocus: () => textarea });
  return { textarea, host, shadow, container, anchor, menu };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("sheet Bevel menu", () => {
  // Bug: menu items lacked ARIA menu/menuitem/menuitemradio/separator roles or swatches included pure black/white.
  test("renders role=menu with menuitem, menuitemradio aria-checked, separator and 30 off-value swatches", () => {
    const { shadow, anchor, menu } = setupHost();
    menu.open({
      anchor,
      label: "Format",
      items: [
        { id: "auto", label: "Automatic", checked: false, detail: "42", onSelect: () => {} },
        { id: "curr", label: "Currency", checked: true, detail: "$42.00", onSelect: () => {} },
        { type: "separator" },
        { type: "swatches", current: "#8F6310", onSelect: () => {} },
        { id: "reset", label: "Reset", onSelect: () => {} },
      ],
    });

    const surface = shadow.querySelector('[role="menu"]');
    expect(surface).not.toBeNull();
    expect(anchor.getAttribute("aria-expanded")).toBe("true");
    expect(surface.querySelector('[role="separator"]')).not.toBeNull();

    const radios = [...surface.querySelectorAll('[role="menuitemradio"]')];
    expect(radios.length).toBe(2 + 30);
    expect(radios[0].getAttribute("aria-checked")).toBe("false");
    expect(radios[1].getAttribute("aria-checked")).toBe("true");
    expect(shadow.activeElement).toBe(radios[1]);

    const resetItem = surface.querySelector('[data-menu-item="reset"]');
    expect(resetItem.getAttribute("role")).toBe("menuitem");

    expect(SWATCHES).toHaveLength(30);
    for (const { hex } of SWATCHES) {
      expect(hex.toLowerCase()).not.toBe("#000000");
      expect(hex.toLowerCase()).not.toBe("#ffffff");
      expect(hex.toLowerCase()).not.toBe("#000");
      expect(hex.toLowerCase()).not.toBe("#fff");
    }

    menu.dispose();
  });

  // Bug: arrow keys, Home/End, Enter and Space failed to move through enabled items or choose and return focus to the textarea.
  test("ArrowDown, ArrowUp, Home and End skip disabled items, and Enter and Space choose and return focus", () => {
    const { shadow, textarea, menu } = setupHost();
    const chosen = [];
    const openSample = () =>
      menu.open({
        x: 20,
        y: 30,
        items: [
          { id: "one", label: "One", onSelect: () => chosen.push("one") },
          { id: "off", label: "Disabled", disabled: true, onSelect: () => chosen.push("off") },
          { id: "two", label: "Two", onSelect: () => chosen.push("two") },
          { id: "three", label: "Three", onSelect: () => chosen.push("three") },
        ],
      });

    const surface = openSample();
    expect(shadow.activeElement.getAttribute("data-menu-item")).toBe("one");

    surface.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(shadow.activeElement.getAttribute("data-menu-item")).toBe("two");

    surface.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    expect(shadow.activeElement.getAttribute("data-menu-item")).toBe("three");

    surface.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
    expect(shadow.activeElement.getAttribute("data-menu-item")).toBe("one");

    surface.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    expect(shadow.activeElement.getAttribute("data-menu-item")).toBe("three");

    surface.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(chosen).toEqual(["three"]);
    expect(menu.isOpen).toBe(false);
    expect(document.activeElement).toBe(textarea);

    const surface2 = openSample();
    surface2.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    surface2.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    expect(chosen).toEqual(["three", "two"]);
    expect(document.activeElement).toBe(textarea);
  });

  // Bug: ArrowUp from the top swatch row wrapped by the whole row length instead of reaching the last item.
  test("ArrowUp from the top swatch row reaches Reset while ArrowUp inside the swatch grid steps one row", () => {
    const { shadow, menu } = setupHost();
    const surface = menu.open({
      x: 10,
      y: 30,
      items: [
        { id: "custom", label: "Custom", checked: true, onSelect: () => {} },
        { type: "swatches", label: "Text color", onSelect: () => {} },
        { id: "reset", label: "Reset", onSelect: () => {} },
      ],
    });
    const key = (name) => surface.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
    const swatches = [...surface.querySelectorAll("[data-swatch]")];

    key("ArrowDown");
    expect(shadow.activeElement).toBe(swatches[0]);
    key("ArrowUp");
    expect(shadow.activeElement.getAttribute("data-menu-item")).toBe("reset");

    key("Home");
    key("ArrowDown");
    key("ArrowDown");
    expect(shadow.activeElement).toBe(swatches[10]);
    key("ArrowUp");
    expect(shadow.activeElement).toBe(swatches[0]);

    menu.dispose();
  });

  // Bug: Escape or clicking outside left the menu open or stranded focus away from the sheet's textarea.
  test("Escape, clicking outside, and clicking the open anchor button close the menu and return focus to the textarea", () => {
    const { textarea, anchor, menu } = setupHost();

    const s1 = menu.open({
      anchor,
      items: [{ id: "one", label: "One", onSelect: () => {} }],
    });
    expect(menu.isOpen).toBe(true);

    s1.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(menu.isOpen).toBe(false);
    expect(anchor.getAttribute("aria-expanded")).toBeNull();
    expect(document.activeElement).toBe(textarea);

    menu.open({
      anchor,
      items: [{ id: "one", label: "One", onSelect: () => {} }],
    });
    expect(menu.isOpen).toBe(true);
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));
    expect(menu.isOpen).toBe(false);
    expect(document.activeElement).toBe(textarea);

    menu.open({
      anchor,
      items: [{ id: "one", label: "One", onSelect: () => {} }],
    });
    expect(menu.isOpen).toBe(true);
    menu.open({
      anchor,
      items: [{ id: "one", label: "One", onSelect: () => {} }],
    });
    expect(menu.isOpen).toBe(false);
    expect(document.activeElement).toBe(textarea);
  });

  // Bug: submenu items lacked aria-haspopup, failed to open/close on ArrowRight/ArrowLeft, or outside-mousedown closed the menu when clicking a submenu item.
  test("submenu items open on ArrowRight or click, return to the parent item on ArrowLeft, and execute submenu selections cleanly", () => {
    const { shadow, textarea, menu } = setupHost();
    const chosen = [];
    const surface = menu.open({
      x: 20,
      y: 30,
      items: [
        {
          id: "paste-special",
          label: "Paste special",
          items: [
            { id: "paste-values", label: "Values only", detail: "Ctrl+Shift+V", onSelect: () => chosen.push("values") },
            { id: "paste-transpose", label: "Transposed", onSelect: () => chosen.push("transpose") },
          ],
        },
        { id: "other", label: "Other", onSelect: () => chosen.push("other") },
      ],
    });

    const parentBtn = surface.querySelector('[data-menu-item="paste-special"]');
    expect(parentBtn.getAttribute("aria-haspopup")).toBe("menu");
    expect(parentBtn.getAttribute("aria-expanded")).toBe("false");

    surface.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    const sub = shadow.querySelector('[data-submenu="paste-special"]');
    expect(sub).not.toBeNull();
    expect(parentBtn.getAttribute("aria-expanded")).toBe("true");
    expect(shadow.activeElement.getAttribute("data-menu-item")).toBe("paste-values");

    sub.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    expect(shadow.querySelector('[data-submenu="paste-special"]')).toBeNull();
    expect(parentBtn.getAttribute("aria-expanded")).toBe("false");
    expect(shadow.activeElement).toBe(parentBtn);

    // The pointer crossing a sibling closes the submenu; the keyboard focus comes back to the parent.
    surface.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    expect(shadow.activeElement.getAttribute("data-menu-item")).toBe("paste-values");
    surface.querySelector('[data-menu-item="other"]').dispatchEvent(new Event("pointerenter"));
    expect(shadow.querySelector('[data-submenu="paste-special"]')).toBeNull();
    expect(shadow.activeElement).toBe(parentBtn);
    // ArrowDown from the parent with its submenu open moves on and closes it.
    surface.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    parentBtn.focus();
    surface.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(shadow.activeElement.getAttribute("data-menu-item")).toBe("other");
    expect(shadow.querySelector('[data-submenu="paste-special"]')).toBeNull();

    parentBtn.click();
    const sub2 = shadow.querySelector('[data-submenu="paste-special"]');
    const transposeBtn = sub2.querySelector('[data-menu-item="paste-transpose"]');
    transposeBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));
    expect(menu.isOpen).toBe(true);
    transposeBtn.click();
    expect(chosen).toEqual(["transpose"]);
    expect(menu.isOpen).toBe(false);
    expect(document.activeElement).toBe(textarea);
  });
});
