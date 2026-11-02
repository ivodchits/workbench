import { describe, expect, it } from "vitest";

import { fakePort, toolCtx } from "../fakePort.test-util";
import { createDriveHost, type DriveHost, type DriveIpc, type GoogleHost } from "../google";
import type { DriveFile, DriveQuery } from "../../ipc/assistant";
import { DEFAULT_SETTINGS } from "../settings";
import { DEFERRED, TOOLS } from "../toolset";
import { createRegistry } from "./registry";
import {
  DRIVE_TOOLS,
  driveCopy,
  driveCreateFolder,
  driveDownload,
  driveFileInfo,
  driveFind,
  driveIdOf,
  driveMove,
  driveRename,
  driveTrash,
  driveUpload,
} from "./drive";

const settings = { ...DEFAULT_SETTINGS, google: { clientId: "123.apps.googleusercontent.com" } };
const SEPT = "1SeptInvoice_xlsx_0123456789abcdef";
const AUG = "1AugInvoice_xlsx_0123456789abcdefg";
const FOLDER = "1InvoicesFolder_0123456789abcdef";

function file(id: string, name: string, extra: Partial<DriveFile> = {}): DriveFile {
  return {
    id,
    name,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    kind: "xlsx",
    parents: [FOLDER],
    link: `https://docs.google.com/spreadsheets/d/${id}/edit`,
    trashed: false,
    ownedByMe: true,
    ...extra,
  };
}

/** A Drive over a few files; every change is recorded, the files are changed in place. */
function fakeDrive() {
  const files = new Map<string, DriveFile>([
    [AUG, file(AUG, "Igor Vodchits TinyWizard Invoice 2026_08.xlsx", { modified: "2026-08-31T10:00:00Z" })],
    [SEPT, file(SEPT, "Igor Vodchits TinyWizard Invoice 2026_09.xlsx", { modified: "2026-09-30T10:00:00Z", size: 18234 })],
    [FOLDER, file(FOLDER, "Invoices", { mimeType: "application/vnd.google-apps.folder", kind: "folder", parents: ["root"] })],
  ]);
  const calls: string[] = [];
  const queries: DriveQuery[] = [];
  const get = (id: string) => {
    const f = files.get(id);
    if (!f) throw new Error("Google can't find that file");
    return f;
  };
  const drive: DriveHost = {
    search(_c, q) {
      queries.push(q);
      const hits = [...files.values()]
        .filter((f) => !f.trashed && (!q.name || f.name.includes(q.name)) && (!q.kind || f.kind === q.kind || (q.kind === "spreadsheet" && f.kind === "xlsx")))
        .sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""));
      return Promise.resolve(hits);
    },
    file: (_c, id) => Promise.resolve({ ...get(id), folders: ["Invoices"] }),
    copy(_c, id, name, folder) {
      calls.push(`copy ${id} ${name} ${folder}`);
      const src = get(id);
      const copy = { ...src, id: "1TheCopy_0123456789abcdef", name, parents: [folder ?? src.parents[0]], modified: "2026-11-02T09:00:00Z" };
      files.set(copy.id, copy);
      return Promise.resolve(copy);
    },
    rename(_c, id, name) {
      calls.push(`rename ${id} ${name}`);
      const f = get(id);
      const was = f.name;
      files.set(id, { ...f, name });
      return Promise.resolve({ file: get(id), was });
    },
    move(_c, id, folder) {
      calls.push(`move ${id} ${folder}`);
      const f = get(id);
      files.set(id, { ...f, parents: [folder] });
      return Promise.resolve({ file: get(id), from: f.parents });
    },
    createFolder(_c, name, parent) {
      calls.push(`folder ${name} ${parent}`);
      return Promise.resolve(file("1NewFolder_0123456789abcdef", name, { kind: "folder", parents: [parent ?? "root"] }));
    },
    trash(_c, id) {
      calls.push(`trash ${id}`);
      files.set(id, { ...get(id), trashed: true });
      return Promise.resolve(get(id));
    },
    download(_c, id, workspace) {
      calls.push(`download ${id} ${workspace}`);
      return Promise.resolve({ file: get(id), path: `C:\\Duck\\data\\drive\\${get(id).name}`, bytes: 18234 });
    },
    upload(_c, path, name, folder) {
      calls.push(`upload ${path} ${name} ${folder}`);
      return Promise.resolve(file("1Uploaded_0123456789abcdef", name ?? "x.pdf", { kind: "pdf", parents: [folder ?? "root"] }));
    },
  };
  return { drive, files, calls, queries };
}

