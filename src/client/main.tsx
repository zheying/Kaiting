import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./room/styles.css";
import "./room/capsule-player.css";
import "./room/now-playing.css";
import "./room/shell.css";
import "./room/artists.css";
import "./room/home.css";
import "./room/catalog.css";
import "./room/login.css";
import "./room/states.css";
import "./room/accounts.css";

if (window.location.search.startsWith("?v=")) {
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.hash}`);
}

window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    window.location.reload();
  }
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
