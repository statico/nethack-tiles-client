import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { isReloadChord } from "./lib/keys";
import { reportFrontendError, sessionDisconnect } from "./lib/tauri";
import "./styles.css";

// Anything that escapes React entirely still needs to reach a log.
window.addEventListener("error", (e) =>
  reportFrontendError(`uncaught: ${e.message} (${e.filename}:${e.lineno})`),
);
window.addEventListener("unhandledrejection", (e) =>
  reportFrontendError(`unhandled rejection: ${e.reason}`),
);

// The webview reloads the page on F5 or Ctrl+R. A reload drops the game screen
// but not the connection behind it, so the keys are blocked. In the terminal,
// xterm has already sent the key to the game by the time it bubbles here.
window.addEventListener("keydown", (e) => {
  if (isReloadChord(e)) e.preventDefault();
});

const render = () =>
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );

// A fresh page knows of no connection. If the backend still holds one (the
// page was reloaded mid-game), every connect would fail with "already
// connected" and nothing on screen could disconnect it. Close it before the
// UI can try. The server saves the game when the connection drops.
Promise.resolve()
  .then(() => sessionDisconnect())
  .catch(() => {
    // No backend (a plain browser) or nothing to close.
  })
  .finally(render);
