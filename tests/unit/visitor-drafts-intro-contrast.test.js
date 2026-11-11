import { CLOSE_CSS } from "../../src/plugins/visitor-drafts/intro-style.js";

// The manual close carries words ("Hide intro") at 12 px, so it needs text contrast
// (4.5:1). Dimming it like the icon-only close measured 3.6:1 to 3.9:1 on light pages.
test("the manual close's text is drawn at full opacity", () => {
  const style = document.createElement("style");
  style.textContent = CLOSE_CSS;
  document.head.append(style);
  const manual = document.createElement("button");
  manual.className = "clay-intro__close";
  manual.setAttribute("data-manual", "");
  const icon = document.createElement("button");
  icon.className = "clay-intro__close";
  document.body.append(manual, icon);
  expect(getComputedStyle(icon).opacity).toBe("0.55");
  expect(getComputedStyle(manual).opacity).toBe("1");
});
