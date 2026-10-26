// The office art preview (office plan OD.2–OD.3): a sample corner of the office, the
// furniture catalogue, and the cast — every worker, animated, with animation, facing
// and zoom controls. For sign-off before any office code builds on the art.

import { ANIMS, FRAME_H, FRAME_W, frame, type Anim, type Dir } from "./art/characters";
import type { DuckAnim } from "./art/duck";
import { textOn } from "./art/palette";
import { floorTile } from "./art/props";
import { cached, frameIn } from "./previewCanvas";
import { DUCK_ROOM_H, DUCK_ROOM_W, drawDuckRoom } from "./previewDuck";
import { buildProps, drawProps } from "./previewProps";
import { SCENE_H, SCENE_W, drawScene } from "./previewScene";
import { ROSTER, TEAM_NAMES, type Team, type Worker } from "./roster";

const SHADOW = "rgba(30, 24, 40, 0.28)";

function sprite(worker: Worker, anim: Anim, dir: Dir, index: number): HTMLCanvasElement {
  return cached(`worker/${worker.id}/${anim}/${dir}/${index}`, () => frame(worker.look, anim, dir, index));
}

const frameAt = (anim: Anim, ms: number) => frameIn(ANIMS[anim].frames.map((f) => f.ms), ms);

function floor(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  for (let y = 0; y < h; y += 16) {
    for (let x = 0; x < w; x += 16) {
      const alt = (x + y) / 16 % 2 === 1;
      ctx.drawImage(cached(`floor/office/${alt}`, () => floorTile("office", alt)), x, y);
    }
  }
}

