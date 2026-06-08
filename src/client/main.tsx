import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

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
