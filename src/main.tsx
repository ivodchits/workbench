import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import TornWindow, { readTornParams } from "./torn/TornWindow";
import "./theme/global.css";

// A torn-off panel window (step 4.2) loads this same bundle with a `?torn=…` query
// (see state/tearoff). Render the minimal torn-off app there instead of the full
// cockpit — it's a separate webview that just attaches to the live PTY.
const torn = readTornParams();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{torn ? <TornWindow params={torn} /> : <App />}</React.StrictMode>,
);
