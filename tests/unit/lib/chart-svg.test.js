/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/sheet.html"}
 */
import { beforeAll, expect, test } from "@jest/globals";
import { CHART_COLOURS, chartSvg } from "../../../src/lib/chart-svg.js";

const TYPES = ["column", "bar", "line", "area", "pie", "scatter"];
let drawingProblem;

beforeAll(async () => {
  const derive = await import("../../../src/plugins/derive.js");
  await derive.ready;
  await window.Sap.plugins.load("grid");
  drawingProblem = window.Sap.grid.drawingProblem;
  expect(typeof drawingProblem).toBe("function");
});

function sampleModel(type, { stacked = false } = {}) {
  return {
    type,
    title: `Sales & <Q1> "Plan" '26\u00A0Report`,
    stacked,
    categories: [
      `North & <West>\u00A0"A" '1'`,
      `South & <East>\u00A0"B" '2'`,
      `Central & <Hub>\u00A0"C" '3'`,
      `Coastal & <Port>\u00A0"D" '4'`,
    ],
    xs: type === "scatter" ? [10, 20, null, 40] : null,
    series: [
      { name: `Gross & <Net> "S1" 'a'\u00A01`, values: [24, null, 48, 36] },
      { name: `Target & <Cap> "S2" 'b'\u00A02`, values: [18, 30, null, 42] },
    ],
  };
}

test("every chart type with special characters and nulls, plus empty models, passes drawingProblem", () => {
  expect(CHART_COLOURS).toHaveLength(8);
  for (const c of CHART_COLOURS) {
    expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(c).not.toBe("#ffffff");
    expect(c).not.toBe("#000000");
  }

  for (const type of TYPES) {
    const m = sampleModel(type);
    const svg = chartSvg(m, { width: 480, height: 300 });
    expect(drawingProblem(svg)).toBeNull();
    expect(chartSvg(m, { width: 480, height: 300 })).toBe(svg);
    expect(svg).not.toContain("/>");
    expect(svg).not.toContain("font-family");

    const compact = chartSvg(m, { width: 120, height: 80 });
    expect(drawingProblem(compact)).toBeNull();
    expect(compact.match(/<g>/g)?.length ?? 0).toBeLessThanOrEqual(2);

    const narrow = chartSvg(m, { width: 240, height: 240 });
    expect(drawingProblem(narrow)).toBeNull();
  }

  for (const type of ["column", "bar", "area"]) {
    const svg = chartSvg(sampleModel(type, { stacked: true }), { width: 480, height: 300 });
    expect(drawingProblem(svg)).toBeNull();
  }

  const singleSlicePie = chartSvg(
    { type: "pie", title: "", stacked: false, categories: ["Only"], xs: null, series: [{ name: "S1", values: [50] }] },
    { width: 360, height: 220 },
  );
  expect(drawingProblem(singleSlicePie)).toBeNull();
  expect(singleSlicePie).toContain("<circle ");
  expect(singleSlicePie).toContain("(100%)");

  const hostile = chartSvg(
    {
      type: "column",
      title: "Bad\r\0\uD800Title url(x) \\ /* <tag>",
      stacked: false,
      categories: ["A\r\0\uDC00", "B"],
      xs: null,
      series: [{ name: "S\r\0", values: [-0.0001, NaN, Infinity, -Infinity, -15, 12.3] }],
    },
    { width: 360, height: 220 },
  );
  expect(drawingProblem(hostile)).toBeNull();
  expect(hostile).not.toContain("-0");
  expect(hostile).not.toContain("NaN");
  expect(hostile).not.toContain("Infinity");

  const emptyModels = [
    { type: "column", title: "", stacked: false, categories: [], xs: null, series: [] },
    { type: "line", title: "Empty & <Quiet>", stacked: false, categories: ["A"], xs: null, series: [{ name: "S1", values: [null] }] },
    { type: "pie", title: "", stacked: false, categories: ["A"], xs: null, series: [{ name: "S1", values: [0, -5, null] }] },
    { type: "scatter", title: "", stacked: false, categories: ["1"], xs: [null], series: [{ name: "S1", values: [10] }] },
  ];
  for (const empty of emptyModels) {
    const svg = chartSvg(empty, { width: 320, height: 180 });
    expect(drawingProblem(svg)).toBeNull();
    expect(svg).toContain("No numbers to chart");
  }
});

test("fixpoint: figure.innerHTML round-trips chartSvg output byte-for-byte across all types", () => {
  const figure = document.createElement("figure");
  for (const type of TYPES) {
    for (const stacked of [false, true]) {
      const svg = chartSvg(sampleModel(type, { stacked }), { width: 480, height: 300 });
      figure.innerHTML = svg;
      expect(figure.innerHTML).toBe(svg);
    }
  }
  const emptySvg = chartSvg(
    { type: "bar", title: `Empty "Quote" & 'Apostrophe'\u00A0<x>`, stacked: false, categories: [], xs: null, series: [] },
    { width: 300, height: 160 },
  );
  figure.innerHTML = emptySvg;
  expect(figure.innerHTML).toBe(emptySvg);
});

