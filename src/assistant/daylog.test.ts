import { describe, expect, it, vi } from "vitest";
import type { TranscriptPage } from "../ipc/transcript";
import type { GitActivity } from "../ipc/daylog";
import {
  createDayLog,
  dayBounds,
  dayOf,
  entriesFrom,
  looksLikeCode,
  notesForTidy,
  plainWords,
  timeOn,
  unionNotes,
  type CaptureOut,
  type DayEntries,
  type LogMachine,
  type LogState,
  type Note,
  type TidyOut,
} from "./daylog";
import { readActivity, type SourceDeps } from "./daylogSource";

// ── a fake machine: transcript files, git, read with the real reader ──

const DAY = "2026-11-24";
const at = (hh: number, mm = 0, day = DAY) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, hh, mm).getTime();
};

function user(id: string, ms: number, text: string): string {
  return JSON.stringify({ type: "user", uuid: id, timestamp: new Date(ms).toISOString(), message: { role: "user", content: text } });
}
function claude(id: string, ms: number, text: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid: id,
    timestamp: new Date(ms).toISOString(),
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

class FakeFile {
  lines: string[] = [];
  add(...l: string[]) {
    this.lines.push(...l);
  }
  private offsets() {
    const o: number[] = [];
    let n = 0;
    for (const l of this.lines) {
      o.push(n);
      n += l.length + 1;
    }
    return { o, end: n };
  }
  forward(from: number): TranscriptPage {
    const { o, end } = this.offsets();
    const i = o.findIndex((x) => x >= from);
    const lines = i < 0 ? [] : this.lines.slice(i);
    return { sessionId: "s", lines, offset: from, nextOffset: lines.length ? end : from, end };
  }
  back(before?: number): TranscriptPage {
    const { o, end } = this.offsets();
    const stop = before ?? end;
    const lines = this.lines.filter((_, i) => o[i] < stop);
    return { sessionId: "s", lines, offset: 0, nextOffset: stop, end };
  }
}

interface FakeMachine {
  id: string;
  name: string;
  files: Map<string, { file: FakeFile; modifiedAt: number; prompt: string }>;
  commits: GitActivity;
  reads: number;
  down: boolean;
}

function machine(id: string, name: string): FakeMachine {
  return { id, name, files: new Map(), commits: { commits: [], resets: [] }, reads: 0, down: false };
}

function session(m: FakeMachine, sid: string, prompt: string, ...lines: string[]) {
  const s = m.files.get(sid) ?? { file: new FakeFile(), modifiedAt: 0, prompt };
  s.file.add(...lines);
  // Written now, as far as the log's clock goes.
  s.modifiedAt = NOW / 1000;
  m.files.set(sid, s);
}

function asLogMachine(m: FakeMachine): LogMachine {
  const deps: SourceDeps = {
    projects: () => [{ name: "Shop", rootPath: `C:/work/${m.id}/shop` }],
    sessions: async () =>
      [...m.files.entries()].map(([sessionId, s]) => ({ sessionId, modifiedAt: s.modifiedAt, firstPrompt: s.prompt, cwd: "" })),
    readForward: async (sid, from) => m.files.get(sid)!.file.forward(from),
    readBack: async (sid, before) => m.files.get(sid)!.file.back(before),
    git: async (_dir, since) => ({
      commits: m.commits.commits.filter((c) => c.at > since),
      resets: m.commits.resets.filter((r) => r.at > since),
    }),
    origin: async () => "https://github.com/me/shop.git",
  };
  return {
    id: m.id,
    name: m.name,
    activity: async (req) => {
      if (m.down) throw new Error(`${m.name} isn't connected`);
      m.reads++;
      return readActivity(deps, req);
    },
  };
}

// ── the repo, in memory ──

function memFiles() {
  const notes = new Map<string, Note[]>();
  const days = new Map<string, DayEntries>();
  let state: LogState | null = null;
  const saves: string[] = [];
  return {
    notes,
    days,
    saves,
    get state() {
      return state;
    },
    files: {
      load: async (ds: string[]) => ({
        state: state && structuredClone(state),
        days: Object.fromEntries(ds.map((d) => [d, { notes: structuredClone(notes.get(d) ?? []), entries: days.has(d) ? structuredClone(days.get(d)!) : null }])),
      }),
      save: async (s: { notes?: Record<string, Note[]>; days?: Record<string, DayEntries>; state?: LogState }, message: string) => {
        saves.push(message);
        for (const [d, ns] of Object.entries(s.notes ?? {})) {
          const have = notes.get(d) ?? [];
          const ids = new Set(have.map((n) => n.id));
          notes.set(d, [...have, ...ns.filter((n) => !ids.has(n.id))].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)));
        }
        for (const [d, e] of Object.entries(s.days ?? {})) days.set(d, structuredClone(e));
        if (s.state) state = structuredClone(s.state);
        return {};
      },
    },
  };
}

