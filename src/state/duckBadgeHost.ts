// Duck's notification badge, host side: a numeric overlay on the taskbar icon
// (a red disc, "9+" past nine, drawn on a canvas) and, from Rust (`badge.rs`), a red
// dot, no number, on the tray icon. Both clear at zero.

import { invoke } from "@tauri-apps/api/core";
import { Image } from "@tauri-apps/api/image";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getDuckState, subscribeDuck } from "../panels/Assistant/duckState";
import { badgeLabel, duckBadgeCount } from "./duckBadge";

const SIZE = 32;

function drawOverlay(label: string): Uint8Array | null {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#e53935";
  ctx.beginPath();
  ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `bold ${label.length > 1 ? 17 : 22}px sans-serif`;
  ctx.fillText(label, SIZE / 2, SIZE / 2 + 1);
  return new Uint8Array(ctx.getImageData(0, 0, SIZE, SIZE).data.buffer);
}

let last = -1;

/** Apply `count` to the taskbar overlay and the tray dot, if it changed. */
export async function applyDuckBadge(count: number): Promise<void> {
  const shown = badgeLabel(count);
  const key = shown === null ? 0 : count;
  if (key === last) return;
  last = key;
  await Promise.allSettled([
    (async () => {
      const rgba = shown === null ? null : drawOverlay(shown);
      const icon = rgba ? await Image.new(rgba, SIZE, SIZE) : undefined;
      await getCurrentWindow().setOverlayIcon(icon);
    })(),
    invoke("set_tray_dot", { count: key }),
  ]);
}

/** Follow Duck's unread count from the desktop's Duck store. App-lifetime. */
export function startDuckBadge(): void {
  const sync = () => void applyDuckBadge(duckBadgeCount(getDuckState())).catch(() => {});
  subscribeDuck(sync);
  sync();
}
