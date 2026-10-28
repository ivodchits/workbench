// The office page (office plans O0.1, O0.2, O1.1–O1.6): the office as large as fits
// beside the sidebar, on the loop in loop.ts, with the performance HUD, and the link to
// Workbench. Sessions drive the workers (liveOffice.ts). Hovering a worker shows who
// they are and what their session is doing; clicking one opens their session in the
// sidebar (panel.ts), clicking Duck opens a chat with Duck there (duckChat.ts, O3.1),
// dragging a free worker onto a free desk (or clicking a free desk) opens a form there
// to start a session at it (hireForm.ts, O3.2), and clicking the floor or Esc closes it.
// Clicking a `!` or `?` bubble opens its choice card right there instead (askCard.ts,
// O3.3), and leaves the sidebar alone. With the walk grid on
// (`G`) a click is the debug one instead: pick a worker, then send them walking. With
// nobody picked the sidebar shows the stats (stats.ts) and the room each project sits in.
// Clicking the TV or the kicker opens a game over the dimmed office (games/, O5.1); the
// office keeps stepping behind it but isn't drawn till it closes.

import { fitSize, sideLayout } from "./canvas";
import { startHud } from "./hud";
import { startLoop } from "./loop";
import { connect } from "./net";
import { tooltipLines } from "./describe";
import {
  DUCK_ID,
  OFFICE_H,
  OFFICE_W,
  askAt,
  askOf,
  clickOffice,
  drawOffice,
  deskOffer,
  duckChatTurn,
  duckDoing,
  freeDeskAt,
  gameAt,
  hire,
  hired,
  nameOf,
  officeLog,
  officeSnapshot,
  roomOf,
  setRoom,
  startOffice,
  stepOffice,
  whoAt,
  workedToday,
  chatterRequest,
  freeWorkers,
  setSceneWriter,
  workerAt,
  workerFree,
} from "./liveOffice";
import { createAskCard } from "./askCard";
import { createDuckChat } from "./duckChat";
import { createHireForm, type HireTarget } from "./hireForm";
import { ROSTER } from "./roster";
import type { Cost } from "./net";
import { createPanel } from "./panel";
import { showLink, showRooms } from "./sidebar";
import { showStats } from "./stats";
import { createChatter } from "./chatter";
import { createChatterPanel } from "./chatterPanel";
import { testGame, type GameDef } from "./games/game";
import { kickerGame } from "./games/kicker";
import { createGameOverlay } from "./games/overlay";
import type { GameProp } from "./games/props";

const canvas = document.querySelector<HTMLCanvasElement>("#office")!;
const stage = document.querySelector<HTMLElement>("#stage")!;
const hud = document.querySelector<HTMLElement>("#hud")!;
const tip = document.querySelector<HTMLElement>("#tip")!;
const side = document.querySelector<HTMLElement>("#side")!;
const shown = canvas.getContext("2d")!;

/** The office at 1:1; each frame is copied up onto the page's canvas. */
const scene = document.createElement("canvas");
scene.width = OFFICE_W;
scene.height = OFFICE_H;
const ctx = scene.getContext("2d")!;

/** Copies the scene up by whole pixels; the browser takes it the rest of the way. */
function present(): void {
  shown.imageSmoothingEnabled = false;
  shown.drawImage(scene, 0, 0, canvas.width, canvas.height);
}

const view = {
  overlay: false,
  tags: false,
  hover: null as string | null,
  selected: null as string | null,
  desk: null as number | null,
  asking: null as string | null,
  paused: false,
  pausedAt: 0,
};
/** `view.selected` while the new-session form is open. */
const HIRE_ID = "hire";
/** The desk the form is for, the free desk under the pointer, and the one a dragged
 *  worker is over. */
let hireTarget: HireTarget | null = null;
let hoverDesk: number | null = null;
let dropDesk: number | null = null;

/** What each game prop opens: the kicker its own (O5.2), the TV the test game till O5.3. */
const GAMES: Record<GameProp, GameDef> = {
  tv: testGame("The TV", "#7fd1ff"),
  kicker: kickerGame,
};
const games = createGameOverlay(document.querySelector<HTMLElement>("#game")!, () => loop.invalidate());
const GAME_NAMES: Record<GameProp, string> = { tv: "The TV", kicker: "The kicker" };

