// Duck's Google Sheets, as the engine sees it: finding and reading a sheet, so Duck
// can work out what a draft should change (the morning routine's invoice), making
// the draft copy, and listing the month's drafts. The backend holds the tokens
// (`google.rs`) and makes every request (`sheets.rs`).

import type {
  CellValue,
  DraftRef,
  SheetCells,
  SheetDraft,
  SheetExport,
  SheetFound,
  SheetRead,
} from "../ipc/assistant";

/** The Drive folder Duck's drafts go in (Duck creates it). */
export const DRAFT_FOLDER = "Duck drafts";

export interface DraftRequest {
  sheetId: string;
  tab: string;
  title: string;
  month: string;
  /** The original's cells as the card showed them. */
  expect: CellValue[];
  updates: CellValue[];
}

export interface GoogleHost {
  search(clientId: string, query: string): Promise<SheetFound[]>;
  /** A tab's cells with their formulas (the first tab when `tab` is empty). */
  read(clientId: string, sheetId: string, tab: string): Promise<SheetRead>;
  /** The cells at `addresses`, as they are now. */
  cells(clientId: string, sheetId: string, tab: string, addresses: string[]): Promise<SheetCells>;
  /** Keep a copy of the original in the workspace's `data/invoices/`. */
  exportSheet(
    clientId: string,
    sheetId: string,
    tab: string,
    addresses: string[],
    date: string,
    workspace: string | null,
  ): Promise<SheetExport>;
  /** Copy the sheet into the drafts folder and set `updates` in the copy. */
  draft(clientId: string, req: DraftRequest): Promise<SheetDraft>;
  /** The drafts made for `month` that are still in Drive. */
  drafts(clientId: string, month: string): Promise<DraftRef[]>;
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
  sheetDrafts(clientId: string, month: string): Promise<DraftRef[]>;
  sheetSearch(clientId: string, query: string): Promise<SheetFound[]>;
  sheetRead(clientId: string, sheetId: string, tab: string): Promise<SheetRead>;
}

export function createGoogleHost(ipc: GoogleIpc): GoogleHost {
  return {
    search: (clientId, query) => ipc.sheetSearch(clientId, query),
    read: (clientId, sheetId, tab) => ipc.sheetRead(clientId, sheetId, tab),
    cells: (clientId, sheetId, tab, addresses) => ipc.sheetCells(clientId, sheetId, tab, addresses),
    async exportSheet(clientId, sheetId, tab, addresses, date, workspace) {
      const dir = await ipc.workspacePrepare(workspace);
      return ipc.sheetExport(clientId, dir, date, sheetId, tab, addresses);
    },
    draft: (clientId, r) =>
      ipc.sheetDraft(clientId, r.sheetId, r.tab, DRAFT_FOLDER, r.title, r.month, r.expect, r.updates),
    drafts: (clientId, month) => ipc.sheetDrafts(clientId, month),
  };
}