/** A worker standing with their feet at (x, y), with a soft shadow. */
function drawWorker(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement, x: number, y: number): void {
  ctx.fillStyle = SHADOW;
  ctx.beginPath();
  ctx.ellipse(x, y - 1, 6, 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.drawImage(img, Math.round(x - FRAME_W / 2), Math.round(y - FRAME_H));
}

// ── State ────────────────────────────────────────────────────────────────────

type Facing = Dir | "turn";

const state = {
  anim: "idle" as Anim,
  facing: "down" as Facing,
  zoom: 4,
  duck: "idle" as DuckAnim,
  playing: !matchMedia("(prefers-reduced-motion: reduce)").matches,
};

const TURN: Dir[] = ["down", "right", "up", "left"];

function facingAt(ms: number): Dir {
  if (state.facing !== "turn") return state.facing;
  return TURN[Math.floor(ms / 1400) % TURN.length];
}

// ── Scene: a corner of the office, at the largest whole-pixel scale that fits ──

const scene = document.querySelector<HTMLCanvasElement>("#scene")!;
scene.width = SCENE_W;
scene.height = SCENE_H;

const duckRoom = document.querySelector<HTMLCanvasElement>("#duck-room")!;
duckRoom.width = DUCK_ROOM_W;
duckRoom.height = DUCK_ROOM_H;

/** The largest whole-pixel scale that fits, so no pixel is drawn wider than another. */
function fit(canvas: HTMLCanvasElement, width: number, most = Infinity): void {
  const room = canvas.parentElement!.clientWidth - 20;
  canvas.style.width = `${width * Math.max(1, Math.min(most, Math.floor(room / width)))}px`;
}

function fitScene(): void {
  fit(scene, SCENE_W);
  fit(duckRoom, DUCK_ROOM_W, 4);
}

// ── Corridor: the cast walking across ───────────────────────────────────────

const CORRIDOR_SCALE = 3;
const corridor = document.querySelector<HTMLCanvasElement>("#corridor")!;
const walkers = ROSTER.map((worker, i) => ({
  worker,
  // Spread out, alternating directions, slightly different paces.
  offset: i * 61,
  speed: 18 + ((i * 7) % 11),
  dir: (i % 3 === 2 ? "left" : "right") as Dir,
  lane: i % 2,
}));

function drawCorridor(ms: number): void {
  const w = Math.max(160, Math.floor(corridor.clientWidth / CORRIDOR_SCALE));
  const h = 64;
  if (corridor.width !== w) {
    corridor.width = w;
    corridor.height = h;
  }
  const ctx = corridor.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  floor(ctx, w, h);
  const span = w + FRAME_W * 2;
  const ordered = [...walkers].sort((a, b) => a.lane - b.lane);
  for (const walker of ordered) {
    const travelled = (walker.offset + (ms / 1000) * walker.speed) % span;
    const x = walker.dir === "right" ? travelled - FRAME_W : w + FRAME_W - travelled;
    const y = 38 + walker.lane * 18;
    drawWorker(ctx, sprite(walker.worker, "walk", walker.dir, frameAt("walk", ms + walker.offset * 10)), x, y);
  }
}

// ── Cards ────────────────────────────────────────────────────────────────────

interface Card {
  worker: Worker;
  canvas: HTMLCanvasElement;
  shown: string;
}

const cards: Card[] = [];
const STAGE_W = 32;
const STAGE_H = 34;

function describe(worker: Worker): string {
  const l = worker.look;
  const bits = [`${l.hairStyle} hair`, l.topStyle];
  if (l.glasses) bits.push("glasses");
  if (l.beard) bits.push("beard");
  if (l.headphones) bits.push("headphones");
  return bits.join(" · ");
}

function buildCards(): void {
  const teams: Team[] = ["demiurge", "tinywizard", "open"];
  const root = document.querySelector("#teams")!;
  for (const team of teams) {
    const members = ROSTER.filter((w) => w.team === team);
    const section = document.createElement("section");
    section.className = `team team-${team}`;
    section.innerHTML = `<h3><span>${TEAM_NAMES[team]}</span><small>${members.length} desks</small></h3>`;
    const grid = document.createElement("div");
    grid.className = "grid";
    for (const worker of members) {
      const el = document.createElement("article");
      el.className = "card";
      const canvas = document.createElement("canvas");
      canvas.width = STAGE_W;
      canvas.height = STAGE_H;
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", `${worker.name}, ${describe(worker)}`);
      const tag = document.createElement("div");
      tag.className = "tag";
      tag.textContent = worker.name;
      tag.style.setProperty("--tag", worker.look.top.base);
      tag.style.setProperty("--tag-edge", worker.look.top.shade);
      tag.style.setProperty("--tag-text", textOn(worker.look.top.base));
      if (textOn(worker.look.top.base) !== "#ffffff") tag.classList.add("light");
      const text = document.createElement("div");
      text.className = "about";
      text.innerHTML = `<p>${worker.personality}</p><p class="look">${describe(worker)}</p>`;
      const stage = document.createElement("div");
      stage.className = "stage";
      stage.append(tag, canvas);
      el.append(stage, text);
      grid.append(el);
      cards.push({ worker, canvas, shown: "" });
    }
    section.append(grid);
    root.append(section);
  }
}

function drawCards(ms: number): void {
  const dir = facingAt(ms);
  for (const card of cards) {
    const index = frameAt(state.anim, ms + card.worker.id.length * 333);
    const key = `${state.anim}/${dir}/${index}/${state.zoom}`;
    if (key === card.shown) continue;
    card.shown = key;
    card.canvas.style.width = `${STAGE_W * state.zoom}px`;
    card.canvas.style.height = `${STAGE_H * state.zoom}px`;
    const ctx = card.canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    floor(ctx, STAGE_W, STAGE_H);
    drawWorker(ctx, sprite(card.worker, state.anim, dir, index), STAGE_W / 2, STAGE_H - 4);
  }
}

// ── Controls ─────────────────────────────────────────────────────────────────

function bindGroup(name: string, apply: (value: string) => void): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>(`[data-${name}]`);
  for (const button of buttons) {
    button.addEventListener("click", () => {
      for (const b of buttons) b.setAttribute("aria-pressed", String(b === button));
      apply(button.dataset[name]!);
      paint();
    });
  }
}

const playButton = document.querySelector<HTMLButtonElement>("#play")!;

function syncPlay(): void {
  playButton.textContent = state.playing ? "Pause" : "Play";
  playButton.setAttribute("aria-pressed", String(!state.playing));
}

// ── Loop ─────────────────────────────────────────────────────────────────────

let clock = 0;
let last = performance.now();

function paint(): void {
  drawScene(scene.getContext("2d")!, clock);
  drawDuckRoom(duckRoom.getContext("2d")!, clock, state.duck);
  drawProps(clock);
  drawCorridor(clock);
  drawCards(clock);
}

function tick(now: number): void {
  if (state.playing) clock += Math.min(now - last, 100);
  last = now;
  paint();
  requestAnimationFrame(tick);
}

buildProps(document.querySelector("#furniture")!);
buildCards();
bindGroup("anim", (v) => (state.anim = v as Anim));
bindGroup("facing", (v) => (state.facing = v as Facing));
bindGroup("zoom", (v) => (state.zoom = Number(v)));
bindGroup("duck", (v) => (state.duck = v as DuckAnim));
playButton.addEventListener("click", () => {
  state.playing = !state.playing;
  syncPlay();
});
addEventListener("resize", fitScene);
fitScene();
syncPlay();
paint();
requestAnimationFrame(tick);
