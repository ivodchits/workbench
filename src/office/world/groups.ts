// Things idle workers do together (office plan O2.2), on top of the idle planner: two or
// three at the water cooler chat, facing each other, in bubbles in turn; two at the
// kicker play a match to five, the ball running and the score over the table, and the
// winner cheers; two or more on the sofa get the console out, the TV on. Each starts by
// itself when enough people are there (`idle.ts` draws people to company), keeps them
// long enough to be worth it, and tells the activity log.
//
// A chat, at the cooler or over the console, plays a scene written for who's there and
// where (O4.2, `staff.writer`: chatter, O4.1), its lines one after another and into the
// log, then asks for one more if the chat goes on. Until one comes, or without one
// (chatter off, over budget, failed), it's canned lines, which the log leaves out.

import type { Anim, Dir } from "../art/characters";
import type { ChatSpot, Scene, SceneLine } from "../../remote/chatter";
import type { WorkerEntity, World } from "./entities";
import type { Staff } from "./sessions";

/** Writes a scene for these workers at this spot, carrying on from what the chat has
 *  said so far (`Mira: Tea?`); null when there's none. */
export type SceneWriter = (ids: string[], spot: ChatSpot, said: string[]) => Promise<Scene | null>;

/** What goes in the activity log. A `chat` is one entry per chat, by `key`: `text` is
 *  its head, and each scene line said (`line`) is added under it. */
export type GroupEvent = { kind: "fun"; text: string } | { kind: "chat"; key: string; text: string; line: string | null };

export const CHAT_LINES: readonly string[] = [
  "Coffee's better today.",
  "Did the build go green?",
  "Who broke main?",
  "Not me this time!",
  "Lunch at one?",
  "That PR is huge.",
  "Tabs or spaces?",
  "Ship it Friday?",
  "Never on a Friday.",
  "Duck seems busy.",
  "Have you tried the new model?",
  "It works on my machine.",
  "Standup ran long again.",
  "Who took my mug?",
  "Rubber duck it.",
  "Naming things is hard.",
  "I renamed it twice.",
  "Off by one again.",
  "The tests pass. Mostly.",
  "Is it a cache thing?",
  "It's always DNS.",
  "Weekend plans?",
  "Kicker after this?",
  "I'm one refactor away.",
  "Read the logs yet?",
  "Ha!",
  "No way.",
  "True.",
  "Same.",
  "Tell me about it.",
];

export const GAME_LINES: readonly string[] = ["gg", "One more!", "No!!", "Combo!", "Pause!", "Rematch.", "Boss fight!", "Lag!", "Nice.", "Watch this."];

/** First to this many goals wins. */
export const GOALS_TO_WIN = 5;
/** The winner cheers (and the loser sulks) this long after the last goal. */
export const CHEER_FOR = 4000;
/** A chat or a console session keeps those in it at least this long once it starts. */
export const CHAT_MIN = 90_000;
export const CONSOLE_MIN = 3 * 60_000;
/** A bubble stays up this long. */
export const SAY_FOR = 3200;
/** A scene's line stays up this long, and this much more a character, so a longer
 *  one can be read. */
export const LINE_FOR = 2400;
export const LINE_PER_CHAR = 70;
/** A chat waits for its scene this long before filling in with canned lines. */
export const SCENE_WAIT = 6000;
/** Scenes a chat asks for, at most. */
export const SCENES_PER_CHAT = 2;
/** Log lines kept for the page to take. */
const EVENTS_MAX = 20;

export interface KickerMatch {
  /** Worker ids, by side. */
  west: string;
  east: string;
  start: number;
  /** Each goal, in order, and who scored it. */
  goals: readonly { at: number; side: "west" | "east" }[];
  /** The last goal. */
  end: number;
  reported?: boolean;
}

/** A chat under way. */
export interface Chat {
  spot: ChatSpot;
  /** When the next line is due, and who said the last. */
  next: number;
  last: string | null;
  /** Scenes had so far; when the ask now out went out (null with none out); and
   *  whether the last ask got none, so the next canned line asks again. */
  asked: number;
  waiting: number | null;
  missed: boolean;
  /** The scene's lines still to say, and those said ("Mira: Tea?"). */
  lines: SceneLine[];
  said: string[];
  /** The log entry the scene's lines go under. */
  key: string;
}

