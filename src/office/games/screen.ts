// A picture a game shows on its prop in the office (office plan O5.3d): the Library's
// game on the TV, Pictionary's board on the meeting room's whiteboard (O5.4); nothing
// while none is.

export interface PropScreen {
  get(): CanvasImageSource | null;
  set(picture: CanvasImageSource | null): void;
  /** `f` is called whenever the picture comes or goes. */
  listen(f: () => void): void;
}

export function propScreen(): PropScreen {
  let live: CanvasImageSource | null = null;
  let changed: () => void = () => {};
  return {
    get: () => live,
    set(picture) {
      if (picture === live) return;
      live = picture;
      changed();
    },
    listen(f) {
      changed = f;
    },
  };
}

/** The meeting room's whiteboard: Pictionary's board while it's played (O5.4). */
export const boardScreen = propScreen();
