// Whiteboard Pictionary (office plan O5.4): what the office page asks of
// `/office/api/pictionary` and what comes back. Workbench's Rust core lets one call out
// at a time and hands it to the webview (`state/officePictionary.ts`), which asks the
// model: to guess what's on the board from a picture of it, or to pick a word and
// draw it as strokes.

/** The board Duck draws on, in its own units: the page scales them to the board. */
export const DRAW_W = 300;
export const DRAW_H = 200;

/** The marker colours, by name. */
export const MARKERS = ["black", "red", "blue", "green"] as const;
export type Marker = (typeof MARKERS)[number];

export type PictionaryRequest =
  /** What's on the board: a PNG (base64, no `data:` prefix), and what Duck guessed
   *  already this round, so it doesn't say them again. */
  | { kind: "guess"; png: string; guessed: string[] }
  /** A word to draw, not one of `avoid` (the latest rounds'). */
  | { kind: "draw"; avoid: string[] };

/** A stroke: a marker and the points it goes through, in `DRAW_W`×`DRAW_H` units. */
export interface DuckStroke {
  color: Marker;
  points: [number, number][];
}

export type PictionaryResult =
  /** `says`: a few words with it ("Hmm, a hat?"). */
  | { kind: "guess"; guess: string; says: string }
  /** `also`: other answers that count (a "bike" for a bicycle). */
  | { kind: "draw"; word: string; also: string[]; strokes: DuckStroke[] };

/** `busy`: another call is out; `error` may have spent one. */
export type PictionaryAnswer =
  | { status: "ok"; result: PictionaryResult }
  | { status: "busy" }
  | { status: "error"; message: string };

/** What the webview hands back (`office_pictionary_reply`). */
export interface PictionaryReply {
  result: PictionaryResult | null;
  error?: string;
}