const loop = startLoop({
  step: () => {
    const changed = !view.paused && stepOffice(performance.now());
    return changed && !games.open;
  },
  draw: (ms) => {
    // Still behind a game: it has the frames.
    if (games.open) return Infinity;
    const next = drawOffice(ctx, view.paused ? view.pausedAt : ms, view);
    present();
    placeAsk();
    return view.paused ? Infinity : next;
  },
});
const linkEl = document.querySelector<HTMLElement>("#link")!;
const statsEl = document.querySelector<HTMLElement>("#stats")!;
const roomsEl = document.querySelector<HTMLElement>("#rooms")!;
let snapshot: Parameters<typeof officeSnapshot>[0] | null = null;
const pickRoom = (id: string, team: Parameters<typeof setRoom>[1]) => {
  setRoom(id, team);
  loop.invalidate();
};
const link = connect((state) => {
  showLink(linkEl, state);
  if (state.kind !== "live") {
    snapshot = null;
    return statsEl.replaceChildren();
  }
  snapshot = state.snapshot;
  officeSnapshot(state.snapshot);
  showRooms(roomsEl, state.snapshot.projects, roomOf, pickRoom);
  hireForm.update(state.snapshot);
  if (ask.id) ask.update(whoAt(ask.id));
  showSelected();
  showTip();
});
const panel = createPanel(document.querySelector<HTMLElement>("#session")!, link, () => select(null));
const hireForm = createHireForm(document.querySelector<HTMLElement>("#hire")!, link, {
  close: () => select(null),
  // Whoever was offered may have been given something else meanwhile.
  sent: (requestId, t) => hire(requestId, t.worker && workerFree(t.worker.id) ? t.worker.id : deskOffer(t.desk).worker, t.desk),
  seated: hired,
  started: (who) => select(who),
  roomOf,
});
const ask = createAskCard(document.querySelector<HTMLElement>("#ask")!, link, {
  close: () => openAsk(null),
  open: (id) => {
    openAsk(null);
    select(id);
  },
});
const duckChat = createDuckChat(document.querySelector<HTMLElement>("#duck")!, link, () => select(null), (turn) => {
  duckChatTurn(turn);
  loop.invalidate();
});

/** The session of whoever is picked, the chat with Duck, or the new-session form, in
 *  the sidebar. A pick made for the debug click (with the walk grid on) isn't one. */
function showSelected(): void {
  const duck = view.selected === DUCK_ID && !view.overlay;
  const hiring = view.selected === HIRE_ID && !view.overlay ? hireTarget : null;
  const who = view.selected && !view.overlay && !duck && !hiring ? whoAt(view.selected) : null;
  side.classList.toggle("open", !!who || duck || !!hiring);
  panel.show(who);
  duckChat.show(duck);
  hireForm.show(hiring);
  outline();
  if (!who && !duck && !hiring) showStatsNow();
}

/** The desk outlined: the one a worker is dragged over, the form's, or the free one
 *  under the pointer. */
function outline(): void {
  view.desk = dropDesk ?? (view.selected === HIRE_ID && hireTarget ? hireTarget.desk : hoverDesk);
}

/** Opens the new-session form for `desk`, with `worker` or whoever the desk suggests. */
function openHire(desk: number, worker: string | null): void {
  const offer = deskOffer(desk);
  const id = worker ?? offer.worker;
  const w = ROSTER.find((r) => r.id === id);
  hireTarget = { desk, worker: w ? { id: w.id, name: w.name } : null, room: offer.room };
  select(HIRE_ID);
}

/** Opens the choice card by `id`'s bubble, or closes it for null. */
function openAsk(id: string | null): void {
  ask.show(id, id ? whoAt(id) : null);
  view.asking = ask.id;
  placeAsk();
  showTip();
  loop.invalidate();
}

/** Keeps the choice card by its bubble, which moves with whoever is asking. */
function placeAsk(): void {
  const a = ask.id ? askOf(ask.id) : null;
  if (!a) return;
  const rect = canvas.getBoundingClientRect();
  const box = stage.getBoundingClientRect();
  const sx = rect.width / OFFICE_W;
  const sy = rect.height / OFFICE_H;
  ask.place(rect.left - box.left + (a.x + a.w / 2) * sx, rect.top - box.top + a.y * sy, rect.top - box.top + (a.y + a.h) * sy, box.width, box.height);
}

function select(id: string | null): void {
  view.selected = id;
  showSelected();
  loop.invalidate();
}
startOffice(link, () => loop.invalidate());

const chatter = createChatter(link, () => chatterPanel.update());
const chatterPanel = createChatterPanel(
  document.querySelector<HTMLElement>("#chatter")!,
  chatter,
  () => {
    const free = freeWorkers();
    if (free.length < 2) return null;
    const ids = free.sort(() => Math.random() - 0.5).slice(0, 2 + Math.floor(Math.random() * 2));
    return { ids, spot: Math.random() < 0.5 ? "cooler" : "sofa" };
  },
  (ids, spot) => chatter.scene(chatterRequest(ids, spot), true),
);
chatterPanel.update();
void chatter.refresh();
// The chats at the cooler and on the sofa play scenes when chatter has one (O4.2).
setSceneWriter((ids, spot, said) => chatter.scene({ ...chatterRequest(ids, spot, 6), said }));

