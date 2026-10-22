import { describe, expect, it } from "vitest";

import { fakePort, toolCtx } from "../fakePort.test-util";
import type { DraftRequest, GoogleHost } from "../google";
import type { SheetDraft } from "../../ipc/assistant";
import { DEFAULT_SETTINGS } from "../settings";
import { isoDate } from "./morning";
import { createRegistry } from "./registry";
import { createSheetDraft, findSheet, readSheet } from "./sheets";

const MONTH = isoDate(new Date()).slice(0, 7);
const ID = "1AbC_defGhIjKlMnOpQrStUvWxYz0123456789";
const LINK = `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`;
const settings = { ...DEFAULT_SETTINGS, google: { clientId: "123.apps.googleusercontent.com" } };

const SHEET = [
  { address: "B2", value: "2026-09-01" },
  { address: "B3", value: "41" },
  { address: "F10", value: "$1,200.00", formula: "=C5*C6" },
];

/** A Google host over one sheet; records the drafts and exports asked for. */
function fakeGoogle(cells = SHEET) {
  const drafts: DraftRequest[] = [];
  const exports: string[][] = [];
  const host: GoogleHost = {
    search: (_c, q) => Promise.resolve(q === "acme" ? [{ id: ID, name: "Acme invoice", modified: "2026-09-30T10:00:00Z" }] : []),
    read: (_c, _id, tab) =>
      Promise.resolve({ name: "Acme invoice", tabs: ["Invoice", "Rates"], tab: tab || "Invoice", cells, cut: false }),
    cells: (_c, _id, _tab, addresses) =>
      Promise.resolve({ name: "Acme invoice", cells: cells.filter((c) => addresses.includes(c.address)) }),
    exportSheet(_c, _id, _tab, addresses) {
      exports.push(addresses);
      return Promise.resolve({ name: "Acme invoice", cells: [], csv: "", xlsx: "", sidecar: "" });
    },
    draft(_c, r) {
      drafts.push(r);
      const d: SheetDraft = {
        id: "copy1",
        name: r.title,
        url: "https://docs.google.com/spreadsheets/d/copy1/edit",
        month: r.month,
        how: "copy",
        created: 1,
        cells: r.updates.map((u) => ({ address: u.address, value: u.value })),
      };
      return Promise.resolve(d);
    },
    drafts: () => Promise.resolve([]),
  };
  return { host, drafts, exports };
}

describe("find_sheet and read_sheet", () => {
  it("find sheets by name and read a tab as untrusted cells", async () => {
    const g = fakeGoogle();
    const ctx = { ...toolCtx(fakePort({}), settings), google: g.host };
    expect(await findSheet.run({ name: "acme" }, ctx)).toEqual([
      { name: "Acme invoice", link: `https://docs.google.com/spreadsheets/d/${ID}/edit`, modified: "2026-09-30" },
    ]);
    expect(await findSheet.run({ name: "nope" }, ctx)).toMatch(/No Google Sheet's name contains "nope"/);
    const out = (await readSheet.run({ sheet: LINK }, ctx)) as string;
    expect(out).toMatch(/^<mcp_result server="google_sheets" tool="read_sheet" untrusted>\n/);
    expect(out).toContain('"F10: $1,200.00 (=C5*C6)"');
    expect(out).toContain('"tabs":["Invoice","Rates"]');
  });

  it("say how to connect when Google isn't set up", async () => {
    const ctx = { ...toolCtx(fakePort({})), google: fakeGoogle().host };
    await expect(Promise.resolve(readSheet.run({ sheet: ID }, ctx))).rejects.toThrow(/Duck's settings \(Google Auth\)/);
  });
});

describe("create_sheet_draft", () => {
  const registry = createRegistry([createSheetDraft]);
  const port = fakePort({});
  const input = {
    sheet: LINK,
    changes: [
      { cell: "b2", value: "2026-10-01", why: "invoice date: the 1st" },
      { cell: "B3", value: "42", why: "next invoice number" },
    ],
  };

  it("shows each change with Duck's reason on the card, then drafts exactly that", async () => {
    const g = fakeGoogle();
    const prepared = await registry.prepare("create_sheet_draft", input, port, { settings, google: g.host });
    expect(registry.tierOf("create_sheet_draft")).toBe("consequential");
    expect(registry.describe("create_sheet_draft", input, port, prepared)).toBe(
      `Copy "Acme invoice" as "Acme invoice draft ${MONTH} (Duck)" into the Drive folder "Duck drafts" and set, on tab "Invoice": ` +
        `B2 2026-09-01 → 2026-10-01 (invoice date: the 1st); B3 41 → 42 (next invoice number). The original isn't changed.`,
    );
    const ctx = { ...toolCtx(port, settings), google: g.host, prepared: prepared as never };
    const out = (await createSheetDraft.run(input, ctx)) as Record<string, unknown>;
    expect(g.exports).toEqual([["B2", "B3"]]);
    expect(g.drafts).toEqual([
      {
        sheetId: ID,
        tab: "Invoice",
        title: `Acme invoice draft ${MONTH} (Duck)`,
        month: MONTH,
        expect: [
          { address: "B2", value: "2026-09-01" },
          { address: "B3", value: "41" },
        ],
        updates: [
          { address: "B2", value: "2026-10-01" },
          { address: "B3", value: "42" },
        ],
      },
    ]);
    expect(out).toMatchObject({ link: "https://docs.google.com/spreadsheets/d/copy1/edit", cells: ["B2: 2026-10-01", "B3: 42"] });
  });

  it("refuses a formula cell, a formula value, a repeated cell and no change, before the card", async () => {
    const env = { settings, google: fakeGoogle().host };
    const prep = (changes: { cell: string; value: string; why: string }[]) =>
      registry.prepare("create_sheet_draft", { sheet: ID, tab: "Invoice", changes }, port, env);
    await expect(prep([{ cell: "F10", value: "1300", why: "x" }])).rejects.toThrow(/F10 holds a formula \(=C5\*C6\)/);
    await expect(prep([{ cell: "B2", value: "=TODAY()", why: "x" }])).rejects.toThrow(/plain values/);
    await expect(prep([{ cell: "B2", value: "1", why: "x" }, { cell: "$B$2", value: "2", why: "x" }])).rejects.toThrow(/changed twice/);
    await expect(prep([{ cell: "B2:B3", value: "1", why: "x" }])).rejects.toThrow(/not one cell/);
    await expect(prep([{ cell: "B3", value: "41", why: "x" }])).rejects.toThrow(/nothing to change/);
  });

  it("reports the backend's refusal and an expired sign-in as the reason", async () => {
    const g = fakeGoogle();
    const prepared = await registry.prepare("create_sheet_draft", input, port, { settings, google: g.host });
    const host: GoogleHost = { ...g.host, draft: () => Promise.reject(new Error("this month's draft already exists: X (u)")) };
    const ctx = { ...toolCtx(port, settings), google: host, prepared: prepared as never };
    await expect(createSheetDraft.run(input, ctx)).rejects.toThrow(/the draft wasn't made: this month's draft already exists/);
    const expired: GoogleHost = { ...g.host, cells: () => Promise.reject(new Error("google_expired: Google access expired")) };
    await expect(registry.prepare("create_sheet_draft", input, port, { settings, google: expired })).rejects.toThrow(
      /reconnect in Duck's settings \(Google Auth\)/,
    );
  });
});
