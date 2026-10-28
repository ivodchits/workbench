// The picture on the office's TV (office plan O5.3d): the Library's game while one
// runs, drawn small into the TV's screen; nothing otherwise.

let live: CanvasImageSource | null = null;
let changed: () => void = () => {};

export const tvScreen = {
  get: (): CanvasImageSource | null => live,
  set(picture: CanvasImageSource | null): void {
    if (picture === live) return;
    live = picture;
    changed();
  },
  /** `f` is called whenever the picture comes or goes. */
  listen(f: () => void): void {
    changed = f;
  },
};