/** How often Workbench's cost is asked, while the HUD or the stats show it; its CPU is
 *  the average since the last ask. */
const COST_EVERY_MS = 3000;
let cost: Cost | null = null;
startHud(hud, loop, () => cost);

/** The stats, while nobody is picked. */
function showStatsNow(): void {
  if (!snapshot || side.classList.contains("open")) return;
  showStats(statsEl, { snapshot, cost, log: officeLog(), workedToday: workedToday(), nameOf });
}
setInterval(() => {
  const statsShown = !!snapshot && !side.classList.contains("open");
  if (document.hidden || (hud.hidden && !statsShown)) return;
  void link.cost().then((c) => {
    cost = c;
    showStatsNow();
  });
}, COST_EVERY_MS);

/** Space round the office in the stage, each side. */
const PAD = 8;
/** The sidebar is never narrower (or, under the office, shorter) than this. */
const SIDE_MIN = 280;

/** Sizes the sidebar so the office, as large as the window allows, fills the rest:
 *  beside it on a landscape screen, under it on a portrait one. The same in every mode. */
function layOut(): void {
  const { below, size } = sideLayout(innerWidth, innerHeight, OFFICE_W, OFFICE_H, PAD, SIDE_MIN);
  document.body.classList.toggle("below", below);
  document.body.style.setProperty("--side", `${size}px`);
}
layOut();
addEventListener("resize", layOut);

/** Fills the stage. At a whole-number scale every office pixel is a block of device
 *  pixels; between those, the canvas holds the next whole scale up and the browser
 *  shrinks it smoothly, which stays sharp where nearest-neighbour would leave some
 *  pixels a device pixel wider than others. */
function fit(): void {
  const dpr = devicePixelRatio || 1;
  const { scale, backing } = fitSize(stage.clientWidth - 2 * PAD, stage.clientHeight - 2 * PAD, dpr, OFFICE_W, OFFICE_H);
  canvas.style.width = `${(OFFICE_W * scale) / dpr}px`;
  canvas.style.height = `${(OFFICE_H * scale) / dpr}px`;
  canvas.style.imageRendering = backing === scale ? "pixelated" : "auto";
  if (canvas.width !== OFFICE_W * backing) {
    canvas.width = OFFICE_W * backing;
    canvas.height = OFFICE_H * backing;
    present();
  }
}

new ResizeObserver(fit).observe(stage);
// A zoom changes the device pixel ratio without resizing the stage in device pixels.
const watchRatio = () => matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener("change", () => (fit(), watchRatio()), { once: true });
watchRatio();

addEventListener("keydown", (e) => {
  // The game has the keys (and Esc).
  if (games.open) return;
  if (e.key === "Escape" && ask.id) {
    openAsk(null);
    return;
  }
  if (e.key === "Escape" && view.selected) {
    select(null);
    return;
  }
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
  if (e.ctrlKey || e.metaKey || e.altKey || typing) return;
  const key = e.key.toLowerCase();
  if (key === "g") {
    view.overlay = !view.overlay;
    select(null);
  }
  else if (key === "n") view.tags = !view.tags;
  else if (key === "p") {
    view.paused = !view.paused;
    view.pausedAt = performance.now();
  } else if (key === "h") hud.hidden = !hud.hidden;
  else return;
  loop.invalidate();
});

/** Where a pointer is, in office pixels. */
function sceneAt(e: MouseEvent): [number, number] {
  const rect = canvas.getBoundingClientRect();
  return [((e.clientX - rect.left) * OFFICE_W) / rect.width, ((e.clientY - rect.top) * OFFICE_H) / rect.height];
}

/** Where the pointer last was over the office, in page pixels; null when it's off it. */
let pointer: { x: number; y: number } | null = null;

