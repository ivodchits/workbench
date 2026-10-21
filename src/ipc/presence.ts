// Are you at the PC? (step V5, `src-tauri/src/voice/presence.rs`), for Duck's
// announcements.

import { invoke } from "@tauri-apps/api/core";
import type { Presence } from "../assistant/announce";

export const getPresence = (): Promise<Presence> => invoke("assistant_presence");
