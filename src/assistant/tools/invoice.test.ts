import { describe, expect, it } from "vitest";

import { fakePort, toolCtx } from "../fakePort.test-util";
import type { GoogleHost } from "../google";
import type { CellValue, SheetDraft } from "../../ipc/assistant";
import { DEFAULT_SETTINGS, type InvoiceSettings } from "../settings";
import { isoDate } from "./morning";
import { createRegistry } from "./registry";
import { createSheetDraft } from "./invoice";

const MONTH = isoDate(new Date()).slice(0, 7);

const invoice: InvoiceSettings = {
  sheetId: "1AbC_defGhIjKlMnOpQrStUvWxYz0123456789",
  tab: "Invoice",
  draftFolder: "Duck drafts",
  entryTag: "duck:invoice",
  fields: [
    { label: "Date", address: "B2", kind: "date", rule: "first_of_month" },
    { label: "Hours", address: "C5", kind: "amount", rule: "ask" },
    { label: "Total", address: "F10", kind: "amount", rule: "cells", formula: "C5*C6" },
  ],
};
const settings = { ...DEFAULT_SETTINGS, morning: { googleClientId: "123.apps.googleusercontent.com", invoice } };

/** A Google host over one sheet's cells; records the drafts asked for. */
function fakeGoogle(cells: { address: string; value: string; formula?: string }[]) {
  const drafts: { title: string; month: string; expect: CellValue[]; updates: CellValue[] }[] = [];
  const read: string[][] = [];
  const host: GoogleHost = {
    exportInvoice: () => Promise.reject(new Error("unused")),
    cells(_c, _i, addresses) {
      read.push(addresses);
      return Promise.resolve({ name: "Acme invoice", cells: cells.filter((c) => addresses.includes(c.address)) });
    },
    draft(_c, _i, p) {
      drafts.push(p);
      const d: SheetDraft = {
        id: "copy1",
        name: p.title,
        url: "https://docs.google.com/spreadsheets/d/copy1/edit",
        month: p.month,
        how: "copy",
        created: 1,
        cells: p.updates.map((u) => ({ address: u.address, value: u.value })),
      };
      return Promise.resolve(d);
    },
    findDraft: () => Promise.resolve(null),
  };
  return { host, drafts, read };
}

const SHEET = [
  { address: "B2", value: "2020-01-01" },
  { address: "C5", value: "150" },
  { address: "C6", value: "8" },
  { address: "F10", value: "1200" },
];

describe("create_sheet_draft", () => {
  const registry = createRegistry([createSheetDraft]);
  const port = fakePort({});

  it("shows each change on the card, then drafts exactly that", async () => {
    const g = fakeGoogle(SHEET);
    const env = { settings, google: g.host };
    const input = { amounts: { hours: 160 } };
    const prepared = await registry.prepare("create_sheet_draft", input, port, env);
    expect(g.read).toEqual([["B2", "C5", "F10", "C6"]]);
    expect(registry.tierOf("create_sheet_draft")).toBe("consequential");
    expect(registry.describe("create_sheet_draft", input, port, prepared)).toBe(
      `Copy "Acme invoice" as "Acme invoice draft ${MONTH} (Duck)" into the Drive folder "Duck drafts" and set ` +
        `Date (B2) 2020-01-01 → ${MONTH}-01; Hours (C5) 150 → 160; Total (F10) 1200 → 1280. The original isn't changed.`,
    );

    const ctx = { ...toolCtx(port, settings), google: g.host, prepared: prepared as never };
    const out = (await createSheetDraft.run(input, ctx)) as Record<string, unknown>;
    expect(g.drafts).toEqual([
      {
        title: `Acme invoice draft ${MONTH} (Duck)`,
        month: MONTH,
        expect: [
          { address: "B2", value: "2020-01-01" },
          { address: "C5", value: "150" },
          { address: "F10", value: "1200" },
        ],
        updates: [
          { address: "B2", value: `${MONTH}-01` },
          { address: "C5", value: "160" },
          { address: "F10", value: "1280" },
        ],
      },
    ]);
    expect(out).toMatchObject({ link: "https://docs.google.com/spreadsheets/d/copy1/edit", cells: [{ label: "Date", cell: "B2" }, {}, {}] });
  });

  it("fails before the card without answers, set-up, or anything to change", async () => {
    const g = fakeGoogle(SHEET);
    await expect(registry.prepare("create_sheet_draft", {}, port, { settings, google: g.host })).rejects.toThrow(
      /ask the user for Hours/,
    );
    await expect(registry.prepare("create_sheet_draft", { amounts: { Hours: 1 } }, port, { settings: DEFAULT_SETTINGS, google: g.host })).rejects.toThrow(
      /isn't set up/,
    );
    const done = fakeGoogle([
      { address: "B2", value: `${MONTH}-01` },
      { address: "C5", value: "160" },
      { address: "C6", value: "8" },
      { address: "F10", value: "=C5*C6", formula: "=C5*C6" },
    ]);
    await expect(registry.prepare("create_sheet_draft", { amounts: { Hours: 160 } }, port, { settings, google: done.host })).rejects.toThrow(
      /nothing to change/,
    );
    const expired: GoogleHost = { ...g.host, cells: () => Promise.reject(new Error("google_expired: Google access expired")) };
    await expect(registry.prepare("create_sheet_draft", { amounts: { Hours: 1 } }, port, { settings, google: expired })).rejects.toThrow(
      /reconnect in Duck's settings/,
    );
  });

  it("reports the backend's refusal as the reason", async () => {
    const g = fakeGoogle(SHEET);
    const input = { amounts: { Hours: 160 } };
    const prepared = await registry.prepare("create_sheet_draft", input, port, { settings, google: g.host });
    const host: GoogleHost = { ...g.host, draft: () => Promise.reject(new Error("this month's draft already exists: X (u)")) };
    const ctx = { ...toolCtx(port, settings), google: host, prepared: prepared as never };
    await expect(createSheetDraft.run(input, ctx)).rejects.toThrow(/the draft wasn't made: this month's draft already exists/);
  });
});
