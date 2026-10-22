import { describe, expect, it } from "vitest";
import {
  amountOf,
  cellsToRead,
  changeLine,
  dateFor,
  evalFormula,
  formulaRefs,
  planDraft,
} from "./invoice";
import type { InvoiceSettings } from "./settings";

const invoice = (fields: InvoiceSettings["fields"]): InvoiceSettings => ({
  sheetId: "1AbC_defGhIjKlMnOpQrStUvWxYz0123456789",
  tab: "Invoice",
  draftFolder: "Duck drafts",
  entryTag: "duck:invoice",
  fields,
});

describe("the invoice's rules", () => {
  it("dates each rule from today, across month and year ends", () => {
    expect(dateFor("today", "2026-10-22")).toBe("2026-10-22");
    expect(dateFor("first_of_month", "2026-10-22")).toBe("2026-10-01");
    expect(dateFor("last_of_month", "2026-02-10")).toBe("2026-02-28");
    expect(dateFor("first_of_prev_month", "2026-01-05")).toBe("2025-12-01");
    expect(dateFor("last_of_prev_month", "2026-03-01")).toBe("2026-02-28");
    expect(dateFor("last_of_prev_month", "2024-03-31")).toBe("2024-02-29");
  });

  it("reads shown amounts and works out cell arithmetic", () => {
    expect(amountOf("$1,200.50")).toBe(1200.5);
    expect(amountOf("(45.00)")).toBe(-45);
    expect(amountOf("n/a")).toBeNull();
    expect(formulaRefs("$C$5*C6+C5")).toEqual(["C5", "C6"]);
    const v = (c: string) => ({ C5: 160, C6: 7.5 })[c] ?? null;
    expect(evalFormula("C5*C6", v)).toBe(1200);
    expect(evalFormula("(C5 - 10) * -2 / 4", v)).toBe(-75);
    expect(() => evalFormula("C5*D1", v)).toThrow(/D1 has no number/);
    expect(() => evalFormula("C5/0", v)).toThrow(/divides by zero/);
    expect(() => evalFormula("C5*(C6", v)).toThrow(/missing/);
    expect(() => evalFormula("C5 C6", v)).toThrow(/has "C6"/);
  });
});

describe("planDraft", () => {
  const inv = invoice([
    { label: "Date", address: "B2", kind: "date", rule: "today" },
    { label: "Period", address: "B3", kind: "date", rule: "first_of_prev_month" },
    { label: "Hours", address: "C5", kind: "amount", rule: "ask" },
    { label: "Total", address: "F10", kind: "amount", rule: "cells", formula: "C5*C6" },
    { label: "Rate", address: "C6", kind: "amount", rule: "same_as_last" },
  ]);
  const cells = [
    { address: "B2", value: "2026-09-21" },
    { address: "B3", value: "2026-09-01" },
    { address: "C5", value: "150" },
    { address: "C6", value: "$8.00" },
    { address: "F10", value: "$1,200.00" },
  ];

  it("plans each cell from its rule, with formulas over this draft's amounts", () => {
    const p = planDraft(inv, "Acme invoice", cells, "2026-10-22", { hours: 160 });
    expect(p.title).toBe("Acme invoice draft 2026-10 (Duck)");
    expect(p.changes.map(changeLine)).toEqual([
      "Date (B2) 2026-09-21 → 2026-10-22",
      "Hours (C5) 150 → 160",
      "Total (F10) $1,200.00 → 1280",
    ]);
    expect(p.kept).toEqual([
      { label: "Period", address: "B3", why: "already that" },
      { label: "Rate", address: "C6", why: "same as last time" },
    ]);
    expect(p.expect).toContainEqual({ address: "F10", value: "$1,200.00" });
    expect(cellsToRead(inv)).toEqual(["B2", "B3", "C5", "F10", "C6"]);
  });

  it("asks for missing answers and never changes a formula cell", () => {
    expect(() => planDraft(inv, "S", cells, "2026-10-22")).toThrow(/ask the user for Hours/);
    const withFormula = cells.map((c) => (c.address === "F10" ? { ...c, formula: "=C5*C6" } : c));
    const p = planDraft(inv, "S", withFormula, "2026-10-22", { Hours: 160 });
    expect(p.changes.map((c) => c.address)).toEqual(["B2", "C5"]);
    expect(p.kept).toContainEqual({ label: "Total", address: "F10", why: "it holds a formula (=C5*C6)" });
  });
});
