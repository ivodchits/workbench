// @vitest-environment jsdom
// Drawing kinds (G3): telling Vega-Lite from Vega, an SVG's size, and the source
// an API worker hands in its result.

import { describe, expect, it } from "vitest";

import { fencedSource, isVegaLite, kindOf, sized, svgSize, svgUrl } from "./kinds";

describe("drawing kinds", () => {
  it("maps extensions to kinds", () => {
    expect([kindOf("mmd"), kindOf("svg"), kindOf("json"), kindOf("html")]).toEqual(["mermaid", "svg", "vega", null]);
  });

  it("tells a Vega-Lite spec from a Vega one", () => {
    expect(isVegaLite({ $schema: "https://vega.github.io/schema/vega-lite/v6.json", mark: "bar" })).toBe(true);
    expect(isVegaLite({ $schema: "https://vega.github.io/schema/vega/v6.json", marks: [] })).toBe(false);
    expect(isVegaLite({ mark: "line", data: { values: [] } })).toBe(true);
    expect(isVegaLite({ layer: [] })).toBe(true);
    expect(isVegaLite({ marks: [], mark: "x" })).toBe(false);
    expect(isVegaLite(null)).toBe(false);
  });

  it("reads an SVG's size from its attributes or its viewBox", () => {
    expect(svgSize('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"/>')).toEqual({ width: 200, height: 100 });
    expect(svgSize('<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 523 300"/>')).toEqual({ width: 523, height: 300 });
    expect(svgSize('<svg xmlns="http://www.w3.org/2000/svg" width="400" viewBox="0 0 200 100"/>')).toEqual({ width: 400, height: 200 });
    expect(svgSize('<svg xmlns="http://www.w3.org/2000/svg"/>')).toBeNull();
    expect(svgSize("<html><body/></html>")).toBeNull();
    expect(svgSize("<svg")).toBeNull();
  });

  it("writes Mermaid's 100% width as pixels and drops its max-width", () => {
    const out = sized('<svg xmlns="http://www.w3.org/2000/svg" width="100%" style="max-width: 523px;" viewBox="0 0 523 300"><g/></svg>');
    expect(out).toMatch(/width="523"/);
    expect(out).toMatch(/height="300"/);
    expect(out).not.toMatch(/max-width/);
    expect(out).toContain("<g/>");
  });

  it("shows an SVG through a data URL, so its script stays inert", () => {
    const evil = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script></svg>';
    const url = svgUrl(evil);
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.slice(url.indexOf(",") + 1))).toBe(evil);
  });

  it("finds the source in a result's fenced block, by kind", () => {
    const md = "# Sequence\n\nHere it is:\n\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n\n```json\n{\"mark\":\"bar\"}\n```\n";
    expect(fencedSource(md, "mermaid")).toBe("sequenceDiagram\n  A->>B: hi");
    expect(fencedSource(md, "vega")).toBe('{"mark":"bar"}');
    expect(fencedSource(md, "svg")).toBeNull();
    expect(fencedSource("```xml\n<svg/>\n```", "svg")).toBe("<svg/>");
  });
});
