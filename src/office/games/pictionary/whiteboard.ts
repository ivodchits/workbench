// Whiteboard Pictionary (office plan O5.4) as the overlay's game: the rules
// (`pictionary.ts`) and the picture (`draw.ts`), Duck asked through Workbench, and the
// board shown on the meeting room's whiteboard while it's open.

import type { Game, GameDef } from "../game";
import { boardScreen } from "../screen";
import { BOARD_H, BOARD_W, boardPng } from "./board";
import { drawPict } from "./draw";
import { backPict, keyPict, PIC_H, PIC_W, pictState, pointerPict, stepPict, type Phase, type PictDeps } from "./pictionary";

const HELP: Record<Phase, string> = {
  menu: "click a game, or up/down and Z/Enter · Esc: close",
  you: "draw with the mouse, a pen or a finger; Duck guesses when you pause · 1-4: marker · Ctrl+Z: undo · Esc: to the menu",
  picking: "Duck is picking a word · Esc: to the menu",
  duck: "type your guess, Enter to say it · Esc: to the menu",
  over: "Z/Enter or AGAIN: another round · Esc or MENU: to the menu",
};

/** The game, asking Duck with `ask`. */
export function pictionaryGame(ask: PictDeps["ask"]): GameDef {
  return {
    title: "Whiteboard Pictionary",
    help: HELP.menu,
    make(): Game {
      const s = pictState();
      const deps: PictDeps = { ask, picture: boardPng, random: Math.random };
      const board = document.createElement("canvas");
      board.width = BOARD_W;
      board.height = BOARD_H;
      boardScreen.set(board);
      return {
        w: PIC_W,
        h: PIC_H,
        get help() {
          return HELP[s.phase];
        },
        get cursor() {
          return s.phase === "you" ? "crosshair" : "";
        },
        step: (pad) => stepPict(s, pad, deps),
        draw: (ctx) => drawPict(ctx, s, board),
        back: () => backPict(s),
        key: (key, ctrl) => keyPict(s, key, ctrl, deps),
        pointer: (kind, x, y) => pointerPict(s, kind, x, y, deps),
        stop() {
          s.round++;
          if (boardScreen.get() === board) boardScreen.set(null);
        },
      };
    },
  };
}