export interface Games {
  kicker: KickerMatch | null;
  /** The chats under way, by spot: the sofa's is the console session's. */
  chats: Partial<Record<ChatSpot, Chat>>;
}

export const noGames = (): Games => ({ kicker: null, chats: {} });

/** How each spot's chat goes: its head in the log, its canned lines and the gap after
 *  one, and how long it keeps those in it once it starts. */
const SPOTS: Record<ChatSpot, { head: (names: string) => string; canned: readonly string[]; gap: readonly [number, number]; keeps: number }> = {
  cooler: { head: (n) => `${n} are chatting at the water cooler`, canned: CHAT_LINES, gap: [4000, 6500], keeps: CHAT_MIN },
  sofa: { head: (n) => `${n} got the console out`, canned: GAME_LINES, gap: [8000, 17_000], keeps: CONSOLE_MIN },
};

/** The score at `ms`: west, east. */
export function kickerScore(m: KickerMatch, ms: number): [number, number] {
  let w = 0;
  let e = 0;
  for (const g of m.goals) {
    if (g.at > ms) break;
    if (g.side === "west") w++;
    else e++;
  }
  return [w, e];
}

/** Where the ball is at `ms`, across the field (0 west goal – 1 east goal, 0 top – 1
 *  bottom): bouncing about between goals, then into the net. */
export function ballAt(m: KickerMatch, ms: number): { x: number; y: number } {
  const tri = (v: number) => 1 - Math.abs((((v % 2) + 2) % 2) - 1);
  let from = m.start;
  for (const g of m.goals) {
    if (ms < g.at) {
      const into = { x: g.side === "west" ? 1 : 0, y: 0.5 };
      const u = (ms - from) / 1000;
      const seed = from % 997;
      const play = { x: 0.1 + 0.8 * tri(u * 0.9 + seed / 97), y: 0.1 + 0.8 * tri(u * 1.3 + seed / 61) };
      // The last moment before a goal, it goes in.
      const shot = 600;
      if (g.at - ms > shot) return play;
      const t = 1 - (g.at - ms) / shot;
      const at = (g.at - shot - from) / 1000;
      const start = { x: 0.1 + 0.8 * tri(at * 0.9 + seed / 97), y: 0.1 + 0.8 * tri(at * 1.3 + seed / 61) };
      return { x: start.x + (into.x - start.x) * t, y: start.y + (into.y - start.y) * t };
    }
    from = g.at;
  }
  return { x: 0.5, y: 0.5 };
}

/** A match from `ms`: goals every few seconds, at random, until one side has five. */
export function newMatch(west: string, east: string, ms: number, random: () => number): KickerMatch {
  const goals: { at: number; side: "west" | "east" }[] = [];
  let t = ms + 2000;
  let w = 0;
  let e = 0;
  while (w < GOALS_TO_WIN && e < GOALS_TO_WIN) {
    t += 6000 + random() * 14_000;
    const side = random() < 0.5 ? "west" : "east";
    if (side === "west") w++;
    else e++;
    goals.push({ at: t, side });
  }
  return { west, east, start: ms, goals, end: t };
}

/** Workers there for `activity`: arrived, not walking. */
function present(world: World, staff: Staff, activity: string): WorkerEntity[] {
  return world.workers.filter((w) => {
    const s = staff.idle.get(w.worker.id);
    return s?.activity === activity && s.until !== null && !w.walk && !staff.jobs.has(w.worker.id);
  });
}

/** Workers on their way to `activity`. */
const coming = (world: World, staff: Staff, activity: string) =>
  world.workers.filter((w) => {
    const s = staff.idle.get(w.worker.id);
    return s?.activity === activity && s.until === null;
  });

const names = (ws: readonly WorkerEntity[]) => {
  const n = ws.map((w) => w.worker.name);
  return n.length > 1 ? `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}` : n[0];
};