/** A capture call that notes each `user:` line as it says, and a commit as done. */
function noteEach(): (input: string) => Promise<CaptureOut> {
  return async (input) => {
    const notes: CaptureOut["notes"] = [];
    for (const line of input.split("\n")) {
      const m = /^\[(\d\d:\d\d)\] (?:\(session: [^)]*\) )?user: (.*)$/.exec(line);
      if (m) {
        const kind = /^undo/i.test(m[2]) ? "undone" : /^start/i.test(m[2]) ? "started" : "done";
        notes.push({ at: m[1], text: m[2], kind });
      }
      const c = /^\[(\d\d:\d\d)\] commit(?: \(a revert\))?: (.*)$/.exec(line);
      if (c) notes.push({ at: c[1], text: c[2], kind: line.includes("a revert") ? "undone" : "done" });
    }
    return { notes };
  };
}

const NOW = at(18);

function setup(machines: FakeMachine[], tidy?: (input: string) => Promise<TidyOut>) {
  const mem = memFiles();
  let clock = NOW;
  const capture = vi.fn(noteEach());
  const tidyCall = vi.fn(tidy ?? (async () => ({ entries: [] })));
  const log = createDayLog({
    machines: () => machines.map(asLogMachine),
    localId: () => machines[0].id,
    files: mem.files,
    capture,
    tidy: tidyCall,
    // Time passes a little with every look at the clock.
    now: () => (clock += 1000),
    warn: () => {},
  });
  return { mem, capture, tidyCall, log };
}

/** A tidy that makes one entry from every note, and a reverted one when a note was undone. */
const oneEntry =
  (title: string) =>
  async (input: string): Promise<TidyOut> => {
    const ids = [...input.matchAll(/id ([0-9a-f]{16})/g)].map((m) => m[1]);
    const times = [...input.matchAll(/^\[(\d\d:\d\d)\]/gm)].map((m) => m[1]);
    const undone = input.includes(", undone, ");
    const started = input.includes(", started, ") && !input.includes(", done, ");
    return {
      entries: [
        {
          title,
          detail: null,
          status: undone ? "reverted" : started ? "in_progress" : "done",
          from: times[0],
          to: times[times.length - 1],
          notes: ids,
        },
      ],
    };
  };

describe("the daily log's days", () => {
  it("runs from 04:00 to 04:00", () => {
    expect(dayOf(at(3, 59, "2026-11-25"))).toBe("2026-11-24");
    expect(dayOf(at(4, 0, "2026-11-25"))).toBe("2026-11-25");
    expect(dayBounds(DAY)).toEqual({ start: at(4), end: at(4, 0, "2026-11-25") });
    // Before 04:00 is the next morning.
    expect(timeOn(DAY, "01:30")).toBe(at(1, 30, "2026-11-25"));
    expect(timeOn(DAY, "14:05")).toBe(at(14, 5));
    expect(timeOn(DAY, "25:00")).toBeNull();
  });
});