test("stacked column places the top of each category stack at the sum on the value axis", () => {
  const svg = chartSvg(
    {
      type: "column",
      title: "Quarterly Revenue",
      stacked: true,
      categories: ["Q1", "Q2", "Q3"],
      xs: null,
      series: [
        { name: "Hardware", values: [20, 35, 15] },
        { name: "Software", values: [10, 45, 25] },
      ],
    },
    { width: 480, height: 300 },
  );
  expect(drawingProblem(svg)).toBeNull();

  const figure = document.createElement("figure");
  figure.innerHTML = svg;
  const groups = figure.querySelectorAll("svg > g");
  const axisGroup = groups[0];
  const plotGroup = groups[1];

  const tickMap = new Map();
  for (const t of axisGroup.querySelectorAll("text[text-anchor='end']")) {
    tickMap.set(Number(t.textContent), Number(t.getAttribute("y")));
  }
  expect(tickMap.has(0)).toBe(true);
  expect(tickMap.has(80)).toBe(true);

  const yAtValue = (val) => {
    const y0 = tickMap.get(0);
    const y80 = tickMap.get(80);
    return y0 + ((val - 0) / 80) * (y80 - y0);
  };

  const rects = [...plotGroup.querySelectorAll("rect")];
  expect(rects).toHaveLength(6);
  const tallestY = Math.min(...rects.map((r) => Number(r.getAttribute("y"))));
  expect(tallestY).toBeCloseTo(tickMap.get(80), 1);

  const byX = new Map();
  for (const r of rects) {
    const x = r.getAttribute("x");
    const y = Number(r.getAttribute("y"));
    byX.set(x, Math.min(byX.get(x) ?? Infinity, y));
  }
  const stackTops = [...byX.values()];
  expect(stackTops).toHaveLength(3);
  expect(stackTops[0]).toBeCloseTo(yAtValue(30), 1);
  expect(stackTops[1]).toBeCloseTo(yAtValue(80), 1);
  expect(stackTops[2]).toBeCloseTo(yAtValue(40), 1);
});

test("labels longer than their slot are cut with an ellipsis while desc keeps the full label", () => {
  const longLabel = "North American Enterprise Annual Recurring Subscription Revenue Segment Alpha-Omega";
  const svg = chartSvg(
    {
      type: "column",
      title: "Segment Breakdown",
      stacked: false,
      categories: [longLabel, "SMB", "Consumer"],
      xs: null,
      series: [{ name: "ARR", values: [120, 85, 60] }],
    },
    { width: 320, height: 220 },
  );
  expect(drawingProblem(svg)).toBeNull();

  const figure = document.createElement("figure");
  figure.innerHTML = svg;
  const texts = [...figure.querySelectorAll("svg text")].map((el) => el.textContent);
  const ellipsized = texts.find((t) => t.startsWith("North") && t.endsWith("…"));
  expect(ellipsized).toBeDefined();
  expect(ellipsized.length).toBeLessThan(longLabel.length);
  expect(texts).not.toContain(longLabel);

  const descText = figure.querySelector("svg > desc").textContent;
  expect(descText).toContain(longLabel);
});

test("10,000 points draw within the relative 100-point x200 budget and under 100 ms, pass drawingProblem, and stay under 1,048,576 chars", () => {
  const makeLineModel = (n) => {
    const categories = new Array(n);
    const values = new Array(n);
    for (let i = 0; i < n; i++) {
      categories[i] = `Day ${i + 1}`;
      values[i] = Math.sin(i * 0.05) * 50 + 100;
    }
    return {
      type: "line",
      title: "High Frequency Series",
      stacked: false,
      categories,
      xs: null,
      series: [{ name: "Signal", values }],
    };
  };

  const m100 = makeLineModel(100);
  const m10k = makeLineModel(10000);

  chartSvg(m100, { width: 600, height: 320 });
  chartSvg(m10k, { width: 600, height: 320 });

  const runs = 5;
  const t0Small = performance.now();
  for (let i = 0; i < runs; i++) chartSvg(m100, { width: 600, height: 320 });
  const avg100 = (performance.now() - t0Small) / runs;

  let svg10k = "";
  const t0Big = performance.now();
  for (let i = 0; i < runs; i++) svg10k = chartSvg(m10k, { width: 600, height: 320 });
  const avg10k = (performance.now() - t0Big) / runs;

  expect(avg10k).toBeLessThan(Math.max(avg100 * 200, 1));
  expect(avg10k).toBeLessThan(100);
  expect(svg10k.length).toBeLessThan(1048576);
  expect(drawingProblem(svg10k)).toBeNull();
  expect(svg10k).toContain("and 9800 more");
});

// Bug: a pie whose second slice held nearly everything drew a zero-length arc, so a pie of
// [1, 200000] came out blank.
test("a pie with one dominant slice draws a full circle in that slice's colour", () => {
  const svg = chartSvg(
    {
      type: "pie",
      title: "",
      stacked: false,
      categories: ["Tiny", "Huge"],
      xs: null,
      series: [{ name: "Share", values: [1, 200000] }],
    },
    { width: 320, height: 220 },
  );
  expect(drawingProblem(svg)).toBeNull();

  const figure = document.createElement("figure");
  figure.innerHTML = svg;
  const circle = figure.querySelector("svg circle");
  expect(circle).not.toBeNull();
  expect(circle.getAttribute("fill")).toBe(CHART_COLOURS[1]);
  expect(figure.querySelector("svg path")).toBeNull();
});
