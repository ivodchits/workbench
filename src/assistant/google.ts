// Duck's Google Sheets, as the engine sees it: finding and reading a sheet, so Duck
// can work out what a draft should change (the morning routine's invoice), making
// the draft copy, and listing the month's drafts; and Drive files of any kind (the
// Drive tools: search, metadata, copy, rename, move, folders, trash, download and
// upload). The backend holds the tokens (`google.rs`) and makes every request
// (`sheets.rs`, `drive.rs`).

import type {
  CellValue,
  DraftRef,
  DriveDownloaded,
  DriveFile,
  DriveMoved,
  DriveQuery,
  DriveRenamed,
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
  /** Drive files of any kind; absent where there are none (some tests). */
  drive?: DriveHost;
}

/** Google Drive files of any kind, over the `assistant_drive_*` commands. */
export interface DriveHost {
  search(clientId: string, query: DriveQuery): Promise<DriveFile[]>;
  file(clientId: string, fileId: string): Promise<DriveFile>;
  /** A copy named `name` in `folder` (the original's when null); the original is only read. */
  copy(clientId: string, fileId: string, name: string, folder: string | null): Promise<DriveFile>;
  rename(clientId: string, fileId: string, name: string): Promise<DriveRenamed>;
  move(clientId: string, fileId: string, folder: string): Promise<DriveMoved>;
  createFolder(clientId: string, name: string, parent: string | null): Promise<DriveFile>;
  trash(clientId: string, fileId: string): Promise<DriveFile>;
  /** Into the workspace's `data/drive/` (prepares the workspace first). */
  download(clientId: string, fileId: string, workspace: string | null): Promise<DriveDownloaded>;
  upload(clientId: string, path: string, name: string | null, folder: string | null): Promise<DriveFile>;
}

/** `ipc/assistant`'s Drive calls, or fakes in tests. */
export interface DriveIpc {
  workspacePrepare(dir: string | null): Promise<string>;
  driveSearch(clientId: string, query: DriveQuery): Promise<DriveFile[]>;
  driveFile(clientId: string, fileId: string): Promise<DriveFile>;
  driveCopy(clientId: string, fileId: string, name: string, folder: string | null): Promise<DriveFile>;
  driveRename(clientId: string, fileId: string, name: string): Promise<DriveRenamed>;
  driveMove(clientId: string, fileId: string, folder: string): Promise<DriveMoved>;
  driveCreateFolder(clientId: string, name: string, parent: string | null): Promise<DriveFile>;
  driveTrash(clientId: string, fileId: string): Promise<DriveFile>;
  driveDownload(clientId: string, workspace: string, fileId: string): Promise<DriveDownloaded>;
  driveUpload(clientId: string, path: string, name: string | null, folder: string | null): Promise<DriveFile>;
}

export function createDriveHost(ipc: DriveIpc): DriveHost {
  return {
    search: (clientId, query) => ipc.driveSearch(clientId, query),
    file: (clientId, fileId) => ipc.driveFile(clientId, fileId),
    copy: (clientId, fileId, name, folder) => ipc.driveCopy(clientId, fileId, name, folder),
    rename: (clientId, fileId, name) => ipc.driveRename(clientId, fileId, name),
    move: (clientId, fileId, folder) => ipc.driveMove(clientId, fileId, folder),
    createFolder: (clientId, name, parent) => ipc.driveCreateFolder(clientId, name, parent),
    trash: (clientId, fileId) => ipc.driveTrash(clientId, fileId),
    async download(clientId, fileId, workspace) {
      const dir = await ipc.workspacePrepare(workspace);
      return ipc.driveDownload(clientId, dir, fileId);
    },
    upload: (clientId, path, name, folder) => ipc.driveUpload(clientId, path, name, folder),
  };
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

export function createGoogleHost(ipc: GoogleIpc, drive?: DriveHost): GoogleHost {
  return {
    ...(drive && { drive }),
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