describe("the words check", () => {
  it("takes out paths, code in backticks and commit ids", () => {
    const cases = [
      "Fixed the crash in `useWindow()` when closing",
      "Changed src/state/fleetRail.ts to merge projects",
      "Updated C:\\repos\\workbench\\README.md",
      "Reverted 3fa9c21b and the export",
      "Edited settings.json for the theme",
    ];
    for (const c of cases) {
      const out = plainWords(c);
      expect(looksLikeCode(out), `${c} → ${out}`).toBe(false);
      expect(out).not.toMatch(/[`/\\]/);
    }
    expect(plainWords("Added a search box to the notes list.")).toBe("Added a search box to the notes list.");
    expect(plainWords("Reverted 3fa9c21b and the export")).toBe("Reverted and the export");
    // Words that only look hex stay.
    expect(plainWords("Added a cafe and a facade")).toBe("Added a cafe and a facade");
  });
});

describe("capture", () => {
  it("makes no call with nothing new, and never notes the same offset twice", async () => {
    const desk = machine("d1", "desktop");
    const { log, capture, mem } = setup([desk]);
    let r = await log.capture();
    expect(r.calls).toBe(0);
    expect(capture).not.toHaveBeenCalled();

    session(desk, "s1", "the export", user("u1", at(9), "Add a CSV export"), claude("a1", at(9, 5), "Done."));
    r = await log.capture();
    expect(r).toMatchObject({ calls: 1, notes: 1 });
    expect(mem.notes.get(DAY)!.map((n) => n.text)).toEqual(["Add a CSV export"]);

    // Again with nothing new: no call, no new note.
    r = await log.capture();
    expect(r.calls).toBe(0);
    expect(mem.notes.get(DAY)).toHaveLength(1);

    // More in the same session: only what's past the offset is sent.
    session(desk, "s1", "the export", user("u2", at(10), "Start a PDF export"));
    r = await log.capture();
    expect(r.calls).toBe(1);
    expect(capture.mock.calls[1][0]).toContain("Start a PDF export");
    expect(capture.mock.calls[1][0]).not.toContain("Add a CSV export");
    expect(mem.notes.get(DAY)!.map((n) => n.kind)).toEqual(["done", "started"]);
  });

  it("notes a commit seen on two machines once, and keeps a machine that's away for later", async () => {
    const desk = machine("d1", "desktop");
    const lap = machine("l1", "laptop");
    const commit = { hash: "a".repeat(40), at: at(11) / 1000, subject: "Add the export", body: "", revert: false };
    desk.commits.commits.push(commit);
    lap.commits.commits.push(commit);
    lap.down = true;
    session(lap, "s9", "the laptop's", user("u9", at(12), "Fix the login page"));
    const { log, mem } = setup([desk, lap]);
    let r = await log.capture();
    expect(r.away).toEqual(["laptop"]);
    expect(mem.notes.get(DAY)!.map((n) => n.text)).toEqual(["Add the export"]);
    // It's back: its work lands on the day it was done; the shared commit isn't noted again.
    lap.down = false;
    r = await log.capture();
    expect(mem.notes.get(DAY)!.map((n) => `${n.machine}: ${n.text}`)).toEqual(["desktop: Add the export", "laptop: Fix the login page"]);
    expect(mem.state!.noted[DAY]).toBeDefined();
  });

  it("stops at the budget's cap and reads the rest next time", async () => {
    const desk = machine("d1", "desktop");
    session(desk, "s1", "x", user("u1", at(9), "Add a thing"));
    const mem = memFiles();
    let capped = true;
    const log = createDayLog({
      machines: () => [asLogMachine(desk)],
      localId: () => "d1",
      files: mem.files,
      capture: async (input) => {
        if (capped) throw new Error("budget_exceeded");
        return noteEach()(input);
      },
      tidy: async () => ({ entries: [] }),
      now: () => NOW,
      isCap: (e) => String(e).includes("budget"),
      warn: () => {},
    });
    expect((await log.capture()).capped).toBe(true);
    expect(mem.notes.get(DAY) ?? []).toEqual([]);
    capped = false;
    expect((await log.capture()).notes).toBe(1);
  });
});

describe("tidy", () => {
  it("folds work reverted later in the day into one reverted entry", async () => {
    const desk = machine("d1", "desktop");
    session(desk, "s1", "theme", user("u1", at(9), "Add a dark theme"), user("u2", at(15), "Undo the dark theme, it's too dim"));
    const { log, mem, tidyCall } = setup([desk], oneEntry("Added a dark theme; reverted later that day"));
    await log.refresh();
    expect(tidyCall).toHaveBeenCalledTimes(1);
    expect(tidyCall.mock.calls[0][0]).toMatch(/undone/);
    const e = mem.days.get(DAY)!.entries;
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ status: "reverted", title: "Added a dark theme; reverted later that day", from: at(9), to: at(15) });
  });

  it("makes a fix done on the laptop and finished on the desktop one entry, with both machines", async () => {
    const desk = machine("d1", "desktop");
    const lap = machine("l1", "laptop");
    session(lap, "s1", "login", user("u1", at(10), "Start fixing the login redirect"));
    session(desk, "s2", "login", user("u2", at(14), "Finish the login redirect fix"));
    const { log, mem, tidyCall } = setup([desk, lap], oneEntry("Fixed the login redirect"));
    await log.refresh();
    // One project across both machines: one call with both machines' notes.
    expect(tidyCall).toHaveBeenCalledTimes(1);
    const e = mem.days.get(DAY)!.entries;
    expect(e).toHaveLength(1);
    expect(e[0].machines).toEqual(["desktop", "laptop"]);
    expect(e[0].status).toBe("done");
  });

  it("keeps a session cut off mid-run as in progress", async () => {
    const desk = machine("d1", "desktop");
    session(desk, "s1", "search", user("u1", at(16), "Start the search page"));
    const { log, mem } = setup([desk], oneEntry("Working on the search page"));
    await log.refresh();
    expect(mem.days.get(DAY)!.entries[0].status).toBe("in_progress");
  });

  it("writes no entry with a path, backticks or a hash", async () => {
    const desk = machine("d1", "desktop");
    session(desk, "s1", "x", user("u1", at(9), "Fix the parser"));
    const { log, mem } = setup([desk], async (input) => ({
      entries: [
        {
          title: "Fixed `parse()` in src/parser/index.ts (commit 9be4f0c2)",
          detail: "See C:\\repos\\app\\notes.md",
          status: "done",
          from: "09:00",
          to: "09:00",
          notes: [...input.matchAll(/id ([0-9a-f]{16})/g)].map((m) => m[1]),
        },
      ],
    }));
    await log.refresh();
    for (const e of mem.days.get(DAY)!.entries) {
      for (const t of [e.title, e.detail ?? ""]) {
        expect(t).not.toMatch(/[`\\/]/);
        expect(looksLikeCode(t)).toBe(false);
      }
    }
  });

  it("leaves an edited entry alone", async () => {
    const desk = machine("d1", "desktop");
    session(desk, "s1", "x", user("u1", at(9), "Add the export"));
    const { log, mem, tidyCall } = setup([desk], oneEntry("Added the export"));
    await log.refresh();
    const id = mem.days.get(DAY)!.entries[0].id;
    await log.editEntry(DAY, id, { title: "Shipped the CSV export to the client" });
    session(desk, "s1", "x", user("u2", at(11), "Add a settings page"));
    await log.refresh();
    expect(tidyCall).toHaveBeenCalledTimes(2);
    expect(tidyCall.mock.calls[1][0]).toContain("<edited>");
    const e = mem.days.get(DAY)!.entries;
    expect(e.find((x) => x.id === id)).toMatchObject({ title: "Shipped the CSV export to the client", edited: true });
    expect(e.filter((x) => !x.edited)).toHaveLength(1);
  });
});

