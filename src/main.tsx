import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import TornWindow, { readTornParams } from "./torn/TornWindow";
import VoiceOverlay from "./panels/Assistant/VoiceOverlay";
import DayLogWindow from "./daylog/DayLogWindow";
import { blockStrayDrops } from "./ipc/osDrop";
import { startHeartbeat } from "./ipc/heartbeat";
import "./theme/global.css";

// A torn-off panel window (step 4.2) loads this same bundle with a `?torn=…` query
// (see state/tearoff). Render the minimal torn-off app there instead of the full
// cockpit — it's a separate webview that just attaches to the live PTY.
const torn = readTornParams();

// A file from the OS dropped anywhere but a console would open in place of the app.
blockStrayDrops();

// The listening sign (`?overlay=voice`) is a page of its own too.
const overlay = new URLSearchParams(window.location.search).get("overlay") === "voice";
// So is the daily log's window (`?window=daylog`, improvement plan J2).
const daylog = new URLSearchParams(window.location.search).get("window") === "daylog";

// The backend reloads the cockpit page if it stops beating (renderer watchdog).
if (!overlay && !torn && !daylog) startHeartbeat();
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {overlay ? <VoiceOverlay /> : daylog ? <DayLogWindow /> : torn ? <TornWindow params={torn} /> : <App />}
  </React.StrictMode>,
);
