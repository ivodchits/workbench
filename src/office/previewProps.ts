// The furniture catalogue for the preview (office plan OD.3): every prop on a patch
// of office floor, animated where it moves, and every floor tile.

import { FLOORS, PROPS, floorTile, propFrame, type FloorKind, type Prop } from "./art/props";
import { cached, frameIn } from "./previewCanvas";

const SCALE = 3;
const PAD = 6;

/** Readable names for the catalogue. */
const LABELS: Partial<Record<keyof typeof PROPS, string>> = {
  windowWall: "Window",
  partitionSide: "Partition (side)",
  glassSide: "Glass wall (side)",
  glass: "Glass wall",
  monitorOff: "Monitor · off",
  monitorCode: "Monitor · working",
  monitorAlert: "Monitor · needs you",
  bossDesk: "Duck's desk",
  meetingTable: "Meeting table",
  serverRack: "Server rack",
  whiteboardStand: "Whiteboard on a stand",
  tallPlant: "Tall plant",
  coffeeMachine: "Coffee machine",
  waterCooler: "Water cooler",
  kitchenTable: "Kitchen table",
  tvOff: "TV · off",
  tvOn: "TV · playing",
  beanbagRed: "Beanbag",
  beanbagYellow: "Beanbag",
  dndTable: "D&D table",
};

const FLOOR_LABELS: Record<FloorKind, string> = {
  office: "Office tiles",
  demiurge: "Demiurge carpet",
  tinywizard: "TinyWizardRoyale carpet",
  boss: "Duck's carpet",
  wood: "Lounge wood",
  kitchen: "Kitchen",
  meeting: "Meeting room carpet",
};

function label(name: string): string {
  return LABELS[name as keyof typeof PROPS] ?? name.replace(/^./, (c) => c.toUpperCase());
}

interface Tile {
  name: string;
  prop: Prop;
  canvas: HTMLCanvasElement;
  shown: number;
}

const tiles: Tile[] = [];

function paintTile(tile: Tile, f: number): void {
  const { prop, canvas } = tile;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  for (let y = 0; y < canvas.height; y += 16) {
    for (let x = 0; x < canvas.width; x += 16) {
      const alt = (x + y) / 16 % 2 === 1;
      ctx.drawImage(cached(`floor/office/${alt}`, () => floorTile("office", alt)), x, y);
    }
  }
  ctx.drawImage(cached(`prop/${tile.name}/${f}`, () => propFrame(prop, f)), PAD, PAD);
}

export function buildProps(root: Element): void {
  const grid = document.createElement("div");
  grid.className = "props";
  for (const [name, prop] of Object.entries(PROPS) as [string, Prop][]) {
    const card = document.createElement("figure");
    card.className = "prop";
    const canvas = document.createElement("canvas");
    canvas.width = prop.w + PAD * 2;
    canvas.height = prop.h + PAD * 2;
    canvas.style.width = `${canvas.width * SCALE}px`;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", label(name));
    const caption = document.createElement("figcaption");
    caption.innerHTML = `<span>${label(name)}</span><small>${prop.w}×${prop.h}${prop.frames.length > 1 ? ` · ${prop.frames.length} frames` : ""}</small>`;
    card.append(canvas, caption);
    grid.append(card);
    const tile = { name, prop, canvas, shown: -1 };
    paintTile(tile, 0);
    tile.shown = 0;
    tiles.push(tile);
  }
  root.append(grid);

  const floors = document.createElement("div");
  floors.className = "floors";
  for (const kind of Object.keys(FLOORS) as FloorKind[]) {
    const card = document.createElement("figure");
    card.className = "prop";
    const canvas = document.createElement("canvas");
    canvas.width = 48;
    canvas.height = 32;
    canvas.style.width = `${48 * SCALE}px`;
    const ctx = canvas.getContext("2d")!;
    for (let y = 0; y < 32; y += 16) {
      for (let x = 0; x < 48; x += 16) ctx.drawImage(cached(`floor/${kind}/${(x + y) / 16 % 2 === 1}`, () => floorTile(kind, (x + y) / 16 % 2 === 1)), x, y);
    }
    const caption = document.createElement("figcaption");
    caption.innerHTML = `<span>${FLOOR_LABELS[kind]}</span><small>16×16 tile</small>`;
    card.append(canvas, caption);
    floors.append(card);
  }
  root.append(floors);
}

export function drawProps(ms: number): void {
  for (const tile of tiles) {
    if (tile.prop.frames.length < 2) continue;
    const f = frameIn(tile.prop.frames.map(() => tile.prop.ms ?? 1000), ms);
    if (f === tile.shown) continue;
    tile.shown = f;
    paintTile(tile, f);
  }
}
