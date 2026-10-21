// Typed access to Duck's screenshots (step V3, `src-tauri/src/voice/screen.rs`).

import { invoke } from "@tauri-apps/api/core";

export interface MonitorInfo {
  /** 1-based, left to right. */
  number: number;
  name: string;
  position: "left" | "middle" | "right" | "only";
  main: boolean;
  width: number;
  height: number;
}

export type ScreenTarget =
  | { kind: "activeWindow" }
  | { kind: "monitor"; number: number }
  | { kind: "window"; title: string }
  | { kind: "all" };

export interface Shot {
  label: string;
  pngBase64: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
}

export interface Capture {
  shots: Shot[];
  monitors: MonitorInfo[];
}

export const screenshot = (target: ScreenTarget): Promise<Capture> => invoke("assistant_screenshot", { target });
export const listMonitors = (): Promise<MonitorInfo[]> => invoke("assistant_monitors");
/** Write the last capture to `Pictures/Workbench`; the files written. */
export const saveScreenshot = (): Promise<string[]> => invoke("assistant_screenshot_save");
