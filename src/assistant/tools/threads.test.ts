import { describe, expect, it } from "vitest";

import type { ThreadRow } from "../../ipc/assistant";
import { fakePort, toolCtx } from "../fakePort.test-util";
import type { TaskManager } from "../tasks";
import { deleteThread, findThread, goToThread, listThreads } from "./threads";

const row = (id: string, title: string, updated = Date.now()): ThreadRow => ({ id, title, mode: "chat", created: 1, updated });

function ctx() {
  const c = toolCtx(fakePort());
  c.rows = [row("t", "Release plan"), row("a", "Auth research"), row("b", "Backend auth fix"), row("d", "Demiurge")];
  return c;
}

describe("findThread", () => {
  it("takes an id, an exact title, or a title only one thread has part of", () => {
    const c = ctx();
    expect(findThread(c.threads, "t", "d").id).toBe("d");
    expect(findThread(c.threads, "t", "demiurge").id).toBe("d");
    expect(findThread(c.threads, "t", "research").id).toBe("a");
  });

  it("lists the candidates when several fit, or none does", () => {
    const c = ctx();
    expect(() => findThread(c.threads, "t", "auth")).toThrow(/several threads fit "auth".*Auth research.*Backend auth fix.*Ask the user/);
    expect(() => findThread(c.threads, "t", "tiny wizard")).toThrow(/no thread is called "tiny wizard"/);
  });

  it("goes back to the last thread the user was in", () => {
    const c = ctx();
    expect(() => findThread(c.threads, "t", "back")).toThrow(/no thread to go back to/);
    c.trailIds = ["t", "gone", "a"];
    expect(findThread(c.threads, "t", "back").id).toBe("a");
  });
});

describe("list_threads", () => {
  it("shows each thread with its tasks, where the user is, and where they were", async () => {
    const c = ctx();
    c.trailIds = ["d"];
    c.replies.a = "The auth research found three options.";
    c.tasks = {
      list: () => [{ threadId: "a", title: "Compare auth libraries", state: "done" }],
    } as unknown as TaskManager;
    const out = (await listThreads.run({}, c)) as { threads: Record<string, unknown>[] };
    expect(out.threads[0]).toMatchObject({ id: "t", title: "Release plan", here: true, active: "just now" });
    expect(out.threads[1]).toMatchObject({
      id: "a",
      lastReply: "The auth research found three options.",
      tasks: ["Compare auth libraries (done)"],
    });
    expect(out.threads[3]).toMatchObject({ id: "d", before: 1 });
  });
});

describe("go_to_thread", () => {
  it("asks the engine to move there, with the user's words", async () => {
    const c = ctx();
    const out = await goToThread.run({ thread: "Demiurge", words: "give me the details" }, c);
    expect(c.moved).toEqual([{ to: "d", words: "give me the details" }]);
    expect(out).toMatchObject({ thread: "d", title: "Demiurge", moving: true });
  });

  it("refuses the thread the user is in", () => {
    const c = ctx();
    expect(() => goToThread.run({ thread: "Release plan" }, c)).toThrow(/already in that thread/);
    expect(c.moved).toEqual([]);
  });
});

describe("delete_thread", () => {
  it("names every thread on the card", () => {
    expect(deleteThread.describe!({ threads: [{ id: "a", title: "Auth research" }] }, fakePort(), undefined)).toBe(
      'Delete the Duck thread "Auth research" and its messages, for good',
    );
    expect(
      deleteThread.describe!(
        {
          threads: [
            { id: "a", title: "Auth research" },
            { id: "d", title: "" },
          ],
        },
        fakePort(),
        undefined,
      ),
    ).toBe('Delete 2 Duck threads and their messages, for good: "Auth research", "untitled"');
  });

  it("deletes what the card named, and keeps this thread, a mismatched title and one a task reports to", async () => {
    const c = ctx();
    c.tasks = { list: () => [{ threadId: "b", title: "Fix auth", state: "running" }] } as unknown as TaskManager;
    const out = await deleteThread.run(
      {
        threads: [
          { id: "d", title: "demiurge" },
          { id: "t", title: "Release plan" },
          { id: "a", title: "Something else" },
          { id: "b", title: "Backend auth fix" },
          { id: "x", title: "Gone" },
        ],
      },
      c,
    );
    expect(out).toEqual({
      deleted: ["Demiurge"],
      notDeleted: [
        { title: "Release plan", why: "it's this thread" },
        { title: "Something else", why: 'its title is "Auth research", not "Something else"' },
        { title: "Backend auth fix", why: "a worker task still running reports to it" },
        { title: "Gone", why: "no such thread (list_threads again)" },
      ],
    });
    expect(c.rows.map((t) => t.id)).toEqual(["t", "a", "b"]);
  });
});
