import { describe, expect, it } from "vitest";
import { cellOf, cleanSettings, sheetIdOf } from "./settings";

const ID = "1AbC_defGhIjKlMnOpQrStUvWxYz0123456789";

describe("the morning settings", () => {
  it("takes a sheet id or the id out of its URL", () => {
    expect(sheetIdOf(ID)).toBe(ID);
    expect(sheetIdOf(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`)).toBe(ID);
    expect(sheetIdOf("short")).toBeNull();
    expect(sheetIdOf("https://example.com/x")).toBeNull();
  });

  it("reads one A1 cell, without $", () => {
    expect(cellOf("b2")).toBe("B2");
    expect(cellOf(" $F$10 ")).toBe("F10");
    expect(cellOf("B2:C3")).toBeNull();
    expect(cellOf("B0")).toBeNull();
    expect(cellOf("Sheet1!B2")).toBeNull();
  });

  it("keeps a valid invoice and fills its defaults", () => {
    const s = cleanSettings({
      morning: {
        googleClientId: " 123-abc.apps.googleusercontent.com ",
        invoice: {
          sheetId: `https://docs.google.com/spreadsheets/d/${ID}/edit`,
          tab: " Invoices ",
          fields: [
            { label: "Invoice date", address: "b2", kind: "date", rule: "today" },
            { label: "Period", address: "B3", kind: "date", rule: "last_of_prev_month" },
            { label: "Amount", address: "F10", kind: "amount", rule: "cells", formula: "c5*c6" },
          ],
        },
      },
    });
    expect(s.morning).toEqual({
      googleClientId: "123-abc.apps.googleusercontent.com",
      invoice: {
        sheetId: ID,
        tab: "Invoices",
        draftFolder: "Duck drafts",
        entryTag: "duck:invoice",
        fields: [
          { label: "Invoice date", address: "B2", kind: "date", rule: "today" },
          { label: "Period", address: "B3", kind: "date", rule: "last_of_prev_month" },
          { label: "Amount", address: "F10", kind: "amount", rule: "cells", formula: "C5*C6" },
        ],
      },
    });
  });

  it("drops bad fields and an invoice without a sheet", () => {
    const s = cleanSettings({
      morning: {
        googleClientId: "no spaces allowed",
        invoice: {
          sheetId: ID,
          tab: "T",
          entryTag: "has space",
          fields: [
            { address: "B2", kind: "date", rule: "yesterday" },
            { address: "B2", kind: "amount", rule: "fixed", value: 100 },
            { address: "B2", kind: "amount", rule: "ask" },
            { address: "C3", kind: "amount", rule: "fixed" },
            { address: "C4", kind: "amount", rule: "cells", formula: "SUM(C1:C2)" },
            { address: "zz", kind: "date", rule: "today" },
          ],
        },
      },
    });
    expect(s.morning?.googleClientId).toBeNull();
    expect(s.morning?.invoice?.entryTag).toBe("duck:invoice");
    expect(s.morning?.invoice?.fields).toEqual([
      { label: "B2", address: "B2", kind: "amount", rule: "fixed", value: 100 },
    ]);
    expect(cleanSettings({ morning: { invoice: { sheetId: ID, tab: " " } } }).morning?.invoice).toBeNull();
  });
});
