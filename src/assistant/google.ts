// The morning routine's Google half, as the engine sees it: reading the invoice
// sheet's cells, with a local copy kept in the workspace (phase 2), and making this
// month's draft copy and reading it back (phase 3). The backend holds the tokens
// (`google.rs`) and makes every request (`sheets.rs`).

import type { InvoiceSettings } from "./settings";
import { cellsToRead } from "./invoice";
import type { CellValue, SheetCells, SheetDraft, SheetExport } from "../ipc/assistant";

export interface GoogleHost {
  /** The invoice's cells and those its formulas read, after exporting the sheet to
   *  `data/invoices/`. */
  exportInvoice(clientId: string, invoice: InvoiceSettings, date: string, workspace: string | null): Promise<SheetExport>;
  /** The sheet's cells at `addresses`, as they are now. */
  cells(clientId: string, invoice: InvoiceSettings, addresses: string[]): Promise<SheetCells>;
  /** Copy the sheet as `title` into the drafts folder and set `updates` in the copy;
   *  `expect` is what the card showed of the original. */
  draft(
    clientId: string,
    invoice: InvoiceSettings,
    plan: { title: string; month: string; expect: CellValue[]; updates: CellValue[] },
  ): Promise<SheetDraft>;
  /** This month's draft with its configured cells; null when there's none in Drive. */
  findDraft(clientId: string, invoice: InvoiceSettings, month: string): Promise<SheetDraft | null>;
}

/** What the backend's errors start with once Google's refresh token is dead. */
const EXPIRED = "google_expired:";

/** Whether `e` says Google access has to be reconnected. */
export function isGoogleExpired(e: unknown): boolean {
  return String(e instanceof Error ? e.message : e).startsWith(EXPIRED);
}

/** The error's text, without its code. */
export function googleErrorText(e: unknown): string {
  return String(e instanceof Error ? e.message : e).replace(EXPIRED, "").trim();
}

/** `ipc/assistant`'s calls, or fakes in tests. */
export interface GoogleIpc {
  workspacePrepare(dir: string | null): Promise<string>;
  sheetExport(
    clientId: string,
    workspace: string,
    date: string,
    sheetId: string,
    tab: string,
    addresses: string[],
  ): Promise<SheetExport>;
  sheetCells(clientId: string, sheetId: string, tab: string, addresses: string[]): Promise<SheetCells>;
  sheetDraft(
    clientId: string,
    sheetId: string,
    tab: string,
    folder: string,
    title: string,
    month: string,
    expect: CellValue[],
    updates: CellValue[],
  ): Promise<SheetDraft>;
  sheetDraftFind(clientId: string, sheetId: string, tab: string, month: string, addresses: string[]): Promise<SheetDraft | null>;
}

export function createGoogleHost(ipc: GoogleIpc): GoogleHost {
  const addressesOf = (invoice: InvoiceSettings) => invoice.fields.map((f) => f.address);
  return {
    async exportInvoice(clientId, invoice, date, workspace) {
      const dir = await ipc.workspacePrepare(workspace);
      return ipc.sheetExport(clientId, dir, date, invoice.sheetId, invoice.tab, cellsToRead(invoice));
    },
    cells: (clientId, invoice, addresses) => ipc.sheetCells(clientId, invoice.sheetId, invoice.tab, addresses),
    draft: (clientId, invoice, p) =>
      ipc.sheetDraft(clientId, invoice.sheetId, invoice.tab, invoice.draftFolder, p.title, p.month, p.expect, p.updates),
    findDraft: (clientId, invoice, month) =>
      ipc.sheetDraftFind(clientId, invoice.sheetId, invoice.tab, month, addressesOf(invoice)),
  };
}
