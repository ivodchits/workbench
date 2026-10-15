import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import TornWindow, { readTornParams } from "./torn/TornWindow";
import { blockStrayDrops } from "./ipc/osDrop";
import "./theme/global.css";

// A torn-off panel window (step 4.2) loads this same bundle with a `?torn=…` query
// (see state/tearoff). Render the minimal torn-off app there instead of the full
// cockpit — it's a separate webview that just attaches to the live PTY.
const torn = readTornParams();

// A file from the OS dropped anywhere but a console would open in place of the app.
blockStrayDrops();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{torn ? <TornWindow params={torn} /> : <App />}</React.StrictMode>,
);
