// The morning routine's Google half (phase 2), as the engine sees it: reading the
// invoice sheet's configured cells, with a local copy kept in the workspace. The
// backend holds the tokens (`google.rs`) and makes every request (`sheets.rs`).

import type { InvoiceSettings } from "./settings";
import type { SheetExport } from "../ipc/assistant";

export interface GoogleHost {
  /** The invoice's cells, after exporting the sheet to `data/invoices/`. */
  exportInvoice(clientId: string, invoice: InvoiceSettings, date: string, workspace: string | null): Promise<SheetExport>;
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
}

export function createGoogleHost(ipc: GoogleIpc): GoogleHost {
  return {
    async exportInvoice(clientId, invoice, date, workspace) {
      const dir = await ipc.workspacePrepare(workspace);
      const addresses = invoice.fields.map((f) => f.address);
      return ipc.sheetExport(clientId, dir, date, invoice.sheetId, invoice.tab, addresses);
    },
  };
}