describe("after a split", () => {
  it("merges both sides' notes to the day a single main would have written", async () => {
    const lap = machine("l1", "laptop");
    session(lap, "s1", "x", user("u1", at(9), "Add the export"), user("u2", at(10), "Fix the totals"));
    // One main.
    const single = setup([lap], oneEntry("Added the export and fixed the totals"));
    await single.log.capture();
    const notes = single.mem.notes.get(DAY)!;
    // Two mains, each reading the laptop from the same offset, with notes worded
    // their own way; then each takes the other's in.
    const sideA = notes;
    const sideB = notes.map((n, i) => ({ ...n, id: `f${String(i).padStart(15, "0")}`, text: `${n.text}!`, run: "other" }));
    const ab = [...sideA, ...unionNotes(sideA, sideB)];
    const ba = [...sideB, ...unionNotes(sideB, sideA)];
    const pick = (ns: Note[]) => notesForTidy(ns).map((n) => n.id).sort();
    expect(pick(ab)).toEqual(pick(ba));
    // And what the tidy reads is one side's, whole.
    expect(pick(ab)).toHaveLength(notes.length);

    // Taken in through the log: the day is tidied again, from one side.
    const desk = machine("d1", "desktop");
    const merged = setup([desk], oneEntry("Added the export and fixed the totals"));
    expect(await merged.log.takeNotes(sideB)).toBe(sideB.length);
    expect(await merged.log.takeNotes(sideA)).toBe(sideA.length);
    expect(await merged.log.takeNotes(sideA)).toBe(0);
    await merged.log.tidy();
    await single.log.tidy();
    const strip = (d: DayEntries) => d.entries.map((e) => ({ ...e, id: "", notes: [] }));
    expect(strip(merged.mem.days.get(DAY)!)).toEqual(strip(single.mem.days.get(DAY)!));
  });
});

describe("entriesFrom", () => {
  it("gives each note to one entry and keeps ids stable", () => {
    const n = (id: string, h: number, machine = "desktop"): Note => ({
      id,
      day: DAY,
      at: at(h),
      text: id,
      kind: "done",
      machine,
      machineId: machine,
      project: "p",
      projectName: "P",
      sources: [id],
    });
    const notes = [n("a", 9), n("b", 10, "laptop")];
    const out: TidyOut = {
      entries: [
        { title: "One", detail: null, status: "done", from: "09:00", to: "10:00", notes: ["a", "b"] },
        { title: "Two", detail: null, status: "done", from: "10:00", to: "10:00", notes: ["b"] },
      ],
    };
    const e = entriesFrom(out, DAY, "p", "P", notes, []);
    expect(e.map((x) => [x.id, x.notes, x.machines])).toEqual([
      ["e-a", ["a", "b"], ["desktop", "laptop"]],
      [expect.stringMatching(/^e-/), [], []],
    ]);
  });
});

describe("a failed tidy", () => {
  it("is said in the run's report, not just dropped", async () => {
    const desk = machine("d1", "desktop");
    session(desk, "s1", "x", user("u1", at(9), "Add the export"));
    const { log } = setup([desk], async () => {
      throw new Error('400 "thinking.type.disabled" is not supported');
    });
    const r = await log.refresh();
    expect(r.tidied).toEqual([]);
    expect(r.problems).toEqual(['tidying Shop failed: 400 "thinking.type.disabled" is not supported']);
  });
});