/** Keeps those in a group there at least until `until`. */
function keep(staff: Staff, ws: readonly WorkerEntity[], until: number): void {
  for (const w of ws) {
    const s = staff.idle.get(w.worker.id)!;
    s.until = Math.max(s.until ?? 0, until);
  }
}

function say(staff: Staff, w: WorkerEntity, text: string, ms: number, lasts = SAY_FOR): void {
  w.bubble = { text, tone: "say" };
  staff.saying.set(w.worker.id, ms + lasts);
}

const chatHead = (chat: Chat, ws: readonly WorkerEntity[]) => SPOTS[chat.spot].head(names(ws));

/** How long a scene's line stays up. */
export const lineFor = (text: string) => LINE_FOR + LINE_PER_CHAR * text.length;

/** Each one in a group facing the rest: along whichever way the others are further. */
export function facings(ws: readonly { id: string; x: number; y: number }[]): Map<string, Dir> {
  const out = new Map<string, Dir>();
  for (const w of ws) {
    const others = ws.filter((o) => o.id !== w.id);
    if (!others.length) continue;
    const dx = others.reduce((s, o) => s + o.x, 0) / others.length - w.x;
    const dy = others.reduce((s, o) => s + o.y, 0) / others.length - w.y;
    out.set(w.id, Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down");
  }
  return out;
}

/** Asks for the chat's next scene; its lines join the chat if it's still on. */
function askScene(staff: Staff, chat: Chat, ws: readonly WorkerEntity[], ms: number): void {
  if (!staff.writer || chat.asked >= SCENES_PER_CHAT || chat.waiting !== null) return;
  chat.waiting = ms;
  chat.missed = false;
  void staff
    .writer(
      ws.map((w) => w.worker.id),
      chat.spot,
      [...chat.said],
    )
    .catch(() => null)
    .then((scene) => {
      chat.waiting = null;
      // The chat may be over, or a new one begun.
      if (scene && staff.games.chats[chat.spot] === chat) {
        chat.asked++;
        chat.lines.push(...scene.lines);
      }
      // None this time (the page hidden, chatter off or over budget, a failure): the
      // next canned line asks again. Only a call the client makes costs anything.
      if (!scene) chat.missed = true;
    });
}

/** One turn of a chat: the scene's next line by someone there, else
 *  a canned one (but not while a scene is on its way). True when someone spoke. */
function chatTurn(staff: Staff, chat: Chat, ws: readonly WorkerEntity[], ms: number): boolean {
  if (ms < chat.next) return false;
  const here = new Map(ws.map((w) => [w.worker.id, w]));
  // Lines by someone who's gone are skipped.
  while (chat.lines.length && !here.has(chat.lines[0].speaker)) chat.lines.shift();
  const line = chat.lines.shift();
  if (line) {
    const w = here.get(line.speaker)!;
    const lasts = lineFor(line.text);
    say(staff, w, line.text, ms, lasts);
    const said = `${w.worker.name}: ${line.text}`;
    chat.said.push(said);
    staff.events.push({ kind: "chat", key: chat.key, text: chatHead(chat, ws), line: said });
    chat.next = ms + lasts + 400 + staff.random() * 600;
    chat.last = w.worker.id;
    // The scene's over and they're still at it: ask for the next.
    if (!chat.lines.length) askScene(staff, chat, ws, ms);
    return true;
  }
  if (chat.waiting !== null && ms - chat.waiting < SCENE_WAIT) return false;
  const w = speaker(ws, chat.last, staff.random);
  const { canned, gap } = SPOTS[chat.spot];
  say(staff, w, pick(canned, staff.random), ms);
  chat.next = ms + gap[0] + staff.random() * (gap[1] - gap[0]);
  chat.last = w.worker.id;
  if (chat.missed) askScene(staff, chat, ws, ms);
  return true;
}

/** The next to speak: anyone but whoever spoke last. */
function speaker(ws: readonly WorkerEntity[], last: string | null, random: () => number): WorkerEntity {
  const others = ws.filter((w) => w.worker.id !== last);
  const from = others.length ? others : ws;
  return from[Math.floor(random() * from.length)] ?? from[0];
}

const pick = <T>(list: readonly T[], random: () => number): T => list[Math.floor(random() * list.length)] ?? list[0];

/** One sim step of the group activities; sets the poses they need (`staff.groupPose`),
 *  the TV and the kicker on `world`, and queues what's worth a line in the log. True
 *  when a bubble went up or came down. */
export function playGroups(world: World, staff: Staff, ms: number): boolean {
  let said = false;
  const g = staff.games;
  const poses = staff.groupPose;
  poses.clear();
  staff.groupFace.clear();
  const byId = new Map(world.workers.map((w) => [w.worker.id, w]));

  // Bubbles run out.
  for (const [id, until] of staff.saying) {
    if (ms < until) continue;
    staff.saying.delete(id);
    const w = byId.get(id);
    if (w?.bubble?.tone === "say") {
      w.bubble = null;
      said = true;
    }
  }

  // The water cooler's chat, standing face to face; the sofa's, over the console, eyes
  // on the TV.
  for (const spot of ["cooler", "sofa"] as const) {
    const ws = present(world, staff, spot);
    if (ws.length < 2) {
      delete g.chats[spot];
      continue;
    }
    let chat = g.chats[spot];
    if (!chat) {
      chat = g.chats[spot] = { spot, next: ms + 1500, last: null, asked: 0, waiting: null, missed: false, lines: [], said: [], key: `chat:${spot}:${ms}` };
      keep(staff, ws, ms + SPOTS[spot].keeps);
      staff.events.push({ kind: "chat", key: chat.key, text: chatHead(chat, ws), line: null });
      askScene(staff, chat, ws, ms);
    }
    if (spot === "sofa") for (const w of ws) poses.set(w.worker.id, "gamepad");
    else for (const [id, dir] of facings(ws.map((w) => ({ id: w.worker.id, x: w.x, y: w.y })))) staff.groupFace.set(id, dir);
    said = chatTurn(staff, chat, ws, ms) || said;
  }
  world.tv = g.chats.sofa !== undefined;

  // The kicker.
  const atTable = present(world, staff, "kicker");
  let m = g.kicker;
  const there = (id: string) => atTable.some((w) => w.worker.id === id);
  if (m && (!there(m.west) || !there(m.east))) m = g.kicker = null;
  if (!m && atTable.length >= 2) {
    const side = (w: WorkerEntity) => staff.idle.get(w.worker.id)!.place;
    const west = atTable.find((w) => side(w) === "kicker-w");
    const east = atTable.find((w) => side(w) === "kicker-e");
    if (west && east) {
      m = g.kicker = newMatch(west.worker.id, east.worker.id, ms, staff.random);
      keep(staff, [west, east], m.end + CHEER_FOR);
    }
  } else if (!m && atTable.length === 1 && coming(world, staff, "kicker").length) {
    // Someone's coming to play: wait for them.
    keep(staff, atTable, ms + 5000);
  }
  if (m) {
    if (ms < m.end) {
      poses.set(m.west, "foosball");
      poses.set(m.east, "foosball");
    } else if (ms < m.end + CHEER_FOR) {
      const [w, e] = kickerScore(m, m.end);
      const [won, lost] = w > e ? [m.west, m.east] : [m.east, m.west];
      poses.set(won, "cheer" satisfies Anim);
      poses.set(lost, "facepalm" satisfies Anim);
      if (!m.reported) {
        m.reported = true;
        staff.events.push({ kind: "fun", text: `${byId.get(won)!.worker.name} beat ${byId.get(lost)!.worker.name} ${Math.max(w, e)}:${Math.min(w, e)} at the kicker` });
      }
    } else m = g.kicker = null;
  }
  world.kicker = m;
  // Nobody reading them (the preview): keep only the latest.
  if (staff.events.length > EVENTS_MAX) staff.events.splice(0, staff.events.length - EVENTS_MAX);
  return said;
}