function setUp() {
  const d = fakeDrive();
  const google = { drive: d.drive } as unknown as GoogleHost;
  const port = fakePort({});
  const ctx = { ...toolCtx(port, settings), google };
  return { ...d, google, port, ctx };
}

describe("Drive file tools", () => {
  it("take links and ids", () => {
    expect(driveIdOf(`https://docs.google.com/spreadsheets/d/${SEPT}/edit#gid=0`)).toBe(SEPT);
    expect(driveIdOf(`https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`)).toBe(FOLDER);
    expect(driveIdOf(`https://drive.google.com/open?id=${SEPT}`)).toBe(SEPT);
    expect(driveIdOf(` ${SEPT} `)).toBe(SEPT);
    expect(driveIdOf("the invoice")).toBeNull();
  });

  it("are tiered as asked: reads, reversible changes, and a card for trash and upload", () => {
    const registry = createRegistry(DRIVE_TOOLS);
    const tiers = Object.fromEntries(DRIVE_TOOLS.map((t) => [t.name, registry.tierOf(t.name)]));
    expect(tiers).toEqual({
      drive_find: "read",
      drive_file: "read",
      drive_copy: "reversible",
      drive_rename: "reversible",
      drive_move: "reversible",
      drive_create_folder: "reversible",
      drive_download: "reversible",
      drive_trash: "consequential",
      drive_upload: "consequential",
    });
    for (const t of DRIVE_TOOLS) {
      expect(TOOLS).toContain(t);
      expect(DEFERRED.has(t.name)).toBe(true);
    }
  });

  it("find the latest invoice (an xlsx find_sheet can't see) and copy it under next month's name, leaving the original alone", async () => {
    const { ctx, files, calls, queries } = setUp();
    const found = (await driveFind.run({ name: "TinyWizard Invoice", kind: "spreadsheet" }, ctx)) as string;
    expect(found).toMatch(/^<mcp_result server="google_drive" tool="drive_find" untrusted>\n/);
    const list = JSON.parse(found.split("\n")[1]) as { id: string; name: string }[];
    expect(list[0]).toMatchObject({ id: SEPT, name: "Igor Vodchits TinyWizard Invoice 2026_09.xlsx", kind: "xlsx" });
    expect(queries).toEqual([{ name: "TinyWizard Invoice", kind: "spreadsheet" }]);

    const before = structuredClone(files.get(SEPT));
    const out = (await driveCopy.run({ file: list[0].id, name: "Igor Vodchits TinyWizard Invoice 2026_10.xlsx" }, ctx)) as {
      copy: { id: string; name: string };
    };
    expect(out.copy).toMatchObject({ name: "Igor Vodchits TinyWizard Invoice 2026_10.xlsx", parents: [FOLDER] });
    expect(out.copy.id).not.toBe(SEPT);
    expect(calls).toEqual([`copy ${SEPT} Igor Vodchits TinyWizard Invoice 2026_10.xlsx null`]);
    expect(files.get(SEPT)).toEqual(before);
  });

  it("pass the search's filters through, folders by link and My Drive as root", async () => {
    const { ctx, queries } = setUp();
    await driveFind.run(
      {
        folder: `https://drive.google.com/drive/folders/${FOLDER}`,
        kind: "any",
        modified_after: "2026-09-01",
        modified_before: "2026-10-01",
        limit: 5,
      },
      ctx,
    );
    await driveFind.run({ folder: "My Drive" }, ctx);
    expect(queries).toEqual([
      { folder: FOLDER, modifiedAfter: "2026-09-01", modifiedBefore: "2026-10-01", limit: 5 },
      { folder: "root" },
    ]);
    expect(driveFind.schema.safeParse({ modified_after: "last week" }).success).toBe(false);
    expect(driveFind.schema.safeParse({ kind: "movie" }).success).toBe(false);
    expect(await driveFind.run({ name: "nothing like it" }, ctx)).toBe("No file in Drive matches that.");
  });

  it("read metadata, rename, move, make a folder and download, each saying what it was before", async () => {
    const { ctx, calls } = setUp();
    const meta = (await driveFileInfo.run({ file: SEPT }, ctx)) as string;
    expect(meta).toContain('"folders":["Invoices"]');
    expect(meta).toContain('"size":18234');
    const r = (await driveRename.run({ file: AUG, name: "Old invoice.xlsx" }, ctx)) as { was: string };
    expect(r.was).toBe("Igor Vodchits TinyWizard Invoice 2026_08.xlsx");
    const m = (await driveMove.run({ file: AUG, folder: "root" }, ctx)) as { from: string[] };
    expect(m.from).toEqual([FOLDER]);
    await driveCreateFolder.run({ name: "2026 invoices", parent: FOLDER }, ctx);
    const d = (await driveDownload.run({ file: SEPT }, { ...ctx, settings: { ...settings, workspace: "C:\\Duck" } })) as {
      path: string;
    };
    expect(d.path).toBe("C:\\Duck\\data\\drive\\Igor Vodchits TinyWizard Invoice 2026_09.xlsx");
    expect(calls).toEqual([
      `rename ${AUG} Old invoice.xlsx`,
      `move ${AUG} root`,
      `folder 2026 invoices ${FOLDER}`,
      `download ${SEPT} C:\\Duck`,
    ]);
  });

  it("trash only after a card naming the file, and refuse what's already there", async () => {
    const { ctx, google, port, calls } = setUp();
    const registry = createRegistry([driveTrash]);
    const prepared = await registry.prepare("drive_trash", { file: AUG }, port, { settings, google });
    expect(registry.describe("drive_trash", { file: AUG }, port, prepared)).toBe(
      `Move "Igor Vodchits TinyWizard Invoice 2026_08.xlsx" (xlsx) from "Invoices" to Google Drive's trash. It can be restored there for 30 days.`,
    );
    expect(calls).toEqual([]);
    await driveTrash.run({ file: AUG }, { ...ctx, prepared: prepared as never });
    expect(calls).toEqual([`trash ${AUG}`]);
    await expect(registry.prepare("drive_trash", { file: AUG }, port, { settings, google })).rejects.toThrow(/already in the trash/);
  });

  it("upload after a card with the path and the folder", async () => {
    const { ctx, port, calls } = setUp();
    const registry = createRegistry([driveUpload]);
    const input = { path: "C:\\Users\\me\\invoice.pdf", folder: FOLDER };
    expect(registry.describe("drive_upload", input, port, undefined)).toBe(
      `Upload C:\\Users\\me\\invoice.pdf to Google Drive, into the folder ${FOLDER}.`,
    );
    await driveUpload.run(input, { ...ctx, prepared: undefined });
    expect(calls).toEqual([`upload C:\\Users\\me\\invoice.pdf null ${FOLDER}`]);
  });

  it("say how to connect, and to reconnect for the full Drive scope or an expired sign-in", async () => {
    const { ctx, drive } = setUp();
    await expect(Promise.resolve(driveFind.run({}, { ...toolCtx(fakePort({})), google: ctx.google }))).rejects.toThrow(
      /Duck's settings \(Google Auth\)/,
    );
    const scoped = { drive: { ...drive, rename: () => Promise.reject(new Error("Duck's Google sign-in doesn't cover this: reconnect Google")) } };
    await expect(
      driveRename.run({ file: SEPT, name: "x.xlsx" }, { ...ctx, google: scoped as unknown as GoogleHost }),
    ).rejects.toThrow(/it wasn't renamed: Duck's Google sign-in doesn't cover this/);
    const expired = { drive: { ...drive, search: () => Promise.reject(new Error("google_expired: Google access expired")) } };
    await expect(driveFind.run({}, { ...ctx, google: expired as unknown as GoogleHost })).rejects.toThrow(
      /reconnect in Duck's settings \(Google Auth\)/,
    );
    await expect(driveCopy.run({ file: "not an id!", name: "x" }, ctx)).rejects.toThrow(/not a Google Drive link or file id/);
  });

  it("prepare the workspace before a download", async () => {
    const seen: string[] = [];
    const ipc = {
      workspacePrepare: (dir: string | null) => (seen.push(`prepare ${dir}`), Promise.resolve("C:\\Duck")),
      driveDownload: (_c: string, ws: string, id: string) => (seen.push(`download ${ws} ${id}`), Promise.resolve({})),
    } as unknown as DriveIpc;
    await createDriveHost(ipc).download("c", SEPT, null);
    expect(seen).toEqual(["prepare null", `download C:\\Duck ${SEPT}`]);
  });
});