/** The tooltip for whoever is hovered, by the pointer. */
function showTip(): void {
  const duck = view.hover === DUCK_ID;
  const who = view.hover && pointer && !view.overlay && !duck && !drag?.moved && view.hover !== ask.id ? whoAt(view.hover) : null;
  const desk = !view.hover && !drag && hoverDesk !== null;
  const game = !view.hover && !drag ? hoverGame : null;
  tip.hidden = !((who || duck || desk || game) && pointer && !view.overlay);
  if (tip.hidden || !pointer) return;
  const free = who && !who.instance && who.worker && workerFree(who.worker.id);
  const hint = free ? "drag onto a free desk: a new session" : hoverAsk ? "click the bubble to answer here" : null;
  const lines = who
    ? [...tooltipLines(who, performance.now()), ...(hint ? [hint] : [])]
    : duck
      ? ["Duck", `${duckDoing()} · click to talk`]
      : game
        ? [GAME_NAMES[game], "click to play"]
        : ["A free desk", "click to start a session here"];
  tip.replaceChildren(
    ...lines.map((text, n) => {
      const line = document.createElement("div");
      if (n === 0) line.className = "who";
      line.textContent = text;
      return line;
    }),
  );
  const box = stage.getBoundingClientRect();
  const x = Math.min(pointer.x - box.left + 14, box.width - tip.offsetWidth - 8);
  const y = pointer.y - box.top + 18 + tip.offsetHeight > box.height - 8 ? pointer.y - box.top - tip.offsetHeight - 10 : pointer.y - box.top + 18;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
// The "for how long" moves on.
setInterval(() => !tip.hidden && showTip(), 1000);

/** The pointer is on a bubble asking for you; on a prop that opens a game. */
let hoverAsk = false;
let hoverGame: GameProp | null = null;

/** Hovering a worker (or their bubble) shows their name tag and the tooltip; a free
 *  desk is outlined. */
function hoverAt(e: PointerEvent | null): void {
  pointer = e && { x: e.clientX, y: e.clientY };
  const bubble = e && !view.overlay ? askAt(...sceneAt(e)) : null;
  hoverAsk = !!bubble;
  const id = bubble?.id ?? (e ? workerAt(...sceneAt(e)) : null);
  const desk = e && !id && !view.overlay ? freeDeskAt(...sceneAt(e)) : null;
  const game = e && !id && desk === null && !view.overlay ? gameAt(...sceneAt(e)) : null;
  canvas.style.cursor = id || desk !== null || game || (view.overlay && view.selected) ? "pointer" : "";
  const moved = id !== view.hover || desk !== hoverDesk;
  hoverGame = game;
  view.hover = id;
  hoverDesk = desk;
  outline();
  showTip();
  if (moved) loop.invalidate();
}

/** A free worker held down, and whether they've been dragged yet. */
let drag: { id: string; x: number; y: number; moved: boolean } | null = null;
/** A drag just ended: the click it makes isn't one. */
let dropped = false;
/** Further than this (page pixels) and a press is a drag. */
const DRAG_PX = 4;

canvas.addEventListener("pointerdown", (e) => {
  if (view.paused || view.overlay || e.button !== 0) return;
  const id = workerAt(...sceneAt(e));
  if (!id || !workerFree(id)) return;
  drag = { id, x: e.clientX, y: e.clientY, moved: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag) return hoverAt(e);
  if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_PX) return;
  drag.moved = true;
  pointer = { x: e.clientX, y: e.clientY };
  dropDesk = freeDeskAt(...sceneAt(e));
  view.hover = drag.id;
  canvas.style.cursor = dropDesk !== null ? "copy" : "grabbing";
  outline();
  showTip();
  loop.invalidate();
});
const endDrag = (e: PointerEvent, drop: boolean) => {
  const d = drag;
  drag = null;
  if (!d?.moved) return;
  dropped = true;
  const desk = drop ? freeDeskAt(...sceneAt(e)) : null;
  dropDesk = null;
  if (desk !== null) openHire(desk, d.id);
  hoverAt(e);
};
canvas.addEventListener("pointerup", (e) => endDrag(e, true));
canvas.addEventListener("pointercancel", (e) => endDrag(e, false));
canvas.addEventListener("pointerleave", () => !drag && hoverAt(null));
canvas.addEventListener("click", (e) => {
  if (dropped) {
    dropped = false;
    return;
  }
  if (view.paused) return;
  // Any click closes the choice card; one on a bubble opens it there.
  const bubble = view.overlay ? null : askAt(...sceneAt(e));
  if (bubble || ask.id) openAsk(bubble?.id ?? null);
  if (bubble) return;
  if (view.overlay) {
    view.selected = clickOffice(view.selected, ...sceneAt(e), performance.now());
    loop.invalidate();
    return;
  }
  // A worker (or a contractor's desk) opens their session, Duck a chat, a free desk the
  // new-session form, the TV or the kicker a game; anywhere else closes it.
  const id = workerAt(...sceneAt(e));
  const desk = id ? null : freeDeskAt(...sceneAt(e));
  const game = id || desk !== null ? null : gameAt(...sceneAt(e));
  if (game) {
    hoverAt(null);
    games.show(GAMES[game]);
  } else if (desk !== null) openHire(desk, null);
  else select(id);
});
